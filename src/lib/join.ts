/**
 * 揪團贈票（銀區＝三樓，買十送一）：登記、團練場、設定、寄連結。
 *
 * 11/10 定案流程：
 * - 每個團練場一位負責人，登記 4 欄（團練場、姓名、手機、Email）。志工不登記。
 * - 核准後寄兩條連結給負責人：回報連結（轉給志工）、劃位連結（請勿轉傳）。
 * - 回報、劃位序、自動輪號劃位見 joinQueue.ts。
 * - 功能開關預設關閉。
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { normalizePhone } from './validation';

const DEFAULT_CONTACT = '主辦方';
export const newCode = (n = 9) => randomBytes(n).toString('base64url');
export const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
export const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const fmtPhone = (p: string) => p.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');

export async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/* ---------- 設定 ---------- */

export interface JoinSettings {
  open: boolean; // 開放登記
  contact: string; // 「資料有誤請聯絡＿＿」
  reportOpen: boolean; // 開放回報
  perSeat: number; // 每幾張一個劃位序
  pickOpen: boolean; // 開放劃位（排隊開始）
  paused: boolean; // 暫停輪號
  turnMin: number; // 輪到後等幾分鐘（沒打開就延後）
  pickMin: number; // 打開後選位時間（分鐘）
  pushBack: number; // 叫不到延後幾號
  notifyAhead: number; // 前幾號寄「快輪到您了」
  hourFrom: string; // 劃位時段（台北時間），空白＝不限
  hourTo: string;
  silverPrices: string; // 銀區票價（年代名單只算這些售價），例：3000,2550
}
const DEFAULTS: JoinSettings = {
  open: false, contact: DEFAULT_CONTACT, reportOpen: false, perSeat: 10, pickOpen: false, paused: false,
  turnMin: 3, pickMin: 10, pushBack: 3, notifyAhead: 3, hourFrom: '09:00', hourTo: '21:00', silverPrices: '3000,2550',
};
const KEYS = Object.keys(DEFAULTS) as (keyof JoinSettings)[];
const key = (k: string) => `join.${k}`;

export async function getJoinSettings(db: Db): Promise<JoinSettings> {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, KEYS.map(key)));
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const k of KEYS) {
    const v = rows.find((r) => r.key === key(k))?.value;
    if (v === undefined) continue;
    const d = DEFAULTS[k];
    out[k] = typeof d === 'boolean' ? v === '1' : typeof d === 'number' ? (Number.isFinite(Number(v)) ? Number(v) : d) : v;
  }
  const s = out as unknown as JoinSettings;
  if (!s.contact.trim()) s.contact = DEFAULT_CONTACT;
  return s;
}

const hhmm = z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, '時間格式為 09:00');
export const settingsInput = z.object({
  open: z.boolean(), contact: z.string().max(60), reportOpen: z.boolean(), perSeat: z.number().int().min(1).max(100),
  pickOpen: z.boolean(), paused: z.boolean(), turnMin: z.number().min(0.5).max(60), pickMin: z.number().min(1).max(120),
  pushBack: z.number().int().min(1).max(50), notifyAhead: z.number().int().min(0).max(20), hourFrom: hhmm, hourTo: hhmm,
  silverPrices: z.string().max(60).regex(/^\s*\d{2,6}(\s*[,，、 ]\s*\d{2,6})*\s*$/, '銀區票價請用逗號分開，例：3000,2550'),
}).partial();

export async function setJoinSettings(db: Db, actor: string, raw: unknown) {
  const p = settingsInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '設定不正確');
  const x = p.data;
  if (x.perSeat !== undefined && x.perSeat !== (await getJoinSettings(db)).perSeat) {
    const [used] = await db.select({ id: t.joinSlot.id }).from(t.joinSlot).limit(1);
    if (used) throw new BookingError('INVALID', '已經有劃位序了，不能再改「每幾張一席」。');
  }
  for (const [k, v] of Object.entries(x)) {
    const value = typeof v === 'boolean' ? (v ? '1' : '0') : k === 'contact' ? clean(String(v)).slice(0, 60) : String(v);
    await db.insert(t.appSetting).values({ key: key(k), value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  }
  await db.insert(t.auditLog).values({ actor, action: 'join_settings', target: 'app_setting', detail: JSON.stringify(x) });
  return getJoinSettings(db);
}

/* ---------- 三樓座位用途：贈席、年代售出 ---------- */

export const USAGE_GIFT = 'join-gift';
export const USAGE_ERA = 'era-sold';
export const USAGE_VOL = 'join-vol';
/** 揪團贈席只能在三樓兩側斜區（左2、右2） */
export const GIFT_BLOCKS = ['L2', 'R2'];

/** 確保有「揪團贈席」「年代售出」兩種用途（都不開放販售） */
export async function joinUsages(db: Db, eventId: number) {
  const have = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.eventId, eventId), inArray(t.seatUsage.code, [USAGE_GIFT, USAGE_ERA, USAGE_VOL])));
  const want = [{ code: USAGE_GIFT, name: '揪團贈席' }, { code: USAGE_ERA, name: '年代售出' }, { code: USAGE_VOL, name: '志工席' }].filter((u) => !have.some((h) => h.code === u.code));
  if (want.length) have.push(...await db.insert(t.seatUsage).values(want.map((u) => ({ eventId, ...u, sellable: false }))).returning());
  return { gift: have.find((u) => u.code === USAGE_GIFT)!.id, era: have.find((u) => u.code === USAGE_ERA)!.id, vol: have.find((u) => u.code === USAGE_VOL)!.id };
}

/**
 * 後台塗三樓座位：贈席／年代售出／志工席／恢復可售。只改空位；已被選走的不動。
 * 揪團贈席只能在左2、右2（兩側斜區），塗到其他區的略過。
 */
export async function paintFloor3(db: Db, actor: string, kind: 'gift' | 'era' | 'vol' | 'sale', seatIds: string[]) {
  const ev = await ev0(db);
  const u = await joinUsages(db, ev.id);
  let usageId = kind === 'gift' ? u.gift : kind === 'era' ? u.era : kind === 'vol' ? u.vol : 0;
  if (kind === 'sale') {
    const [s] = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.eventId, ev.id), eq(t.seatUsage.sellable, true))).orderBy(t.seatUsage.id).limit(1);
    if (!s) throw new BookingError('INVALID', '找不到「可售」用途');
    usageId = s.id;
  }
  const ids = [...new Set(seatIds)];
  const rows = ids.length ? await db.select({ id: t.eventSeat.seatId, status: t.eventSeat.status, floor: t.venueSeat.floor, block: t.venueSeat.block }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids))) : [];
  const free = rows.filter((r) => r.floor === '3F' && r.status === 'free');
  const ok = free.filter((r) => kind !== 'gift' || GIFT_BLOCKS.includes(r.block)).map((r) => r.id);
  if (ok.length) await db.update(t.eventSeat).set({ usageId }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ok)));
  await db.insert(t.auditLog).values({ actor, action: 'join_paint', target: `event:${ev.id}`, detail: JSON.stringify({ kind, count: ok.length }) });
  return { updated: ok.length, skipped: ids.length - ok.length, notSide: free.length - ok.length };
}

/** 一鍵設定三樓：左2、右2 空位＝揪團贈席；左1、中、右1 空位＝年代售出。志工席、已被選走的不動 */
export async function presetFloor3(db: Db, actor: string, which: 'side' | 'middle') {
  const ev = await ev0(db);
  const u = await joinUsages(db, ev.id);
  const rows = await db.select({ id: t.eventSeat.seatId, usageId: t.eventSeat.usageId, block: t.venueSeat.block }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '3F'), eq(t.eventSeat.status, 'free')));
  const ids = rows.filter((r) => r.usageId !== u.vol && (which === 'side' ? GIFT_BLOCKS.includes(r.block) : !GIFT_BLOCKS.includes(r.block))).map((r) => r.id);
  return paintFloor3(db, actor, which === 'side' ? 'gift' : 'era', ids);
}

/* ---------- 團練場清單 ---------- */

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, 'zh-Hant');

/** 一次新增多個團練場（一行一個；已存在的同名略過） */
export async function addVenues(db: Db, actor: string, names: string[]) {
  const ev = await ev0(db);
  const want = [...new Set(names.map(clean).filter(Boolean))];
  if (!want.length) throw new BookingError('INVALID', '請填團練場名稱（一行一個）');
  if (want.some((n) => n.length > 30)) throw new BookingError('INVALID', '團練場名稱最多 30 字');
  const have = new Set((await db.select({ name: t.joinVenue.name }).from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id))).map((v) => v.name));
  const add = want.filter((n) => !have.has(n));
  if (add.length) await db.insert(t.joinVenue).values(add.map((name) => ({ eventId: ev.id, name, code: newCode(6) })));
  await db.insert(t.auditLog).values({ actor, action: 'join_venue_add', target: `event:${ev.id}`, detail: add.join('、') });
  return { added: add.length, skipped: want.length - add.length };
}

export async function updateVenue(db: Db, actor: string, id: number, v: { name?: string; active?: boolean }) {
  const ev = await ev0(db);
  const [cur] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.id, id), eq(t.joinVenue.eventId, ev.id)));
  if (!cur) throw new BookingError('NOT_FOUND', '找不到這個團練場');
  const set: Partial<typeof t.joinVenue.$inferInsert> = {};
  if (v.name !== undefined) {
    const name = clean(v.name);
    if (!name || name.length > 30) throw new BookingError('INVALID', '團練場名稱 1–30 字');
    const [dup] = await db.select({ id: t.joinVenue.id }).from(t.joinVenue).where(and(eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.name, name), ne(t.joinVenue.id, id)));
    if (dup) throw new BookingError('INVALID', `已有「${name}」，要合併請用「合併到」`);
    set.name = name;
  }
  if (v.active !== undefined) set.active = v.active;
  await db.update(t.joinVenue).set(set).where(eq(t.joinVenue.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_venue_update', target: `join_venue:${id}`, detail: JSON.stringify({ from: cur.name, ...v }) });
  return true;
}

/** 合併：把 from 的登記全部改到 into，再刪掉 from（例：「木柵」併入「台北木柵」） */
export async function mergeVenue(db: Db, actor: string, fromId: number, intoId: number) {
  if (fromId === intoId) throw new BookingError('INVALID', '不能合併到自己');
  const ev = await ev0(db);
  return db.transaction(async (tx) => {
    const vs = await tx.select().from(t.joinVenue).where(and(eq(t.joinVenue.eventId, ev.id), inArray(t.joinVenue.id, [fromId, intoId])));
    const from = vs.find((v) => v.id === fromId), into = vs.find((v) => v.id === intoId);
    if (!from || !into) throw new BookingError('NOT_FOUND', '找不到團練場');
    const both = await tx.select({ id: t.joinReg.id }).from(t.joinReg).where(and(inArray(t.joinReg.venueId, [fromId, intoId]), eq(t.joinReg.status, 'approved')));
    if (both.length > 1) throw new BookingError('INVALID', '兩邊都有已核准的負責人，請先把其中一份改回待審核或退回，再合併。');
    const moved = await tx.update(t.joinReg).set({ venueId: intoId }).where(eq(t.joinReg.venueId, fromId)).returning({ id: t.joinReg.id });
    await tx.delete(t.joinVenue).where(eq(t.joinVenue.id, fromId));
    await tx.insert(t.auditLog).values({ actor, action: 'join_venue_merge', target: `join_venue:${intoId}`, detail: `${from.name} → ${into.name}（${moved.length} 份登記）` });
    return { moved: moved.length };
  });
}

/** 刪除：只能刪沒有登記的（有登記的請改用合併或隱藏） */
export async function deleteVenue(db: Db, actor: string, id: number) {
  const [used] = await db.select({ id: t.joinReg.id }).from(t.joinReg).where(eq(t.joinReg.venueId, id)).limit(1);
  if (used) throw new BookingError('INVALID', '這個團練場已有登記，不能刪除；可以「合併到」別的團練場，或取消勾選「登記表顯示」');
  const [v] = await db.delete(t.joinVenue).where(eq(t.joinVenue.id, id)).returning();
  if (!v) throw new BookingError('NOT_FOUND', '找不到這個團練場');
  await db.insert(t.auditLog).values({ actor, action: 'join_venue_delete', target: `join_venue:${id}`, detail: v.name });
  return true;
}

/* ---------- 公開登記（負責人 4 欄） ---------- */

export const phone = z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字，例如 0912-345-678'));
export const email = z.string().transform((s) => s.trim()).pipe(z.string().min(1, '請填寫 Email（連結會寄到這裡）').max(120).regex(emailRe, 'Email 格式不正確'));
export const personName = z.string().transform(clean).pipe(z.string().min(1, '請填寫負責人姓名').max(30, '姓名最多 30 字'));

export const joinInput = z.object({
  venueId: z.number().int().positive().nullable().default(null),
  venueText: z.string().max(60).default('').transform(clean),
  headName: personName,
  headPhone: phone,
  email,
});
export type JoinInput = z.input<typeof joinInput>;

/** 登記頁要的資料（不含任何個資） */
export async function joinMenu(db: Db) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  const venues = s.open ? (await db.select({ id: t.joinVenue.id, name: t.joinVenue.name }).from(t.joinVenue)
    .where(and(eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.active, true)))).sort(byName) : [];
  return { open: s.open, contact: s.contact, event: { name: ev.name, showAt: ev.showAt.toISOString() }, venues };
}

const recent = new Map<string, number[]>();
/** 防灌：同一來源一段時間內最多 n 次 */
export function rateLimit(bucket: string, now: number, n = 20, ms = 600_000) {
  const list = (recent.get(bucket) ?? []).filter((x) => now - x < ms);
  if (list.length >= n) throw new BookingError('TOO_MANY', '送出太頻繁，請稍後再試。');
  list.push(now); recent.set(bucket, list);
}

export async function submitJoin(db: Db, raw: unknown, ip = '', now = new Date()) {
  const p = joinInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const x = p.data;
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  if (!s.open) throw new BookingError('SALE_CLOSED', '揪團登記目前尚未開放。');

  let venueId: number | null = null;
  let venueText = '';
  if (x.venueId) {
    const [v] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.id, x.venueId), eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.active, true)));
    if (!v) throw new BookingError('INVALID', '找不到這個團練場，請重新整理頁面再選一次');
    venueId = v.id;
  } else {
    if (!x.venueText) throw new BookingError('INVALID', '請選擇團練場，清單沒有的請選「其他」並填寫名稱');
    if (x.venueText.length > 30) throw new BookingError('INVALID', '團練場名稱最多 30 字');
    const [v] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.name, x.venueText)));
    if (v) venueId = v.id; else venueText = x.venueText;
  }

  rateLimit(`join:${ip}`, now.getTime());
  if (venueId) {
    const [taken] = await db.select({ id: t.joinReg.id }).from(t.joinReg).where(and(eq(t.joinReg.venueId, venueId), eq(t.joinReg.status, 'approved')));
    if (taken) throw new BookingError('INVALID', `這個團練場已經有負責人了。如需更換，請聯絡${s.contact}。`);
  }
  const [dup] = await db.select({ id: t.joinReg.id }).from(t.joinReg)
    .where(and(eq(t.joinReg.eventId, ev.id), ne(t.joinReg.status, 'rejected'), eq(t.joinReg.headPhone, x.headPhone)));
  if (dup) throw new BookingError('INVALID', `手機 ${fmtPhone(x.headPhone)} 已經登記過，不用再登記。資料要修改請聯絡${s.contact}。`);

  const [reg] = await db.insert(t.joinReg).values({ eventId: ev.id, venueId, venueText, headName: x.headName, headPhone: x.headPhone, email: x.email, ip, createdAt: now }).returning();
  await db.insert(t.auditLog).values({ actor: 'public', action: 'join_submit', target: `join_reg:${reg.id}`, detail: venueText || String(venueId) });
  return { id: reg.id, contact: s.contact };
}

/* ---------- 後台：登記審核 ---------- */

async function regOf(db: Db, id: number) {
  const [r] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, id));
  if (!r) throw new BookingError('NOT_FOUND', '找不到這份登記');
  return r;
}

/** 指定團練場（「其他」填的名字：選清單上的，或直接新增成清單上的） */
export async function setRegVenue(db: Db, actor: string, id: number, v: { venueId?: number; newName?: string }) {
  const r = await regOf(db, id);
  let venueId = v.venueId ?? null;
  if (!venueId) {
    const nm = clean(v.newName ?? r.venueText);
    if (!nm) throw new BookingError('INVALID', '請選團練場或填名稱');
    await addVenues(db, actor, [nm]).catch(() => undefined);
    const [x] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.eventId, r.eventId), eq(t.joinVenue.name, nm)));
    venueId = x?.id ?? null;
  }
  const [x] = venueId ? await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.id, venueId), eq(t.joinVenue.eventId, r.eventId))) : [];
  if (!x) throw new BookingError('NOT_FOUND', '找不到這個團練場');
  if (r.status === 'approved') {
    const [other] = await db.select({ id: t.joinReg.id }).from(t.joinReg).where(and(eq(t.joinReg.venueId, x.id), eq(t.joinReg.status, 'approved'), ne(t.joinReg.id, id)));
    if (other) throw new BookingError('INVALID', `「${x.name}」已有核准的負責人（第 ${other.id} 號）`);
  }
  await db.update(t.joinReg).set({ venueId: x.id }).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_venue', target: `join_reg:${id}`, detail: `${r.venueText || '（原清單）'} → ${x.name}` });
  return true;
}

/** 核准／退回／改回待審。退回必填原因；核准前要先指定清單上的團練場；一個團練場只能核准一位 */
export async function decideReg(db: Db, actor: string, id: number, status: 'approved' | 'rejected' | 'pending', reason = '', now = new Date()) {
  const r = await regOf(db, id);
  const why = clean(reason);
  if (status === 'rejected' && why.length < 2) throw new BookingError('INVALID', '請填寫退回原因');
  if (status !== 'approved' && r.status === 'approved') {
    const [used] = await db.select({ id: t.joinReport.id }).from(t.joinReport).where(eq(t.joinReport.regId, id)).limit(1);
    if (used) throw new BookingError('INVALID', '這個團練場已經有志工回報訂單，不能取消核准。要換負責人，請用「修改」改姓名、手機、Email。');
  }
  if (status === 'approved') {
    if (!r.venueId) throw new BookingError('INVALID', '這份登記的團練場不在清單上（填的是「其他」），請先指定團練場再核准');
    const [other] = await db.select({ id: t.joinReg.id }).from(t.joinReg).where(and(eq(t.joinReg.venueId, r.venueId), eq(t.joinReg.status, 'approved'), ne(t.joinReg.id, id)));
    if (other) throw new BookingError('INVALID', `這個團練場已有核准的負責人（第 ${other.id} 號）。一個團練場只能一位負責人。`);
  }
  if (status !== 'rejected') {
    const [dup] = await db.select({ id: t.joinReg.id }).from(t.joinReg)
      .where(and(eq(t.joinReg.eventId, r.eventId), ne(t.joinReg.status, 'rejected'), ne(t.joinReg.id, id), eq(t.joinReg.headPhone, r.headPhone)));
    if (dup) throw new BookingError('INVALID', `手機 ${fmtPhone(r.headPhone)} 已在第 ${dup.id} 號登記，請先處理那一份`);
  }
  const codes = status === 'approved' ? { reportCode: r.reportCode ?? newCode(), pickCode: r.pickCode ?? newCode(12) } : {};
  await db.update(t.joinReg).set({ status, reason: status === 'rejected' ? why : '', decidedAt: status === 'pending' ? null : now, decidedBy: status === 'pending' ? null : actor, ...codes })
    .where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: `join_reg_${status}`, target: `join_reg:${id}`, detail: why || null });
  return true;
}

export const regEditInput = z.object({
  headName: personName, headPhone: phone,
  email: z.string().max(120).default('').transform((s) => s.trim()),
  note: z.string().max(200).default('').transform((s) => s.trim()),
});

/** 後台修改登記（負責人姓名、手機、Email、備註）。換負責人也用這個 */
export async function editReg(db: Db, actor: string, id: number, raw: unknown) {
  const p = regEditInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const x = p.data;
  if (x.email && !emailRe.test(x.email)) throw new BookingError('INVALID', 'Email 格式不正確');
  const r = await regOf(db, id);
  await db.update(t.joinReg).set({ headName: x.headName, headPhone: x.headPhone, email: x.email, note: x.note }).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_edit', target: `join_reg:${id}`, detail: JSON.stringify({ from: [r.headName, r.headPhone, r.email], to: [x.headName, x.headPhone, x.email] }) });
  return true;
}

export async function deleteReg(db: Db, actor: string, id: number) {
  const r = await regOf(db, id);
  if (r.status !== 'rejected') throw new BookingError('INVALID', '只能刪除已退回的登記');
  await db.delete(t.joinReg).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_delete', target: `join_reg:${id}`, detail: r.headName });
  return true;
}

/** 換一條新的劃位連結（舊的失效，例如外流時） */
export async function renewPickCode(db: Db, actor: string, id: number) {
  const r = await regOf(db, id);
  if (r.status !== 'approved') throw new BookingError('INVALID', '只有已核准的登記有連結');
  await db.update(t.joinReg).set({ pickCode: newCode(12) }).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_renew', target: `join_reg:${id}`, detail: null });
  return true;
}

/* ---------- 寄連結 ---------- */

export const reportUrl = (base: string, code: string) => `${base}/join/r/${code}`;
export const pickUrl = (base: string, code: string) => `${base}/join/p/${code}`;

/** 寄出回報連結：ids 沒給＝所有已核准、還沒寄過的。沒有 Email 的略過（後台可複製連結用 LINE 傳）。劃位連結另外寄 */
export async function sendLinks(db: Db, actor: string, base: string, ids?: number[], now = new Date()) {
  const ev = await ev0(db);
  if (!base) throw new BookingError('INVALID', '還不知道網站網址，請從正式網址開啟後台再試');
  const s = await getJoinSettings(db);
  const regs = await db.select().from(t.joinReg).where(and(eq(t.joinReg.eventId, ev.id), eq(t.joinReg.status, 'approved'),
    ids?.length ? inArray(t.joinReg.id, ids) : undefined));
  const todo = regs.filter((r) => (ids?.length ? true : !r.linksSentAt));
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  let sent = 0, noEmail = 0;
  for (const r of todo) {
    if (!r.email || !r.reportCode) { noEmail++; continue; }
    const venue = vs.find((v) => v.id === r.venueId)?.name ?? '';
    const content = `【${ev.name}】${r.headName} 您好，感謝您擔任「${venue}」的揪團負責人。請把下面的回報連結轉給協助回報的志工：${reportUrl(base, r.reportCode)}　`
      + `先收後核：志工輸入年代訂單編號（「-」前面最後 4 碼即可，例如 ER2611120000109-1 輸入 0109，系統自動帶入當天日期；請當天買、當天回報）與張數後先登記為「待核對」，等年代名單更新後自動核對，核對通過才計入；劃位序依回報時間排列，越早回報越前面。`
      + `劃位連結會在劃位前另外寄給您。有疑義請洽${s.contact}。`;
    await db.insert(t.notification).values({ channel: 'email', template: 'join_rlink', recipient: r.email, content });
    await db.update(t.joinReg).set({ linksSentAt: now }).where(eq(t.joinReg.id, r.id));
    sent++;
  }
  await db.insert(t.auditLog).values({ actor, action: 'join_links_send', target: `event:${ev.id}`, detail: JSON.stringify({ sent, noEmail }) });
  return { sent, noEmail };
}

/** 寄出劃位連結：劃位序鎖定後才寄，只寄給有劃位序的團練場。ids 沒給＝還沒寄過的 */
export async function sendPickLinks(db: Db, actor: string, base: string, ids?: number[], now = new Date()) {
  const ev = await ev0(db);
  if (!base) throw new BookingError('INVALID', '還不知道網站網址，請從正式網址開啟後台再試');
  const s = await getJoinSettings(db);
  const slots = await db.select({ regId: t.joinSlot.regId, no: t.joinSlot.no, status: t.joinSlot.status }).from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id));
  if (!slots.length) throw new BookingError('INVALID', '劃位序還沒鎖定，請先到「回報」按「鎖定劃位序」。');
  const regs = await db.select().from(t.joinReg).where(and(eq(t.joinReg.eventId, ev.id), eq(t.joinReg.status, 'approved'),
    ids?.length ? inArray(t.joinReg.id, ids) : undefined));
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  let sent = 0, noEmail = 0;
  for (const r of regs) {
    const mine = slots.filter((x) => x.regId === r.id && x.status !== 'void').map((x) => x.no).sort((a, b) => a - b);
    if (!mine.length || (!ids?.length && r.pickSentAt)) continue;
    if (!r.email || !r.pickCode) { noEmail++; continue; }
    const venue = vs.find((v) => v.id === r.venueId)?.name ?? '';
    const content = `【${ev.name}】${r.headName} 您好，「${venue}」的劃位序已確定：第 ${mine.join('、')} 號，可選 ${mine.length} 席。`
      + `劃位連結（只給您本人，請勿轉傳）：${pickUrl(base, r.pickCode)}　`
      + `快輪到時、輪到時都會再寄信通知；輪到後請在 ${s.turnMin} 分鐘內打開。有疑義請洽${s.contact}。`;
    await db.insert(t.notification).values({ channel: 'email', template: 'join_plink', recipient: r.email, content });
    await db.update(t.joinReg).set({ pickSentAt: now }).where(eq(t.joinReg.id, r.id));
    sent++;
  }
  await db.insert(t.auditLog).values({ actor, action: 'join_pick_links_send', target: `event:${ev.id}`, detail: JSON.stringify({ sent, noEmail }) });
  return { sent, noEmail };
}

/** 寄一封通知給負責人（沒有 Email 就不寄） */
export async function mailHead(db: Db, reg: { email: string }, template: string, content: string) {
  if (!reg.email) return;
  await db.insert(t.notification).values({ channel: 'email', template, recipient: reg.email, content });
}

/* ---------- 後台狀態（登記、團練場） ---------- */

export async function joinRegState(db: Db, base: string) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return { venues: [], regs: [] };
  const venues = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  const regs = await db.select().from(t.joinReg).where(eq(t.joinReg.eventId, ev.id)).orderBy(desc(t.joinReg.id));
  const vName = new Map(venues.map((v) => [v.id, v.name]));
  const count = (id: number, status?: string) => regs.filter((r) => r.venueId === id && (!status || r.status === status)).length;
  return {
    venues: venues.sort(byName).map((v) => ({ id: v.id, name: v.name, active: v.active, regs: count(v.id), approved: count(v.id, 'approved') })),
    regs: regs.map((r) => ({
      id: r.id, venueId: r.venueId, venueName: r.venueId ? vName.get(r.venueId) ?? '' : r.venueText, venueText: r.venueText,
      headName: r.headName, headPhone: r.headPhone, email: r.email, status: r.status, reason: r.reason, note: r.note,
      createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, decidedBy: r.decidedBy,
      linksSentAt: r.linksSentAt?.toISOString() ?? null, pickSentAt: r.pickSentAt?.toISOString() ?? null,
      reportUrl: r.reportCode && base ? reportUrl(base, r.reportCode) : '', pickUrl: r.pickCode && base ? pickUrl(base, r.pickCode) : '',
    })),
  };
}

