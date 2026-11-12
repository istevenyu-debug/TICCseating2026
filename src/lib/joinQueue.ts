/**
 * 揪團贈票：年代名單、志工回報、劃位序、自動輪號劃位、送年代名單。
 *
 * - 年代名單（訂單編號、張數、狀態）先上傳；志工送出時當下核對，不符的擋下，所以劃位序一經取得就是確定的。
 * - 團練場合計每跨過 perSeat（預設 10）張，取得下一個劃位序（全場流水號）。
 * - 劃位：一次只開放一個團練場（連續的劃位序一起選）。輪到後 turnMin 分鐘內沒打開頁面＝叫不到：
 *   第 1 次延後 pushBack 號、第 2 次排到最後、第 3 次暫停排隊（負責人按「我回來了」重新排到最後）。
 *   打開後有 pickMin 分鐘選位。劃位時段外、暫停時不開始新的一輪。
 * - 選好的座位直接標為已售出（沒有訂單），紀錄在 join_slot；後台下載名單送年代出紙本招待票。
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { rowKey, seatLabel } from './layout';
import { normalizePhone } from './validation';
import { USAGE_GIFT, clean, ev0, getJoinSettings, joinRegState, joinUsages, mailHead, pickUrl, rateLimit, reportUrl, type JoinSettings } from './join';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Slot = typeof t.joinSlot.$inferSelect;
type Reg = typeof t.joinReg.$inferSelect;

/** 訂單編號：去空白、全形轉半形、英文大寫；去掉每張票的「-1、-2」尾碼（年代票號 ER2611120000109-1 → 訂單 ER2611120000109） */
export const normOrderNo = (s: string) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s　]/g, '').toUpperCase()
  .replace(/^(.{6,})-\d{1,3}$/, '$1');

/* ---------- 年代名單 ---------- */

export const eraInput = z.array(z.object({
  orderNo: z.string().max(60),
  qty: z.number().int().min(0).max(1000),
  status: z.enum(['sold', 'refunded']),
  soldAt: z.string().datetime({ offset: true }).nullish(),
  otherQty: z.number().int().min(0).max(1000).optional(),
  otherNote: z.string().max(200).optional(),
})).min(1, '名單是空的').max(50000);

/** 不計入的狀態（紅字，需要修正）。pending 待核對不是錯誤 */
export const BAD_STATUS = new Set(['mismatch', 'refunded', 'ambiguous', 'outside', 'early', 'notfound']);
export const REPORT_STATUS: Record<string, string> = {
  pending: '待核對', ok: '已核對', mismatch: '張數不符', refunded: '已退票', ambiguous: '需補完整編號',
  outside: '非銀區', early: '回報早於購買', notfound: '找不到訂單',
};

type EraRec = { orderNo: string; qty: number; status: string; soldAt: Date | null; otherQty?: number; otherNote?: string };
export type MatchStatus = 'pending' | 'ok' | 'mismatch' | 'refunded' | 'ambiguous' | 'outside' | 'early' | 'notfound';
export type Match = { status: MatchStatus; orderNo: string | null; eraQty: number | null; cands: number; note: string; buyDate?: string | null };

/** 台北時間 M/D HH:mm */
const tpeMdHm = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return `${+g('month')}/${+g('day')} ${g('hour')}:${g('minute')}`;
};

/**
 * 依年代名單判定一筆回報（已知是哪一筆訂單時）：
 * pending 名單上還沒有 / refunded 已退票 / outside 整筆都不是銀區 / ok 銀區張數相符 / mismatch 張數不符
 */
export function judge(e: EraRec | undefined | null, qty: number): { status: MatchStatus; eraQty: number | null; note: string } {
  if (!e) return { status: 'pending', eraQty: null, note: '' };
  const other = e.otherQty ?? 0, on = e.otherNote || `其他 ${other} 張`;
  if (e.status !== 'sold') return { status: 'refunded', eraQty: e.qty, note: '此訂單已退票，不計贈票' };
  if (e.qty === 0 && other > 0) return { status: 'outside', eraQty: 0, note: `非銀區（${on}），不計贈票` };
  if (e.qty === qty) return { status: 'ok', eraQty: e.qty, note: other ? `${on} 不計贈票` : '' };
  if (other && qty === e.qty + other) return { status: 'mismatch', eraQty: e.qty, note: `這筆訂單銀區只有 ${e.qty} 張（${on} 不計贈票）。請刪除後改報 ${e.qty} 張` };
  return { status: 'mismatch', eraQty: e.qty, note: `年代記錄 ${e.qty} 張${other ? `（另有 ${on} 不計）` : ''}。請刪除後用正確張數重新回報` };
}

/** 志工可只輸入訂單編號「-」前面的最後 4 碼（純數字 4 碼以上＝後幾碼；有英文字母＝完整編號） */
export const isSuffixKey = (k: string) => /^\d{4,}$/.test(k);
/** 售出時間要在回報之前（給 5 分鐘誤差：年代只到分鐘） */
const SOLD_GRACE = 5 * 60 * 1000;

/**
 * 依志工輸入找年代訂單。完整編號：直接對。後幾碼：在「回報前已售出、還沒被別人對走、購買日期相同」的訂單裡找結尾相同的。
 *  - 銀區張數相同的只有一筆 → 已核對（那筆已退 → 已退票）；好幾筆 → 需補完整編號
 *  - 銀區＋非銀區合計相同的只有一筆 → 非銀區（整筆）或張數不符（混買，說明銀區幾張）
 *  - 只有一筆後幾碼相同 → 張數不符（不認領）；好幾筆 → 需補完整編號
 *  - 都沒有：購買日期選錯但別天剛好一筆相符 → 已核對並更正日期；年代記錄在回報之後才售出 → 回報早於購買；否則待核對
 */
export function matchKey(key: string, qty: number, at: Date, era: Map<string, EraRec>, claimed: Set<string>, buyDate: string | null = null): Match {
  if (!isSuffixKey(key)) { const e = era.get(key); const j = judge(e, qty); return { ...j, orderNo: key, cands: e ? 1 : 0 }; }
  const limit = at.getTime() + SOLD_GRACE;
  const list = (bd: string | null, timely: boolean) => [...era.values()].filter((e) => e.orderNo.endsWith(key) && !claimed.has(e.orderNo)
    && (!timely || !e.soldAt || e.soldAt.getTime() <= limit) && (!bd || [null, bd].includes(orderDate(e))));
  const tot = (e: EraRec) => e.qty + (e.otherQty ?? 0);
  const pick = (cands: EraRec[]): Match | null => {
    const same = cands.filter((e) => e.qty === qty);
    const sold = same.filter((e) => e.status === 'sold');
    if (sold.length === 1) return { ...judge(sold[0], qty), orderNo: sold[0].orderNo, cands: cands.length };
    if (sold.length > 1) return { status: 'ambiguous', orderNo: null, eraQty: null, cands: cands.length, note: '' };
    if (same.length === 1) return { ...judge(same[0], qty), orderNo: same[0].orderNo, cands: cands.length };
    const whole = cands.filter((e) => e.status === 'sold' && (e.otherQty ?? 0) > 0 && tot(e) === qty);
    if (whole.length === 1) { const j = judge(whole[0], qty); return { ...j, orderNo: j.status === 'outside' ? whole[0].orderNo : null, cands: cands.length }; }
    if (whole.length > 1) return { status: 'ambiguous', orderNo: null, eraQty: null, cands: cands.length, note: '' };
    if (cands.length === 1) { const j = judge(cands[0], qty); return { ...j, orderNo: j.status === 'outside' ? cands[0].orderNo : null, cands: 1 }; }
    if (cands.length > 1) return { status: 'ambiguous', orderNo: null, eraQty: null, cands: cands.length, note: '' };
    return null;
  };
  const m = pick(list(buyDate, true));
  if (m) return m;
  // 日期選錯：名單已涵蓋回報的那一天（有比回報更晚售出的訂單）卻找不到，別天又剛好只有一筆相符 → 更正日期
  if (buyDate && [...era.values()].some((e) => orderDate(e) === buyDate && e.soldAt && e.soldAt.getTime() > limit)) {
    const other = list(null, true).filter((e) => e.status === 'sold' && e.qty === qty && orderDate(e) !== buyDate);
    if (other.length === 1) {
      const d = orderDate(other[0]);
      return { ...judge(other[0], qty), orderNo: other[0].orderNo, cands: 1, buyDate: d, note: `購買日期已自動更正為 ${ymdLabel(d).trim()}` };
    }
  }
  const late = list(buyDate, false).filter((e) => e.soldAt && e.soldAt.getTime() > limit && (e.qty === qty || tot(e) === qty));
  if (late.length) {
    return { status: 'early', orderNo: null, eraQty: late[0].qty, cands: late.length,
      note: `年代記錄這筆訂單 ${tpeMdHm(late[0].soldAt!)} 才售出，晚於回報時間 ${tpeMdHm(at)}。請刪除後重新回報` };
  }
  return { status: 'pending', orderNo: null, eraQty: null, cands: 0, note: '' };
}

/** 台北日期 YYMMDD */
export const tpeYmd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).slice(2).replace(/-/g, '');
/** 訂單的購買日期 YYMMDD：訂單編號 ER+YYMMDD+流水號；看不出來就用售出時間；都沒有回傳 null（不限制） */
export function orderDate(e: { orderNo: string; soldAt: Date | null }) {
  const m = e.orderNo.match(/^[A-Z]{1,4}(\d{6})\d{4,}$/);
  if (m) return m[1];
  return e.soldAt ? tpeYmd(e.soldAt) : null;
}
const ymdLabel = (bd: string | null) => (bd ? `${+bd.slice(2, 4)}/${+bd.slice(4, 6)} ` : '');

async function eraMap(db: Db | Tx, eventId: number) {
  return new Map((await db.select().from(t.joinEra).where(eq(t.joinEra.eventId, eventId))).map((e) => [e.orderNo, e as EraRec]));
}

/** 上傳年代名單：同一訂單編號以新的為準（張數、已售／已退、非銀區張數），然後重新核對所有回報，有新問題的寄信給負責人 */
export async function uploadEra(db: Db, actor: string, raw: unknown, now = new Date(), base = '') {
  const p = eraInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '名單格式不正確');
  const ev = await ev0(db);
  const map = new Map<string, { qty: number; status: 'sold' | 'refunded'; soldAt: Date | null; otherQty: number; otherNote: string }>();
  for (const r of p.data) {
    const no = normOrderNo(r.orderNo);
    if (no) map.set(no, { qty: r.qty, status: r.status, soldAt: r.soldAt ? new Date(r.soldAt) : null, otherQty: r.otherQty ?? 0, otherNote: clean(r.otherNote ?? '').slice(0, 200) });
  }
  if (!map.size) throw new BookingError('INVALID', '名單裡沒有訂單編號');
  const nos = [...map.keys()];
  const have = new Map<string, typeof t.joinEra.$inferSelect>();
  for (let i = 0; i < nos.length; i += 1000) {
    for (const e of await db.select().from(t.joinEra).where(and(eq(t.joinEra.eventId, ev.id), inArray(t.joinEra.orderNo, nos.slice(i, i + 1000))))) have.set(e.orderNo, e);
  }
  let added = 0, changed = 0;
  const rows = nos.map((orderNo) => ({ eventId: ev.id, orderNo, ...map.get(orderNo)!, updatedAt: now }));
  for (const r of rows) { const h = have.get(r.orderNo); if (!h) added++; else if (h.qty !== r.qty || h.status !== r.status || h.otherQty !== r.otherQty) changed++; }
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(t.joinEra).values(rows.slice(i, i + 500)).onConflictDoUpdate({
      target: [t.joinEra.eventId, t.joinEra.orderNo],
      set: { qty: sql`excluded.qty`, status: sql`excluded.status`, soldAt: sql`coalesce(excluded.sold_at, ${t.joinEra.soldAt})`, otherQty: sql`excluded.other_qty`, otherNote: sql`excluded.other_note`, updatedAt: sql`excluded.updated_at` },
    });
  }
  const refunded = rows.filter((r) => r.status === 'refunded').length;
  const outside = rows.filter((r) => r.status === 'sold' && r.qty === 0 && r.otherQty > 0).length;
  const check = await recheckReports(db, ev.id, now, true, base);
  await db.insert(t.auditLog).values({ actor, action: 'join_era_upload', target: `event:${ev.id}`, detail: JSON.stringify({ rows: rows.length, added, changed, refunded, outside, ...check }) });
  return { rows: rows.length, added, changed, refunded, outside, ...check };
}

/** 一筆回報顯示用的名稱：完整編號或「11/12 後 4 碼 0109」 */
const repLabel = (r: { key: string; orderNo: string | null; buyDate: string | null }) =>
  (isSuffixKey(r.key) && !r.orderNo ? `${ymdLabel(r.buyDate)}後 ${r.key.length} 碼 ${r.key}` : r.orderNo ?? r.key);

/**
 * 先收後核：用目前的年代名單重新核對所有回報。
 * 已對到訂單的照那筆核對；還沒對到的（只輸入後幾碼）依回報先後重新找。
 * 還是待核對的：名單上同一天已有比回報時間更晚售出的訂單（名單已涵蓋那時候）卻找不到 → 找不到訂單。
 * notify：有新問題（紅字）的群，每群寄一封信給負責人，列出要修正的訂單。
 */
export async function recheckReports(db: Db, eventId: number, now = new Date(), notify = false, base = '') {
  const era = await eraMap(db, eventId);
  const cover = new Map<string, number>(); // 購買日期 → 名單上最晚的售出時間
  for (const e of era.values()) { const d = orderDate(e); if (d && e.soldAt) cover.set(d, Math.max(cover.get(d) ?? 0, e.soldAt.getTime())); }
  const reps = await db.select().from(t.joinReport).where(eq(t.joinReport.eventId, eventId)).orderBy(asc(t.joinReport.createdAt), asc(t.joinReport.id));
  const claimed = new Set(reps.filter((r) => r.orderNo).map((r) => r.orderNo!));
  const n = { verified: 0, pending: 0, mismatch: 0, refundedReports: 0, ambiguous: 0, outsideReports: 0, early: 0, notfound: 0, dateFixed: 0, newlyVerified: 0, newIssues: 0, mailed: 0 };
  const issues = new Map<number, string[]>();
  for (const r of reps) {
    let m: Match;
    if (r.orderNo) { const e = era.get(r.orderNo); m = { ...judge(e, r.qty), orderNo: r.orderNo, cands: e ? 1 : 0 }; }
    else {
      m = matchKey(r.key, r.qty, r.createdAt, era, claimed, r.buyDate);
      if (m.orderNo) claimed.add(m.orderNo);
    }
    if (m.status === 'pending') {
      const d = isSuffixKey(r.key) ? r.buyDate : orderDate({ orderNo: r.orderNo ?? r.key, soldAt: null });
      const c = d ? cover.get(d) : undefined;
      if (c && c > r.createdAt.getTime() + SOLD_GRACE) {
        m = { ...m, status: 'notfound', note: `年代名單已有 ${tpeMdHm(new Date(c))} 售出的訂單，仍找不到這筆。請確認訂單編號${isSuffixKey(r.key) ? '後 4 碼' : ''}、購買日期與張數，打錯請刪除後重新回報` };
      }
    }
    const k = m.status === 'ok' ? 'verified' : m.status === 'refunded' ? 'refundedReports' : m.status === 'outside' ? 'outsideReports' : m.status;
    n[k as keyof typeof n]++;
    const buyDate = m.buyDate !== undefined ? m.buyDate : r.buyDate;
    if (m.buyDate && m.buyDate !== r.buyDate) n.dateFixed++;
    if (m.status !== r.status || m.eraQty !== r.eraQty || m.orderNo !== r.orderNo || m.note !== r.note || buyDate !== r.buyDate) {
      if (m.status === 'ok' && r.status !== 'ok') n.newlyVerified++;
      if (BAD_STATUS.has(m.status) && (m.status !== r.status || m.note !== r.note)) {
        n.newIssues++;
        const why = m.status === 'ambiguous' ? '同一天有好幾筆訂單後幾碼相同，請在這一筆輸入完整訂單編號，按「補上」' : m.note;
        issues.set(r.regId, [...(issues.get(r.regId) ?? []), `・${repLabel(r)}（${r.qty} 張，填寫人 ${r.reporter || '?'}）：${REPORT_STATUS[m.status]}——${why.replace(/。/g, '；').replace(/；$/, '')}`]);
      }
      await db.update(t.joinReport).set({ status: m.status, eraQty: m.eraQty, orderNo: m.orderNo, note: m.note, buyDate, checkedAt: now }).where(eq(t.joinReport.id, r.id));
    }
  }
  if (notify && issues.size) {
    const ev = await ev0(db);
    const s = await getJoinSettings(db);
    const link = base ? ` ${base}/join ` : '揪團回報連結';
    for (const [regId, items] of issues) {
      const [reg] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, regId));
      if (!reg || reg.status !== 'approved' || !reg.email) continue;
      await mailHead(db, reg, 'join_issue', `【${ev.name}】${reg.headName} 您好，年代名單更新後，${reg.venueText || '貴群'}有 ${items.length} 筆回報需要修正，修正前不計入贈票：\n${items.join('\n')}\n`
        + `請轉告填寫的志工：用當初送出的那支手機打開${link}→ 繼續 → 在「已回報的訂單」紅字那一筆修正（刪除後重新回報，或補上完整編號）。回報截止後就不能修改。有疑義請洽${s.contact}`);
      n.mailed++;
    }
  }
  return n;
}

/* ---------- 合計與劃位序 ---------- */

/** 團練場合計：全部回報、已核對、待核對、不計入；已鎖定的劃位序 */
async function totalsOf(db: Db | Tx, regId: number) {
  const reps = await db.select({ qty: t.joinReport.qty, status: t.joinReport.status }).from(t.joinReport).where(eq(t.joinReport.regId, regId));
  const sum = (st?: string) => reps.filter((x) => !st || x.status === st).reduce((a, x) => a + x.qty, 0);
  const slots = await db.select().from(t.joinSlot).where(and(eq(t.joinSlot.regId, regId), ne(t.joinSlot.status, 'void'))).orderBy(asc(t.joinSlot.no));
  return { orders: reps.length, tickets: sum(), verified: sum('ok'), pending: sum('pending'), bad: reps.filter((x) => BAD_STATUS.has(x.status)).length, slots };
}

export async function isLocked(db: Db | Tx, eventId: number) {
  const [x] = await db.select({ id: t.joinSlot.id }).from(t.joinSlot).where(eq(t.joinSlot.eventId, eventId)).limit(1);
  return !!x;
}

/**
 * 預計劃位序：只算已核對的張數，依「回報時間」排。
 * 每個團練場的已核對張數累計每跨過 perSeat，就在那一筆回報的時間取得一個；全場依時間先後編號。
 */
export async function provisionalSlots(db: Db | Tx, eventId: number, perSeat: number) {
  const approved = new Set((await db.select({ id: t.joinReg.id }).from(t.joinReg).where(and(eq(t.joinReg.eventId, eventId), eq(t.joinReg.status, 'approved')))).map((r) => r.id));
  const reps = await db.select().from(t.joinReport).where(and(eq(t.joinReport.eventId, eventId), eq(t.joinReport.status, 'ok'))).orderBy(asc(t.joinReport.createdAt), asc(t.joinReport.id));
  const sum = new Map<number, number>();
  const out: { regId: number; at: Date; no: number }[] = [];
  for (const r of reps) {
    if (!approved.has(r.regId)) continue;
    const before = sum.get(r.regId) ?? 0, after = before + r.qty;
    sum.set(r.regId, after);
    for (let k = Math.floor(before / perSeat) + 1; k <= Math.floor(after / perSeat); k++) out.push({ regId: r.regId, at: r.createdAt, no: out.length + 1 });
  }
  return out;
}

/** 某團練場的劃位序：鎖定後是正式的，鎖定前是預計的 */
async function numbersOf(db: Db | Tx, eventId: number, regId: number, perSeat: number) {
  const locked = await isLocked(db, eventId);
  const nos = locked ? (await totalsOf(db, regId)).slots.map((x) => x.no) : (await provisionalSlots(db, eventId, perSeat)).filter((x) => x.regId === regId).map((x) => x.no);
  return { locked, nos };
}

/** 鎖定劃位序：關閉回報，把預計劃位序寫成正式的（待核對的不計入）。之後才寄劃位連結 */
export async function lockSlots(db: Db, actor: string, now = new Date()) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  return db.transaction(async (tx) => {
    if (await isLocked(tx, ev.id)) throw new BookingError('INVALID', '劃位序已經鎖定了。');
    const prov = await provisionalSlots(tx, ev.id, s.perSeat);
    if (!prov.length) throw new BookingError('INVALID', '還沒有任何劃位序（已核對的張數不夠）。');
    for (const x of prov) await tx.insert(t.joinSlot).values({ eventId: ev.id, regId: x.regId, no: x.no, pos: x.no, earnedAt: x.at });
    await tx.insert(t.appSetting).values({ key: 'join.reportOpen', value: '0' }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: '0' } });
    const [pend] = await tx.select({ n: sql<number>`count(*)::int` }).from(t.joinReport).where(and(eq(t.joinReport.eventId, ev.id), ne(t.joinReport.status, 'ok')));
    await tx.insert(t.auditLog).values({ actor, action: 'join_lock', target: `event:${ev.id}`, detail: JSON.stringify({ slots: prov.length, notCounted: pend.n, at: now.toISOString() }) });
    return { slots: prov.length, venues: new Set(prov.map((x) => x.regId)).size, notCounted: pend.n };
  });
}

/** 解除鎖定：只有還沒開始劃位時可以（例如要再補一次年代名單） */
export async function unlockSlots(db: Db, actor: string) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  return db.transaction(async (tx) => {
    const slots = await tx.select().from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id));
    if (!slots.length) throw new BookingError('INVALID', '劃位序還沒鎖定。');
    if (s.pickOpen || slots.some((x) => x.status !== 'wait' || x.misses > 0)) throw new BookingError('INVALID', '已經開始劃位，不能解除鎖定。');
    await tx.delete(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_unlock', target: `event:${ev.id}`, detail: String(slots.length) });
    return { removed: slots.length };
  });
}

/* ---------- 志工回報 ---------- */

async function regByReport(db: Db, code: string) {
  const [r] = await db.select().from(t.joinReg).where(eq(t.joinReg.reportCode, code));
  if (!r || r.status !== 'approved') throw new BookingError('NOT_FOUND', '連結無效，請向負責人確認。');
  return r;
}
async function venueName(db: Db | Tx, r: Reg) {
  if (!r.venueId) return r.venueText;
  const [v] = await db.select({ name: t.joinVenue.name }).from(t.joinVenue).where(eq(t.joinVenue.id, r.venueId));
  return v?.name ?? '';
}

/** 回報頁：團練場、合計（已核對／待核對）、劃位序（預計或正式）、已回報的訂單與狀態 */
export async function reportPage(db: Db, code: string) {
  const r = await regByReport(db, code);
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  const tot = await totalsOf(db, r.id);
  const num = await numbersOf(db, ev.id, r.id, s.perSeat);
  const list = await db.select().from(t.joinReport).where(eq(t.joinReport.regId, r.id)).orderBy(asc(t.joinReport.id));
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, venue: await venueName(db, r), headName: r.headName,
    open: s.reportOpen && !num.locked, locked: num.locked, perSeat: s.perSeat, contact: s.contact,
    orders: tot.orders, verified: tot.verified, pending: tot.pending, bad: tot.bad, slots: num.nos, next: s.perSeat - (tot.verified % s.perSeat),
    today: tpeYmd(new Date()),
    list: list.map((x) => ({ id: x.id, key: x.key, buyDate: x.buyDate, orderNo: x.orderNo, qty: x.qty, reporter: x.reporter, at: x.createdAt.toISOString(), status: x.status, eraQty: x.eraQty, note: x.note })),
  };
}

export const reportInput = z.object({
  reporter: z.string().transform(clean).pipe(z.string().min(1, '請先輸入您的名字').max(20, '名字最多 20 字')),
  buyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '購買日期格式不正確').optional(),
  rows: z.array(z.object({ orderNo: z.string().max(60).default(''), qty: z.union([z.number(), z.string()]).default('') })).min(1).max(50, '一次最多 50 筆'),
});

/**
 * 送出回報（先收後核）：名單上已有的當下核對（張數不符、已退票擋下）；名單上還沒有的先收下為「待核對」。
 * 一定擋：空白、張數不對、同一次重複、任何團練場已回報過。
 */
export async function submitReport(db: Db, code: string, raw: unknown, ip = '', now = new Date(), base = '', device = '') {
  const p = reportInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const reg = await regByReport(db, code);
  const s = await getJoinSettings(db);
  if (!s.reportOpen || await isLocked(db, reg.eventId)) throw new BookingError('SALE_CLOSED', '回報目前沒有開放。');
  // 共用連結：很多人同一個群、同一個網路位址，額度放寬；每支手機另外限制（joinGroup）
  rateLimit(`rep:${code}`, now.getTime(), 600);
  rateLimit(`repip:${ip}`, now.getTime(), 300);
  const rows = p.data.rows.map((x) => ({ orderNo: normOrderNo(String(x.orderNo)), qtyRaw: String(x.qty).trim() })).filter((x) => x.orderNo || x.qtyRaw);
  if (!rows.length) throw new BookingError('INVALID', '請輸入訂單編號與張數');
  // 購買日期：預設今天；可以改成之前的日期（晚報），不能是未來、不能超過 60 天前
  const bd = p.data.buyDate ? p.data.buyDate.slice(2).replace(/-/g, '') : null;
  if (bd && (bd > tpeYmd(now) || bd < tpeYmd(new Date(now.getTime() - 60 * 86400000)))) throw new BookingError('INVALID', '購買日期不正確（不能是未來的日期）');
  const era = await eraMap(db, reg.eventId);
  const all = await db.select().from(t.joinReport).where(eq(t.joinReport.eventId, reg.eventId));
  const claimed = new Map(all.filter((r) => r.orderNo).map((r) => [r.orderNo!, r]));
  const mine = all.filter((r) => r.regId === reg.id);
  const seen = new Set<string>();
  const ok: { key: string; buyDate: string | null; orderNo: string | null; qty: number; status: string; eraQty: number | null; note: string }[] = [];
  const bad: { orderNo: string; qty: string; reason: string }[] = [];
  for (const x of rows) {
    const qty = Number(x.qtyRaw);
    const k = x.orderNo;
    let reason = !k ? '請輸入訂單編號（後 4 碼即可）'
      : !/^\d+$/.test(x.qtyRaw) || qty < 1 || qty > 100 ? '張數請填 1 以上的數字'
        : !/^[0-9A-Z_/-]{2,40}$/.test(k) ? '訂單編號只能有英文字母、數字'
          : /^\d{1,3}$/.test(k) ? '請輸入「-」前面最後 4 個數字（或完整訂單編號）'
            : seen.has(`${k}|${qty}`) ? '這次重複輸入了' : '';
    let m: Match | null = null;
    if (!reason && !isSuffixKey(k)) {
      const d = claimed.get(k);
      if (d) reason = d.regId === reg.id ? '本團練場已回報過' : `此訂單已由其他團練場回報，有疑義請洽${s.contact}`;
    }
    if (!reason && isSuffixKey(k) && mine.some((r) => r.qty === qty && (r.key === k ? (r.buyDate ?? bd) === bd : (r.orderNo ?? '').endsWith(k) && (!bd || !r.orderNo || [null, bd].includes(orderDate({ orderNo: r.orderNo, soldAt: null })))))) {
      reason = `本團練場已回報過 ${ymdLabel(bd)}${k}（${qty} 張）；若是另一筆訂單，請輸入完整訂單編號`;
    }
    if (!reason) {
      m = matchKey(k, qty, now, era, new Set(claimed.keys()), isSuffixKey(k) ? bd : null);
      if (m.status === 'refunded') reason = '此訂單已退票';
      else if (m.status === 'outside') reason = m.note;
      else if (m.status === 'mismatch') reason = m.note.includes('銀區只有') ? m.note.replace('請刪除後改報', '請把張數改成')
        : isSuffixKey(k) ? `年代記錄後 ${k.length} 碼 ${k} 的訂單是 ${m.eraQty} 張。請確認張數；若不是這筆，請輸入完整訂單編號` : `張數不符（年代記錄為 ${m.eraQty} 張）`;
      else if (m.status === 'ambiguous') reason = `${bd ? '同一天' : ''}有好幾筆訂單後 ${k.length} 碼都是 ${k}，請輸入完整訂單編號`;
    }
    if (k) seen.add(`${k}|${qty}`);
    if (reason || !m) { bad.push({ orderNo: k, qty: x.qtyRaw, reason }); continue; }
    ok.push({ key: k, buyDate: isSuffixKey(k) ? (m.buyDate ?? bd) : null, orderNo: m.orderNo, qty, status: m.status, eraQty: m.eraQty, note: m.note });
    if (m.orderNo) claimed.set(m.orderNo, { regId: reg.id } as typeof all[number]);
  }
  if (ok.length) {
    await db.insert(t.joinReport).values(ok.map((x) => ({ eventId: reg.eventId, regId: reg.id, key: x.key, buyDate: x.buyDate, orderNo: x.orderNo, qty: x.qty, reporter: p.data.reporter, device: device.slice(0, 64),
      status: x.status, eraQty: x.eraQty, note: x.note, checkedAt: x.status === 'ok' ? now : null, createdAt: now })));
  }
  const tot = await totalsOf(db, reg.id);
  const num = await numbersOf(db, reg.eventId, reg.id, s.perSeat);
  // 每筆回報不再寄信給負責人（Gmail 每天約 500 封上限，留給劃位通知）；負責人看回報看板
  if (ok.length) {
    const okN = ok.filter((x) => x.status === 'ok').length;
    await db.insert(t.auditLog).values({ actor: `志工:${p.data.reporter}`, action: 'join_report', target: `join_reg:${reg.id}`, detail: JSON.stringify({ ok: ok.length, verified: okN, bad: bad.length }) });
  }
  return { accepted: ok.map((x) => ({ orderNo: x.orderNo ?? x.key, qty: x.qty, status: x.status, note: x.note })), rejected: bad, orders: tot.orders, verified: tot.verified, pending: tot.pending, slots: num.nos, next: s.perSeat - (tot.verified % s.perSeat) };
}

async function ownOpen(db: Db, code: string) {
  const reg = await regByReport(db, code);
  const s = await getJoinSettings(db);
  if (!s.reportOpen || await isLocked(db, reg.eventId)) throw new BookingError('SALE_CLOSED', '回報已經截止，不能再修改。有疑義請洽' + s.contact);
  return { reg, s };
}

/** 志工刪除自己團練場的一筆回報（打錯時）。只在回報開放、還沒鎖定時 */
export async function deleteOwnReport(db: Db, code: string, id: number, who = '') {
  const { reg } = await ownOpen(db, code);
  const [r] = await db.delete(t.joinReport).where(and(eq(t.joinReport.regId, reg.id), eq(t.joinReport.id, Number(id) || 0))).returning();
  if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
  await db.insert(t.auditLog).values({ actor: `志工:${clean(who) || '?'}`, action: 'join_report_self_delete', target: `join_reg:${reg.id}`, detail: `${r.orderNo ?? r.key} × ${r.qty}（${REPORT_STATUS[r.status] ?? r.status}）` });
  return { orderNo: r.orderNo ?? r.key };
}

/** 志工補上完整訂單編號（後幾碼對到多筆、或還沒對到時）。保留原本的回報時間 */
export async function fixOwnReport(db: Db, code: string, id: number, full: string, who = '', now = new Date()) {
  const { reg, s } = await ownOpen(db, code);
  const no = normOrderNo(full);
  if (!no || isSuffixKey(no) || !/^[0-9A-Z_/-]{4,40}$/.test(no)) throw new BookingError('INVALID', '請輸入完整訂單編號（含英文字母，例如 ER2611120000109）');
  const [r] = await db.select().from(t.joinReport).where(and(eq(t.joinReport.regId, reg.id), eq(t.joinReport.id, Number(id) || 0)));
  if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
  if (r.orderNo && r.status === 'ok') throw new BookingError('INVALID', '這筆已核對，不用再補。');
  if (isSuffixKey(r.key) && !no.endsWith(r.key)) throw new BookingError('INVALID', `完整編號的最後幾碼要是 ${r.key}。輸入錯了請刪除這筆再重新輸入。`);
  if (isSuffixKey(r.key) && r.buyDate && ![null, r.buyDate].includes(orderDate({ orderNo: no, soldAt: null }))) throw new BookingError('INVALID', `這筆的購買日期是 ${ymdLabel(r.buyDate).trim()}，完整編號的日期不同。輸入錯了請刪除這筆再重新輸入。`);
  const [d] = await db.select().from(t.joinReport).where(and(eq(t.joinReport.eventId, reg.eventId), eq(t.joinReport.orderNo, no)));
  if (d && d.id !== r.id) throw new BookingError('INVALID', d.regId === reg.id ? '本團練場已回報過這筆訂單' : `此訂單已由其他團練場回報，有疑義請洽${s.contact}`);
  const j = judge((await db.select().from(t.joinEra).where(and(eq(t.joinEra.eventId, reg.eventId), eq(t.joinEra.orderNo, no))))[0], r.qty);
  if (j.status === 'refunded') throw new BookingError('INVALID', '此訂單已退票');
  if (j.status === 'outside') throw new BookingError('INVALID', j.note);
  if (j.status === 'mismatch') throw new BookingError('INVALID', `${j.note.replace(/。請刪除後.*$/, '')}。張數不同請刪除這筆，再用正確張數重新回報`);
  await db.update(t.joinReport).set({ key: no, buyDate: null, orderNo: no, status: j.status, eraQty: j.eraQty, note: j.note, checkedAt: now }).where(eq(t.joinReport.id, r.id));
  await db.insert(t.auditLog).values({ actor: `志工:${clean(who) || '?'}`, action: 'join_report_fix', target: `join_reg:${reg.id}`, detail: `${r.key} → ${no}` });
  return { orderNo: no, status: j.status };
}

/** 後台刪一筆回報（例如打錯）。鎖定後會讓劃位序不夠時不能刪 */
export async function deleteReport(db: Db, actor: string, id: number) {
  const s = await getJoinSettings(db);
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(t.joinReport).where(eq(t.joinReport.id, id));
    if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
    const { verified, slots } = await totalsOf(tx, r.regId);
    const after = verified - (r.status === 'ok' ? r.qty : 0);
    if (slots.length && Math.floor(after / s.perSeat) < slots.length) throw new BookingError('INVALID', `刪掉後已核對張數不夠 ${slots.length} 個劃位序。請先取消這個團練場最後的劃位序，再刪除。`);
    await tx.delete(t.joinReport).where(eq(t.joinReport.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_report_delete', target: `join_reg:${r.regId}`, detail: `${r.orderNo ?? r.key} × ${r.qty}` });
    return true;
  });
}

/** 清除揪團測試資料：回報、劃位序（放回已選的座位）、年代名單，並關閉回報與劃位。withRegs：連登記、團練場一起清 */
export async function clearJoinTest(db: Db, actor: string, withRegs = false) {
  const ev = await ev0(db);
  return db.transaction(async (tx) => {
    const seats = (await tx.select({ id: t.joinSlot.seatId }).from(t.joinSlot).where(and(eq(t.joinSlot.eventId, ev.id), sql`${t.joinSlot.seatId} is not null`))).map((x) => x.id!);
    if (seats.length) await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seats), sql`${t.eventSeat.orderId} is null`));
    const slots = await tx.delete(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id)).returning({ id: t.joinSlot.id });
    const reps = await tx.delete(t.joinReport).where(eq(t.joinReport.eventId, ev.id)).returning({ id: t.joinReport.id });
    const era = await tx.delete(t.joinEra).where(eq(t.joinEra.eventId, ev.id)).returning({ no: t.joinEra.orderNo });
    let regs = 0;
    if (withRegs) {
      regs = (await tx.delete(t.joinReg).where(eq(t.joinReg.eventId, ev.id)).returning({ id: t.joinReg.id })).length;
      await tx.delete(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
    } else {
      await tx.update(t.joinReg).set({ pickSentAt: null }).where(eq(t.joinReg.eventId, ev.id));
    }
    for (const k of ['join.reportOpen', 'join.pickOpen', 'join.paused']) {
      await tx.insert(t.appSetting).values({ key: k, value: '0' }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: '0' } });
    }
    const detail = { slots: slots.length, seats: seats.length, reports: reps.length, era: era.length, regs };
    await tx.insert(t.auditLog).values({ actor, action: 'join_clear_test', target: `event:${ev.id}`, detail: JSON.stringify(detail) });
    return detail;
  });
}

/* ---------- 排隊與輪號 ---------- */

const tpeHM = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
export function inHours(s: Pick<JoinSettings, 'hourFrom' | 'hourTo'>, now: Date) {
  if (!s.hourFrom || !s.hourTo) return true;
  const hm = tpeHM(now);
  return s.hourFrom <= s.hourTo ? hm >= s.hourFrom && hm < s.hourTo : hm >= s.hourFrom || hm < s.hourTo;
}
export function deadlineOf(s: Pick<JoinSettings, 'turnMin' | 'pickMin'>, x: Pick<Slot, 'turnAt' | 'seenAt'>) {
  if (x.seenAt) return new Date(x.seenAt.getTime() + s.pickMin * 60_000);
  return x.turnAt ? new Date(x.turnAt.getTime() + s.turnMin * 60_000) : null;
}

async function activeSlots(tx: Tx | Db, eventId: number) {
  return tx.select().from(t.joinSlot).where(and(eq(t.joinSlot.eventId, eventId), inArray(t.joinSlot.status, ['wait', 'turn']))).orderBy(asc(t.joinSlot.pos), asc(t.joinSlot.no));
}
/** 從某個位置開始、同一團練場連續的序號（一起選） */
function groupAt(list: Slot[], i: number) {
  const g = [list[i]];
  for (let k = i + 1; k < list.length && list[k].regId === list[i].regId && list[k].status === list[i].status; k++) g.push(list[k]);
  return g;
}

/** 叫不到：第 1 次延後 pushBack 號、第 2 次排到最後、第 3 次暫停排隊 */
async function miss(tx: Tx, s: JoinSettings, group: Slot[], others: Slot[], maxPos: number) {
  const misses = Math.max(...group.map((g) => g.misses)) + 1;
  const n = group.length;
  const reset = { turnAt: null, seenAt: null, soonMailed: false, turnMailed: false, misses };
  if (misses >= 3) {
    for (const g of group) await tx.update(t.joinSlot).set({ ...reset, status: 'skip' }).where(eq(t.joinSlot.id, g.id));
    return 'skip' as const;
  }
  let k = Math.min(s.pushBack, others.length);
  while (k > 0 && k < others.length && others[k].regId === others[k - 1].regId) k++; // 不插進別的團練場連續的序號中間
  const toEnd = misses >= 2 || k >= others.length;
  for (const [i, g] of group.entries()) {
    const pos = toEnd ? maxPos + 1 + i : others[k - 1].pos + ((others[k].pos - others[k - 1].pos) * (i + 1)) / (n + 1);
    await tx.update(t.joinSlot).set({ ...reset, status: 'wait', pos }).where(eq(t.joinSlot.id, g.id));
  }
  return misses >= 2 ? 'end' as const : 'back' as const; // 第 1 次一律說「延後 N 號」（後面不足 N 號時就是排到最後）
}

const regsById = async (tx: Tx | Db, ids: number[]) => new Map((ids.length ? await tx.select().from(t.joinReg).where(inArray(t.joinReg.id, ids)) : []).map((r) => [r.id, r]));

/**
 * 推進排隊：時間到的叫不到→延後；沒有人在選位→開放下一位；前幾號寄「快輪到您了」。
 * 由劃位頁、後台、背景計時器呼叫，同一時間只會有一個在跑。回傳是否有寄信。
 */
let ticking: Promise<boolean> | null = null;
export function tickQueue(db: Db, base = '', now = new Date()): Promise<boolean> {
  if (ticking) return ticking;
  ticking = runTick(db, base, now).finally(() => { ticking = null; });
  return ticking;
}

async function runTick(db: Db, base: string, now: Date): Promise<boolean> {
  const s = await getJoinSettings(db);
  if (!s.pickOpen) return false;
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return false;
  const mails: { reg: Reg; template: string; content: string }[] = [];
  await db.transaction(async (tx) => {
    let list = await activeSlots(tx, ev.id);
    const maxPos = async () => Number((await tx.select({ m: sql<number>`coalesce(max(${t.joinSlot.pos}), 0)` }).from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id)))[0].m);
    const regs = await regsById(tx, [...new Set(list.map((x) => x.regId))]);
    const nameOf = async (r: Reg) => venueName(tx, r);
    const url = (r: Reg) => (base && r.pickCode ? pickUrl(base, r.pickCode) : '');

    // 1. 時間到：叫不到
    const turn = list.filter((x) => x.status === 'turn');
    if (turn.length && !s.paused) {
      const dl = deadlineOf(s, turn[0]);
      if (dl && now > dl) {
        const others = list.filter((x) => x.status === 'wait');
        const how = await miss(tx, s, turn, others, await maxPos());
        const r = regs.get(turn[0].regId);
        if (r) {
          const what = how === 'skip' ? '已暫停您的排隊。請打開劃位連結，按「我回來了」重新排到最後'
            : how === 'end' ? '已排到最後' : `已延後 ${s.pushBack} 號`;
          mails.push({ reg: r, template: 'join_missed', content: `【${ev.name}】${r.headName} 您好，輪到${await nameOf(r)}劃位（第 ${turn.map((x) => x.no).join('、')} 號）時，沒有在時間內打開劃位連結，${what}。${url(r) ? `劃位連結：${url(r)}` : ''}` });
        }
        await tx.insert(t.auditLog).values({ actor: 'system', action: 'join_miss', target: `join_reg:${turn[0].regId}`, detail: `${turn.map((x) => x.no).join(',')} → ${how}` });
        list = await activeSlots(tx, ev.id);
      }
    }
    if (s.paused || !inHours(s, now)) return;

    // 2. 沒有人在選位：開放下一位
    if (!list.some((x) => x.status === 'turn') && list.length) {
      const g = groupAt(list, 0);
      await tx.update(t.joinSlot).set({ status: 'turn', turnAt: now, seenAt: null, turnMailed: true, soonMailed: true }).where(inArray(t.joinSlot.id, g.map((x) => x.id)));
      const r = regs.get(g[0].regId);
      if (r) mails.push({ reg: r, template: 'join_turn', content: `【${ev.name}】${r.headName} 您好，輪到${await nameOf(r)}劃位了（劃位序第 ${g.map((x) => x.no).join('、')} 號，可選 ${g.length} 席）。請在 ${s.turnMin} 分鐘內打開劃位連結，否則會延後。${url(r) ? `劃位連結：${url(r)}` : ''}` });
      list = await activeSlots(tx, ev.id);
    }

    // 3. 快輪到了：前 notifyAhead 號（不含正在選的）
    const waiting = list.filter((x) => x.status === 'wait').slice(0, s.notifyAhead);
    for (const [i, x] of waiting.entries()) {
      if (x.soonMailed) continue;
      const mine = waiting.filter((y) => y.regId === x.regId && !y.soonMailed);
      await tx.update(t.joinSlot).set({ soonMailed: true }).where(inArray(t.joinSlot.id, mine.map((y) => y.id)));
      for (const y of mine) y.soonMailed = true;
      const r = regs.get(x.regId);
      if (r) mails.push({ reg: r, template: 'join_soon', content: `【${ev.name}】${r.headName} 您好，${await nameOf(r)}的劃位序第 ${x.no} 號快輪到了（前面還有 ${i + 1} 位）。請準備好，打開劃位連結等候。${url(r) ? `劃位連結：${url(r)}` : ''}` });
    }
  });
  for (const m of mails) await mailHead(db, m.reg, m.template, m.content);
  return mails.length > 0;
}

/* ---------- 劃位頁（負責人） ---------- */

async function regByPick(db: Db, code: string) {
  const [r] = await db.select().from(t.joinReg).where(eq(t.joinReg.pickCode, code));
  if (!r || r.status !== 'approved') throw new BookingError('NOT_FOUND', '劃位連結無效或已更換，請向主辦方確認。');
  return r;
}

export const GIFT_ZONE = { id: 1, name: '揪團贈席', color: '#ffd29d', gift: true };

/** 三樓座位（劃位頁用）：贈席空位可選，其餘只看 */
export async function pickSeats(db: Db | Tx, eventId: number) {
  const rows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code,
    status: t.eventSeat.status, usage: t.seatUsage.code,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.venueSeat.floor, '3F')));
  return rows.map((s) => ({
    id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), bundle: null as string | null,
    zoneId: s.usage === USAGE_GIFT ? GIFT_ZONE.id : 0,
    status: (s.usage === USAGE_GIFT ? (s.status === 'free' ? 'free' : 'sold') : 'blocked') as 'free' | 'sold' | 'blocked',
  }));
}

/** 劃位頁：排隊看板、我的劃位序、輪到時可選的座位 */
export async function pickPage(db: Db, code: string, now = new Date(), base = '') {
  const me = await regByPick(db, code);
  await tickQueue(db, base, now);
  const s = await getJoinSettings(db);
  const ev = await ev0(db);
  // 輪到我、第一次打開：開始算選位時間
  await db.update(t.joinSlot).set({ seenAt: now }).where(and(eq(t.joinSlot.regId, me.id), eq(t.joinSlot.status, 'turn'), sql`${t.joinSlot.seenAt} is null`));
  const all = await db.select().from(t.joinSlot).where(and(eq(t.joinSlot.eventId, ev.id), ne(t.joinSlot.status, 'void'))).orderBy(asc(t.joinSlot.no));
  const regs = await regsById(db, [...new Set([me.id, ...all.map((x) => x.regId)])]);
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  const vn = (regId: number) => { const r = regs.get(regId); return (r?.venueId ? vs.find((v) => v.id === r.venueId)?.name : r?.venueText) ?? ''; };
  const seats = await pickSeats(db, ev.id);
  const label = new Map(seats.map((x) => [x.id, x.label]));
  const queue = all.filter((x) => x.status === 'wait' || x.status === 'turn').sort((a, b) => a.pos - b.pos || a.no - b.no);
  const waitIdx = new Map(queue.filter((x) => x.status === 'wait').map((x, i) => [x.id, i])); // 前面還有幾位在排（不含正在選的）
  const turn = queue.filter((x) => x.status === 'turn');
  const mineTurn = turn.length > 0 && turn[0].regId === me.id;
  const myDone = all.filter((x) => x.regId === me.id && x.status === 'done').sort((a, b) => (b.pickedAt?.getTime() ?? 0) - (a.pickedAt?.getTime() ?? 0));
  const tot = await totalsOf(db, me.id);
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, venue: vn(me.id), headName: me.headName,
    settings: { pickOpen: s.pickOpen, paused: s.paused, inHours: inHours(s, now), hourFrom: s.hourFrom, hourTo: s.hourTo, turnMin: s.turnMin, pickMin: s.pickMin, pushBack: s.pushBack, contact: s.contact },
    now: now.toISOString(), tickets: tot.verified, locked: all.length > 0,
    current: turn.length ? { nos: turn.map((x) => x.no), venue: vn(turn[0].regId), mine: mineTurn, deadline: deadlineOf(s, turn[0])?.toISOString() ?? null, seen: !!turn[0].seenAt } : null,
    queue: queue.map((x) => ({ no: x.no, venue: vn(x.regId), mine: x.regId === me.id, status: x.status, misses: x.misses, place: waitIdx.get(x.id) ?? -1 })),
    board: all.map((x) => ({ no: x.no, venue: vn(x.regId), mine: x.regId === me.id, status: x.status, misses: x.misses, seat: x.seatId ? label.get(x.seatId) ?? '' : '' })),
    mine: all.filter((x) => x.regId === me.id).map((x) => ({ no: x.no, status: x.status, misses: x.misses, seat: x.seatId ? label.get(x.seatId) ?? '' : '', place: waitIdx.get(x.id) ?? -1 })),
    pickCount: mineTurn ? turn.length : 0,
    rep: { name: myDone[0]?.repName || me.headName, phone: myDone[0]?.repPhone || me.headPhone },
    zones: [GIFT_ZONE], seats,
  };
}

export const pickInput = z.object({
  seatIds: z.array(z.string().max(16)).min(1).max(30),
  repName: z.string().transform(clean).pipe(z.string().min(1, '請填寫領票代表姓名').max(30)),
  repPhone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '領票代表手機應為 09 開頭的 10 位數字')),
});

/** 送出選位：一定要剛好選輪到的席數，而且都是空的贈席 */
export async function submitPick(db: Db, code: string, raw: unknown, now = new Date(), base = '') {
  const p = pickInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const me = await regByPick(db, code);
  await tickQueue(db, base, now);
  const s = await getJoinSettings(db);
  const ids = [...new Set(p.data.seatIds)];
  const res = await db.transaction(async (tx) => {
    const turn = (await activeSlots(tx, me.eventId)).filter((x) => x.status === 'turn');
    if (!turn.length || turn[0].regId !== me.id) throw new BookingError('INVALID', '現在不是您的劃位時間，請看排隊看板。');
    const dl = deadlineOf(s, turn[0]);
    if (dl && now > dl && !s.paused) throw new BookingError('INVALID', '選位時間已過，已延後，請看排隊看板。');
    if (ids.length !== turn.length) throw new BookingError('INVALID', `這次要選 ${turn.length} 席，目前選了 ${ids.length} 席。`);
    const rows = await tx.select({ id: t.eventSeat.seatId, status: t.eventSeat.status, usage: t.seatUsage.code, floor: t.venueSeat.floor, x: t.venueSeat.x, y: t.venueSeat.y })
      .from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
      .where(and(eq(t.eventSeat.eventId, me.eventId), inArray(t.eventSeat.seatId, ids))).for('update', { of: t.eventSeat });
    if (rows.length !== ids.length || rows.some((r) => r.floor !== '3F' || r.usage !== USAGE_GIFT)) throw new BookingError('INVALID', '只能選三樓的揪團贈席（淡黃色座位）。');
    const taken = rows.filter((r) => r.status !== 'free').map((r) => r.id);
    if (taken.length) throw new BookingError('SEAT_TAKEN', '有座位已被選走，請重新選取。', taken);
    const got = await tx.update(t.eventSeat).set({ status: 'sold', orderId: null, holdUntil: null, bundle: null, version: sql`${t.eventSeat.version} + 1` })
      .where(and(eq(t.eventSeat.eventId, me.eventId), inArray(t.eventSeat.seatId, ids), eq(t.eventSeat.status, 'free'))).returning({ id: t.eventSeat.seatId });
    if (got.length !== ids.length) throw new BookingError('SEAT_TAKEN', '有座位剛被選走，請重新選取。');
    const order = rows.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const [i, slot] of turn.sort((a, b) => a.no - b.no).entries()) {
      await tx.update(t.joinSlot).set({ status: 'done', seatId: order[i].id, repName: p.data.repName, repPhone: p.data.repPhone, pickedAt: now, turnAt: null }).where(eq(t.joinSlot.id, slot.id));
    }
    await tx.insert(t.auditLog).values({ actor: `負責人:${me.headName}`, action: 'join_pick', target: `join_reg:${me.id}`, detail: JSON.stringify({ nos: turn.map((x) => x.no), seats: ids }) });
    return { nos: turn.map((x) => x.no), seats: order.map((r) => r.id) };
  });
  await tickQueue(db, base, now); // 下一位自動開放
  return res;
}

/** 被暫停排隊（叫不到 3 次）：負責人按「我回來了」重新排到最後 */
export async function rejoinQueue(db: Db, code: string, now = new Date()) {
  const me = await regByPick(db, code);
  return db.transaction(async (tx) => {
    const mine = await tx.select().from(t.joinSlot).where(and(eq(t.joinSlot.regId, me.id), eq(t.joinSlot.status, 'skip'))).orderBy(asc(t.joinSlot.no));
    if (!mine.length) throw new BookingError('INVALID', '您目前沒有被暫停的劃位序。');
    const [m] = await tx.select({ m: sql<number>`coalesce(max(${t.joinSlot.pos}), 0)` }).from(t.joinSlot).where(eq(t.joinSlot.eventId, me.eventId));
    for (const [i, x] of mine.entries()) await tx.update(t.joinSlot).set({ status: 'wait', pos: Number(m.m) + 1 + i, misses: 2 }).where(eq(t.joinSlot.id, x.id));
    await tx.insert(t.auditLog).values({ actor: `負責人:${me.headName}`, action: 'join_rejoin', target: `join_reg:${me.id}`, detail: `${mine.length} 個 @ ${now.toISOString()}` });
    return { count: mine.length };
  });
}

/* ---------- 後台：排隊操作 ---------- */

/** 跳過目前這一輪（算一次叫不到） */
export async function skipTurn(db: Db, actor: string) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  return db.transaction(async (tx) => {
    const list = await activeSlots(tx, ev.id);
    const turn = list.filter((x) => x.status === 'turn');
    if (!turn.length) throw new BookingError('INVALID', '目前沒有人在劃位。');
    const [m] = await tx.select({ m: sql<number>`coalesce(max(${t.joinSlot.pos}), 0)` }).from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id));
    const how = await miss(tx, s, turn, list.filter((x) => x.status === 'wait'), Number(m.m));
    await tx.insert(t.auditLog).values({ actor, action: 'join_skip', target: `join_reg:${turn[0].regId}`, detail: `${turn.map((x) => x.no).join(',')} → ${how}` });
    return { how };
  });
}

/** 恢復被暫停的劃位序：排到最後 */
export async function restoreSlot(db: Db, actor: string, id: number) {
  return db.transaction(async (tx) => {
    const [x] = await tx.select().from(t.joinSlot).where(eq(t.joinSlot.id, id));
    if (!x || x.status !== 'skip') throw new BookingError('INVALID', '只能恢復「暫停排隊」的劃位序');
    const [m] = await tx.select({ m: sql<number>`coalesce(max(${t.joinSlot.pos}), 0)` }).from(t.joinSlot).where(eq(t.joinSlot.eventId, x.eventId));
    await tx.update(t.joinSlot).set({ status: 'wait', pos: Number(m.m) + 1, misses: 2 }).where(eq(t.joinSlot.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_slot_restore', target: `join_slot:${id}`, detail: String(x.no) });
    return true;
  });
}

/** 取消劃位序（例如年代退票後張數不足）。已選的座位放回贈席；已送年代的要先取消「已送年代」 */
export async function voidSlot(db: Db, actor: string, id: number, reason: string) {
  const why = clean(reason);
  if (why.length < 2) throw new BookingError('INVALID', '請填寫取消原因');
  return db.transaction(async (tx) => {
    const [x] = await tx.select().from(t.joinSlot).where(eq(t.joinSlot.id, id));
    if (!x || x.status === 'void') throw new BookingError('NOT_FOUND', '找不到這個劃位序');
    if (x.sentAt) throw new BookingError('INVALID', '這一席已送年代。請先取消「已送年代」，並通知年代作廢這張票。');
    if (x.seatId) await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, x.eventId), eq(t.eventSeat.seatId, x.seatId)));
    await tx.update(t.joinSlot).set({ status: 'void', seatId: null }).where(eq(t.joinSlot.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_slot_void', target: `join_slot:${id}`, detail: `${x.no}：${why}` });
    return true;
  });
}

/** 後台改座位（已選好的劃位序換到另一個空的贈席）；改過的要重新送年代 */
export async function changeSlotSeat(db: Db, actor: string, id: number, seatId: string) {
  return db.transaction(async (tx) => {
    const [x] = await tx.select().from(t.joinSlot).where(eq(t.joinSlot.id, id));
    if (!x || x.status !== 'done' || !x.seatId) throw new BookingError('INVALID', '只有已選位的劃位序可以改座位');
    const [n] = await tx.select({ status: t.eventSeat.status, usage: t.seatUsage.code, floor: t.venueSeat.floor }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
      .where(and(eq(t.eventSeat.eventId, x.eventId), eq(t.eventSeat.seatId, seatId)));
    if (!n || n.floor !== '3F' || n.usage !== USAGE_GIFT || n.status !== 'free') throw new BookingError('INVALID', '新座位要是空的三樓揪團贈席');
    await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, x.eventId), eq(t.eventSeat.seatId, x.seatId)));
    await tx.update(t.eventSeat).set({ status: 'sold', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, x.eventId), eq(t.eventSeat.seatId, seatId)));
    await tx.update(t.joinSlot).set({ seatId, sentAt: null }).where(eq(t.joinSlot.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_slot_seat', target: `join_slot:${id}`, detail: `${x.seatId} → ${seatId}` });
    return true;
  });
}

/** 後台改領票代表 */
export async function setSlotRep(db: Db, actor: string, id: number, raw: unknown) {
  const p = pickInput.pick({ repName: true, repPhone: true }).safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const [x] = await db.update(t.joinSlot).set({ repName: p.data.repName, repPhone: p.data.repPhone, sentAt: null }).where(and(eq(t.joinSlot.id, id), eq(t.joinSlot.status, 'done'))).returning();
  if (!x) throw new BookingError('INVALID', '只有已選位的劃位序可以改領票代表');
  await db.insert(t.auditLog).values({ actor, action: 'join_slot_rep', target: `join_slot:${id}`, detail: `${p.data.repName} ${p.data.repPhone}` });
  return true;
}

/** 標示已送年代：之後負責人不能改，只有後台能改。ids 沒給＝所有已選位、還沒送的 */
export async function markSent(db: Db, actor: string, sent: boolean, ids?: number[], now = new Date()) {
  const ev = await ev0(db);
  const rows = await db.update(t.joinSlot).set({ sentAt: sent ? now : null })
    .where(and(eq(t.joinSlot.eventId, ev.id), eq(t.joinSlot.status, 'done'), ids?.length ? inArray(t.joinSlot.id, ids) : sent ? sql`${t.joinSlot.sentAt} is null` : sql`false`))
    .returning({ id: t.joinSlot.id });
  await db.insert(t.auditLog).values({ actor, action: sent ? 'join_sent' : 'join_unsent', target: `event:${ev.id}`, detail: String(rows.length) });
  return { count: rows.length };
}

/* ---------- 後台狀態 ---------- */

export async function joinAdminState(db: Db, base = '', now = new Date()) {
  const settings = await getJoinSettings(db);
  const regState = await joinRegState(db, base);
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return { settings, ...regState, era: { count: 0, refunded: 0, updatedAt: null as string | null }, reports: [], eraList: [] as { orderNo: string; qty: number; otherQty: number; otherNote: string; status: string; soldAt: string | null; group: string; reportStatus: string }[], slots: [], seats: [], usage: { gift: 0, era: 0 }, totals: [], current: null, inHours: true, locked: false, provisional: [] as { no: number; venue: string; at: string }[] };
  await tickQueue(db, base, now);
  const usage = await joinUsages(db, ev.id);
  const eraAll = await db.select().from(t.joinEra).where(eq(t.joinEra.eventId, ev.id));
  const [e] = await db.select({ n: sql<number>`count(*)::int`, refunded: sql<number>`count(*) filter (where ${t.joinEra.status} = 'refunded')::int`, at: sql<Date | null>`max(${t.joinEra.updatedAt})` })
    .from(t.joinEra).where(eq(t.joinEra.eventId, ev.id));
  const reports = await db.select({ r: t.joinReport, eraQty: t.joinEra.qty, eraStatus: t.joinEra.status }).from(t.joinReport)
    .leftJoin(t.joinEra, and(eq(t.joinEra.eventId, t.joinReport.eventId), eq(t.joinEra.orderNo, t.joinReport.orderNo)))
    .where(eq(t.joinReport.eventId, ev.id)).orderBy(asc(t.joinReport.id));
  const slots = await db.select().from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id)).orderBy(asc(t.joinSlot.no));
  const seatRows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, block: t.venueSeat.block, code: t.venueSeat.code,
    zoneId: t.eventSeat.zoneId, usageId: t.eventSeat.usageId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, bundle: t.eventSeat.bundle,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '3F')));
  const seats = seatRows.map((s) => ({ id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, block: s.block, code: s.code, row: rowKey(s), label: seatLabel(s), zoneId: s.zoneId, usageId: s.usageId, status: s.status, orderId: s.orderId, bundle: s.bundle, installed: true }));
  const label = new Map(seats.map((s) => [s.id, s]));
  const reg = new Map(regState.regs.map((r) => [r.id, r]));
  // 已上傳的年代名單：每筆訂單被哪一群回報（最新售出在上）
  const byOrder = new Map(reports.filter((x) => x.r.orderNo).map((x) => [x.r.orderNo!, x.r]));
  const eraList = eraAll.sort((a, b) => (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0) || b.orderNo.localeCompare(a.orderNo)).map((x) => {
    const r = byOrder.get(x.orderNo);
    return { orderNo: x.orderNo, qty: x.qty, otherQty: x.otherQty, otherNote: x.otherNote, status: x.status, soldAt: x.soldAt?.toISOString() ?? null,
      group: r ? reg.get(r.regId)?.venueName ?? '' : '', reportStatus: r?.status ?? '' };
  });
  const locked = slots.length > 0;
  const prov = locked ? [] : await provisionalSlots(db, ev.id, settings.perSeat);
  const totals = regState.regs.filter((r) => r.status === 'approved').map((r) => {
    const mine = reports.filter((x) => x.r.regId === r.id);
    const tickets = mine.reduce((a, x) => a + x.r.qty, 0);
    const ok = mine.filter((x) => x.r.status === 'ok').reduce((a, x) => a + x.r.qty, 0);
    const pending = mine.filter((x) => x.r.status === 'pending').reduce((a, x) => a + x.r.qty, 0);
    const sl = slots.filter((x) => x.regId === r.id && x.status !== 'void');
    return { regId: r.id, venue: r.venueName, headName: r.headName, orders: mine.length, tickets, verified: ok, pending,
      slots: locked ? sl.length : prov.filter((x) => x.regId === r.id).length, done: sl.filter((x) => x.status === 'done').length,
      short: locked && Math.floor(ok / settings.perSeat) < sl.length }; // 鎖定後年代名單更新（退票、張數變少）劃位序比張數多
  });
  const active = slots.filter((x) => x.status === 'turn');
  return {
    settings, ...regState, usage,
    era: { count: e.n, refunded: e.refunded, updatedAt: e.at ? new Date(e.at).toISOString() : null },
    reports: reports.map((x) => ({ id: x.r.id, regId: x.r.regId, venue: reg.get(x.r.regId)?.venueName ?? '', key: x.r.key, buyDate: x.r.buyDate, orderNo: x.r.orderNo, qty: x.r.qty, reporter: x.r.reporter, at: x.r.createdAt.toISOString(),
      status: x.r.status, era: x.r.note || (x.r.status === 'ambiguous' ? '後幾碼對到多筆' : x.r.status === 'mismatch' ? `年代記錄 ${x.r.eraQty ?? '?'} 張`
        : x.eraStatus === 'refunded' ? '已退票' : x.r.orderNo && x.eraQty === null ? '名單上已沒有' : '') })),
    eraList,
    slots: slots.map((x) => {
      const r = reg.get(x.regId); const st = x.seatId ? label.get(x.seatId) : undefined;
      return { id: x.id, no: x.no, regId: x.regId, venue: r?.venueName ?? '', headName: r?.headName ?? '', status: x.status, pos: x.pos, misses: x.misses,
        seatId: x.seatId, seat: st?.label ?? '', rowNo: st ? st.row : null, seatNo: st?.no ?? '', repName: x.repName, repPhone: x.repPhone,
        pickedAt: x.pickedAt?.toISOString() ?? null, sentAt: x.sentAt?.toISOString() ?? null, earnedAt: x.earnedAt.toISOString() };
    }),
    seats, totals, inHours: inHours(settings, now), locked,
    provisional: prov.map((x) => ({ no: x.no, venue: reg.get(x.regId)?.venueName ?? '', at: x.at.toISOString() })),
    current: active.length ? { nos: active.map((x) => x.no), venue: reg.get(active[0].regId)?.venueName ?? '', deadline: deadlineOf(settings, active[0])?.toISOString() ?? null, seen: !!active[0].seenAt } : null,
  };
}

/** 後台背景：每 10 秒推進一次排隊（沒有人開頁面也會叫下一號） */
export function startJoinTicker(db: Db) {
  const g = globalThis as unknown as { __ticcJoin?: NodeJS.Timeout };
  if (g.__ticcJoin) return;
  g.__ticcJoin = setInterval(async () => {
    try {
      const { siteOrigin } = await import('./push');
      if (await tickQueue(db, await siteOrigin(db))) (await import('./notify')).dispatchQueued(db).catch(() => undefined);
    } catch { /* 下一輪再試 */ }
  }, 10_000);
  g.__ticcJoin.unref?.();
}

