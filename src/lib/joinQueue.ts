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

/** 訂單編號：去空白、全形轉半形、英文大寫 */
export const normOrderNo = (s: string) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s　]/g, '').toUpperCase();

/* ---------- 年代名單 ---------- */

export const eraInput = z.array(z.object({
  orderNo: z.string().max(60),
  qty: z.number().int().min(0).max(1000),
  status: z.enum(['sold', 'refunded']),
})).min(1, '名單是空的').max(50000);

/** 上傳年代名單：同一訂單編號以新的為準（張數、已售／已退） */
export async function uploadEra(db: Db, actor: string, raw: unknown, now = new Date()) {
  const p = eraInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '名單格式不正確');
  const ev = await ev0(db);
  const map = new Map<string, { qty: number; status: 'sold' | 'refunded' }>();
  for (const r of p.data) { const no = normOrderNo(r.orderNo); if (no) map.set(no, { qty: r.qty, status: r.status }); }
  if (!map.size) throw new BookingError('INVALID', '名單裡沒有訂單編號');
  const nos = [...map.keys()];
  const have = new Map<string, typeof t.joinEra.$inferSelect>();
  for (let i = 0; i < nos.length; i += 1000) {
    for (const e of await db.select().from(t.joinEra).where(and(eq(t.joinEra.eventId, ev.id), inArray(t.joinEra.orderNo, nos.slice(i, i + 1000))))) have.set(e.orderNo, e);
  }
  let added = 0, changed = 0;
  const rows = nos.map((orderNo) => ({ eventId: ev.id, orderNo, ...map.get(orderNo)!, updatedAt: now }));
  for (const r of rows) { const h = have.get(r.orderNo); if (!h) added++; else if (h.qty !== r.qty || h.status !== r.status) changed++; }
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(t.joinEra).values(rows.slice(i, i + 500)).onConflictDoUpdate({
      target: [t.joinEra.eventId, t.joinEra.orderNo], set: { qty: sql`excluded.qty`, status: sql`excluded.status`, updatedAt: sql`excluded.updated_at` },
    });
  }
  const refunded = rows.filter((r) => r.status === 'refunded').length;
  await db.insert(t.auditLog).values({ actor, action: 'join_era_upload', target: `event:${ev.id}`, detail: JSON.stringify({ rows: rows.length, added, changed, refunded }) });
  return { rows: rows.length, added, changed, refunded };
}

/* ---------- 合計與劃位序 ---------- */

async function totalsOf(db: Db | Tx, regId: number) {
  const [r] = await db.select({ orders: sql<number>`count(*)::int`, tickets: sql<number>`coalesce(sum(${t.joinReport.qty}), 0)::int` })
    .from(t.joinReport).where(eq(t.joinReport.regId, regId));
  const slots = await db.select().from(t.joinSlot).where(and(eq(t.joinSlot.regId, regId), ne(t.joinSlot.status, 'void'))).orderBy(asc(t.joinSlot.no));
  return { orders: r.orders, tickets: r.tickets, slots };
}

/** 依合計補發劃位序（只增不減）。回傳新拿到的序號 */
async function awardSlots(tx: Tx, eventId: number, regId: number, perSeat: number, now: Date) {
  const { tickets, slots } = await totalsOf(tx, regId);
  const want = Math.floor(tickets / perSeat);
  const fresh: number[] = [];
  for (let i = slots.length; i < want; i++) {
    const [m] = await tx.select({ no: sql<number>`coalesce(max(${t.joinSlot.no}), 0)::int`, pos: sql<number>`coalesce(max(${t.joinSlot.pos}), 0)` })
      .from(t.joinSlot).where(eq(t.joinSlot.eventId, eventId));
    const no = m.no + 1;
    await tx.insert(t.joinSlot).values({ eventId, regId, no, pos: Math.max(Number(m.pos), m.no) + 1, earnedAt: now });
    fresh.push(no);
  }
  return fresh;
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

/** 回報頁：團練場、合計、已回報的訂單 */
export async function reportPage(db: Db, code: string) {
  const r = await regByReport(db, code);
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  const tot = await totalsOf(db, r.id);
  const list = await db.select().from(t.joinReport).where(eq(t.joinReport.regId, r.id)).orderBy(asc(t.joinReport.id));
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, venue: await venueName(db, r), headName: r.headName,
    open: s.reportOpen, perSeat: s.perSeat, contact: s.contact,
    orders: tot.orders, tickets: tot.tickets, slots: tot.slots.map((x) => x.no), next: s.perSeat - (tot.tickets % s.perSeat),
    list: list.map((x) => ({ orderNo: x.orderNo, qty: x.qty, reporter: x.reporter, at: x.createdAt.toISOString() })),
  };
}

export const reportInput = z.object({
  reporter: z.string().transform(clean).pipe(z.string().min(1, '請先輸入您的名字').max(20, '名字最多 20 字')),
  rows: z.array(z.object({ orderNo: z.string().max(60).default(''), qty: z.union([z.number(), z.string()]).default('') })).min(1).max(50, '一次最多 50 筆'),
});

/** 送出回報：逐筆核對年代名單；正確的存起來、不對的退回說明。合計跨過 10、20… 立刻給劃位序 */
export async function submitReport(db: Db, code: string, raw: unknown, ip = '', now = new Date(), base = '') {
  const p = reportInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const reg = await regByReport(db, code);
  const s = await getJoinSettings(db);
  if (!s.reportOpen) throw new BookingError('SALE_CLOSED', '回報目前沒有開放。');
  rateLimit(`rep:${code}`, now.getTime(), 60);
  rateLimit(`repip:${ip}`, now.getTime(), 60);
  const rows = p.data.rows.map((x) => ({ orderNo: normOrderNo(String(x.orderNo)), qtyRaw: String(x.qty).trim() })).filter((x) => x.orderNo || x.qtyRaw);
  if (!rows.length) throw new BookingError('INVALID', '請輸入訂單編號與張數');
  const nos = rows.map((x) => x.orderNo).filter(Boolean);
  const era = new Map((nos.length ? await db.select().from(t.joinEra).where(and(eq(t.joinEra.eventId, reg.eventId), inArray(t.joinEra.orderNo, nos))) : []).map((e) => [e.orderNo, e]));
  const done = new Map((nos.length ? await db.select().from(t.joinReport).where(and(eq(t.joinReport.eventId, reg.eventId), inArray(t.joinReport.orderNo, nos))) : []).map((e) => [e.orderNo, e]));
  const seen = new Set<string>();
  const ok: { orderNo: string; qty: number }[] = [];
  const bad: { orderNo: string; qty: string; reason: string }[] = [];
  for (const x of rows) {
    const qty = Number(x.qtyRaw);
    const e = era.get(x.orderNo);
    const d = done.get(x.orderNo);
    const reason = !x.orderNo ? '請輸入訂單編號'
      : !/^\d+$/.test(x.qtyRaw) || qty < 1 || qty > 100 ? '張數請填 1 以上的數字'
        : seen.has(x.orderNo) ? '這次重複輸入了'
          : d ? (d.regId === reg.id ? '本團練場已回報過' : '此訂單已由其他團練場回報')
            : !e ? '查無此訂單，請確認號碼；剛購買的請等名單更新後再回報'
              : e.status !== 'sold' ? '此訂單已退票'
                : e.qty !== qty ? `張數不符（年代記錄為 ${e.qty} 張）` : '';
    if (x.orderNo) seen.add(x.orderNo);
    if (reason) bad.push({ orderNo: x.orderNo, qty: x.qtyRaw, reason }); else ok.push({ orderNo: x.orderNo, qty });
  }
  const fresh = ok.length ? await db.transaction(async (tx) => {
    await tx.insert(t.joinReport).values(ok.map((x) => ({ eventId: reg.eventId, regId: reg.id, orderNo: x.orderNo, qty: x.qty, reporter: p.data.reporter, createdAt: now })));
    return awardSlots(tx, reg.eventId, reg.id, s.perSeat, now);
  }) : [];
  const tot = await totalsOf(db, reg.id);
  const venue = await venueName(db, reg);
  if (ok.length) {
    const ev = await ev0(db);
    const q = ok.reduce((a, x) => a + x.qty, 0);
    await mailHead(db, reg, 'join_report', `【${ev.name}】${reg.headName} 您好，${p.data.reporter} 剛送出 ${ok.length} 筆訂單、${q} 張。`
      + `${venue}目前合計 ${tot.orders} 筆、${tot.tickets} 張，已取得劃位序 ${tot.slots.length} 個${tot.slots.length ? `（第 ${tot.slots.map((x) => x.no).join('、')} 號）` : ''}。`
      + `${fresh.length ? `這次新取得第 ${fresh.join('、')} 號。` : ''}${base && reg.reportCode ? `查看回報：${reportUrl(base, reg.reportCode)}` : ''}`);
    await db.insert(t.auditLog).values({ actor: `志工:${p.data.reporter}`, action: 'join_report', target: `join_reg:${reg.id}`, detail: JSON.stringify({ ok: ok.length, bad: bad.length, fresh }) });
  }
  return { accepted: ok, rejected: bad, fresh, orders: tot.orders, tickets: tot.tickets, slots: tot.slots.map((x) => x.no), next: s.perSeat - (tot.tickets % s.perSeat) };
}

/** 後台刪一筆回報（例如打錯）。會讓劃位序不夠時不能刪 */
export async function deleteReport(db: Db, actor: string, id: number) {
  const s = await getJoinSettings(db);
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(t.joinReport).where(eq(t.joinReport.id, id));
    if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
    const { tickets, slots } = await totalsOf(tx, r.regId);
    if (Math.floor((tickets - r.qty) / s.perSeat) < slots.length) throw new BookingError('INVALID', `刪掉後張數不夠 ${slots.length} 個劃位序。請先取消這個團練場最後的劃位序，再刪除。`);
    await tx.delete(t.joinReport).where(eq(t.joinReport.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'join_report_delete', target: `join_reg:${r.regId}`, detail: `${r.orderNo} × ${r.qty}` });
    return true;
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

const GIFT_ZONE = { id: 1, name: '揪團贈席', color: '#ffd29d', gift: true };

/** 三樓座位（劃位頁用）：贈席空位可選，其餘只看 */
async function pickSeats(db: Db | Tx, eventId: number) {
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
  const regs = await regsById(db, [...new Set(all.map((x) => x.regId))]);
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
    now: now.toISOString(), tickets: tot.tickets,
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
  if (!ev) return { settings, ...regState, era: { count: 0, refunded: 0, updatedAt: null as string | null }, reports: [], slots: [], seats: [], usage: { gift: 0, era: 0 }, totals: [], current: null, inHours: true };
  await tickQueue(db, base, now);
  const usage = await joinUsages(db, ev.id);
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
  const totals = regState.regs.filter((r) => r.status === 'approved').map((r) => {
    const mine = reports.filter((x) => x.r.regId === r.id);
    const tickets = mine.reduce((a, x) => a + x.r.qty, 0);
    const ok = mine.filter((x) => x.eraStatus === 'sold' && x.eraQty === x.r.qty).reduce((a, x) => a + x.r.qty, 0);
    const sl = slots.filter((x) => x.regId === r.id && x.status !== 'void');
    return { regId: r.id, venue: r.venueName, headName: r.headName, orders: mine.length, tickets, verified: ok, slots: sl.length, done: sl.filter((x) => x.status === 'done').length,
      short: Math.floor(ok / settings.perSeat) < sl.length }; // 年代名單更新後（退票、張數變少）劃位序比張數多
  });
  const active = slots.filter((x) => x.status === 'turn');
  return {
    settings, ...regState, usage,
    era: { count: e.n, refunded: e.refunded, updatedAt: e.at ? new Date(e.at).toISOString() : null },
    reports: reports.map((x) => ({ id: x.r.id, regId: x.r.regId, venue: reg.get(x.r.regId)?.venueName ?? '', orderNo: x.r.orderNo, qty: x.r.qty, reporter: x.r.reporter, at: x.r.createdAt.toISOString(),
      era: x.eraStatus === 'refunded' ? '已退票' : x.eraQty === null ? '名單上已沒有' : x.eraQty !== x.r.qty ? `年代記錄 ${x.eraQty} 張` : '' })),
    slots: slots.map((x) => {
      const r = reg.get(x.regId); const st = x.seatId ? label.get(x.seatId) : undefined;
      return { id: x.id, no: x.no, regId: x.regId, venue: r?.venueName ?? '', headName: r?.headName ?? '', status: x.status, pos: x.pos, misses: x.misses,
        seatId: x.seatId, seat: st?.label ?? '', rowNo: st ? st.row : null, seatNo: st?.no ?? '', repName: x.repName, repPhone: x.repPhone,
        pickedAt: x.pickedAt?.toISOString() ?? null, sentAt: x.sentAt?.toISOString() ?? null, earnedAt: x.earnedAt.toISOString() };
    }),
    seats, totals, inHours: inHours(settings, now),
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

