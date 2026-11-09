/**
 * 揪團贈票（銀區＝三樓，買十送一）第一階段：揪團登記。
 *
 * - 公開登記頁 /join：選團練場（或填「其他」）、負責人、揪團人（可同負責人、可多位）、個資同意。
 * - 後台「十二、揪團贈票」：開關、團練場清單、審核登記（核准／退回，退回必填原因）。
 * - 這一階段不寄任何信：揪團人連結與團練場回報連結在第二階段才會用到（code 先產生好）。
 * - 開關預設關閉；關閉時登記頁只顯示「目前尚未開放」。
 */
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { normalizePhone } from './validation';

export const JOIN_MAX_LEADERS = 10;
const KEY_OPEN = 'join.open';
const KEY_CONTACT = 'join.contact';
const DEFAULT_CONTACT = '主辦方';

const newCode = (n = 9) => randomBytes(n).toString('base64url');
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/* ---------- 設定 ---------- */

export async function getJoinSettings(db: Db) {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [KEY_OPEN, KEY_CONTACT]));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  return { open: v(KEY_OPEN) === '1', contact: v(KEY_CONTACT)?.trim() || DEFAULT_CONTACT };
}

export async function setJoinSettings(db: Db, actor: string, x: { open?: boolean; contact?: string }) {
  const put = (key: string, value: string) => db.insert(t.appSetting).values({ key, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  if (x.open !== undefined) await put(KEY_OPEN, x.open ? '1' : '0');
  if (x.contact !== undefined) await put(KEY_CONTACT, clean(x.contact).slice(0, 60));
  await db.insert(t.auditLog).values({ actor, action: 'join_settings', target: 'app_setting', detail: JSON.stringify(x) });
  return getJoinSettings(db);
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

/* ---------- 公開登記 ---------- */

const phone = z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字，例如 0912-345-678'));
const name = (label: string) => z.string().transform(clean).pipe(z.string().min(1, `請填寫${label}姓名`).max(30, `${label}姓名最多 30 字`));
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const joinInput = z.object({
  venueId: z.number().int().positive().nullable().default(null),
  venueText: z.string().max(60).default('').transform(clean),
  headName: name('負責人'),
  headPhone: phone,
  leaders: z.array(z.object({
    sameAsHead: z.boolean().default(false),
    name: z.string().max(60).default(''),
    phone: z.string().max(30).default(''),
    email: z.string().max(120).default('').transform((s) => s.trim()),
    noEmail: z.boolean().default(false),
  })).min(1, '請至少填一位揪團人').max(JOIN_MAX_LEADERS, `一份最多 ${JOIN_MAX_LEADERS} 位揪團人`),
  consent: z.literal(true, { errorMap: () => ({ message: '請勾選同意提供資料' }) }),
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
/** 防灌：同一來源 10 分鐘內最多 20 份 */
function rateLimit(ip: string, now: number) {
  const list = (recent.get(ip) ?? []).filter((x) => now - x < 600_000);
  if (list.length >= 20) throw new BookingError('TOO_MANY', '送出太頻繁，請稍後再試。');
  list.push(now); recent.set(ip, list);
}

export async function submitJoin(db: Db, raw: unknown, ip = '', now = new Date()) {
  const p = joinInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const x = p.data;
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  if (!s.open) throw new BookingError('SALE_CLOSED', '揪團登記目前尚未開放。');

  // 團練場：選清單（要還在顯示）或填「其他」
  let venueId: number | null = null;
  let venueText = '';
  if (x.venueId) {
    const [v] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.id, x.venueId), eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.active, true)));
    if (!v) throw new BookingError('INVALID', '找不到這個團練場，請重新整理頁面再選一次');
    venueId = v.id;
  } else {
    if (!x.venueText) throw new BookingError('INVALID', '請選擇團練場，清單沒有的請選「其他」並填寫名稱');
    if (x.venueText.length > 30) throw new BookingError('INVALID', '團練場名稱最多 30 字');
    // 打的名字剛好在清單上：直接用清單的
    const [v] = await db.select().from(t.joinVenue).where(and(eq(t.joinVenue.eventId, ev.id), eq(t.joinVenue.name, x.venueText)));
    if (v) venueId = v.id; else venueText = x.venueText;
  }

  // 揪團人：同負責人的帶入負責人姓名、手機
  const leaders = x.leaders.map((l, i) => {
    const n = i + 1;
    const nm = l.sameAsHead ? x.headName : clean(l.name);
    const ph = l.sameAsHead ? x.headPhone : normalizePhone(l.phone);
    if (!nm) throw new BookingError('INVALID', `請填寫第 ${n} 位揪團人的姓名`);
    if (nm.length > 30) throw new BookingError('INVALID', `第 ${n} 位揪團人的姓名最多 30 字`);
    if (!/^09\d{8}$/.test(ph)) throw new BookingError('INVALID', `第 ${n} 位揪團人的手機應為 09 開頭的 10 位數字`);
    if (!l.noEmail && !l.email) throw new BookingError('INVALID', `請填寫第 ${n} 位揪團人的 Email（沒有請勾「沒有 Email」）`);
    if (!l.noEmail && !emailRe.test(l.email)) throw new BookingError('INVALID', `第 ${n} 位揪團人的 Email 格式不正確`);
    return { name: nm, phone: ph, email: l.noEmail ? '' : l.email, noEmail: l.noEmail, sameAsHead: l.sameAsHead };
  });
  if (leaders.filter((l) => l.sameAsHead).length > 1) throw new BookingError('INVALID', '「同負責人」只能勾一位');
  const phones = leaders.map((l) => l.phone);
  if (new Set(phones).size !== phones.length) throw new BookingError('INVALID', '同一份登記裡，揪團人的手機重複了');

  // 已登記過的揪團人（待審或已核准）不再收：避免重複
  rateLimit(ip, now.getTime()); // 先算次數：避免有人拿手機號碼一直試
  // 只說哪一支手機重複，不回傳別人的姓名
  const dup = await db.select({ phone: t.joinLeader.phone }).from(t.joinLeader)
    .innerJoin(t.joinReg, eq(t.joinReg.id, t.joinLeader.regId))
    .where(and(eq(t.joinReg.eventId, ev.id), ne(t.joinReg.status, 'rejected'), inArray(t.joinLeader.phone, phones)));
  if (dup.length) {
    throw new BookingError('INVALID', `手機 ${dup[0].phone.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')} 已經登記過揪團人，不用再登記。資料要修改請聯絡${s.contact}。`);
  }

  return db.transaction(async (tx) => {
    const [reg] = await tx.insert(t.joinReg).values({ eventId: ev.id, venueId, venueText, headName: x.headName, headPhone: x.headPhone, ip, createdAt: now }).returning();
    await tx.insert(t.joinLeader).values(leaders.map((l) => ({ ...l, regId: reg.id, code: newCode(), createdAt: now })));
    await tx.insert(t.auditLog).values({ actor: 'public', action: 'join_submit', target: `join_reg:${reg.id}`, detail: `${leaders.length} 位揪團人` });
    return { id: reg.id, contact: s.contact };
  });
}

/* ---------- 後台 ---------- */

export async function joinAdminState(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  const settings = await getJoinSettings(db);
  if (!ev) return { settings, venues: [], regs: [] };
  const venues = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  const regs = await db.select().from(t.joinReg).where(eq(t.joinReg.eventId, ev.id)).orderBy(desc(t.joinReg.id));
  const leaders = regs.length ? await db.select().from(t.joinLeader).where(inArray(t.joinLeader.regId, regs.map((r) => r.id))).orderBy(asc(t.joinLeader.id)) : [];
  const vName = new Map(venues.map((v) => [v.id, v.name]));
  const count = (id: number, status?: string) => regs.filter((r) => r.venueId === id && (!status || r.status === status)).length;
  const leadersOf = (id: number) => leaders.filter((l) => l.regId === id);
  return {
    settings,
    venues: venues.sort(byName).map((v) => ({
      id: v.id, name: v.name, active: v.active, regs: count(v.id), approved: count(v.id, 'approved'),
      leaders: regs.filter((r) => r.venueId === v.id && r.status === 'approved').reduce((n, r) => n + leadersOf(r.id).length, 0),
    })),
    regs: regs.map((r) => ({
      id: r.id, venueId: r.venueId, venueName: r.venueId ? vName.get(r.venueId) ?? '' : '', venueText: r.venueText,
      headName: r.headName, headPhone: r.headPhone, status: r.status, reason: r.reason, note: r.note,
      createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, decidedBy: r.decidedBy,
      leaders: leadersOf(r.id).map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, noEmail: l.noEmail, sameAsHead: l.sameAsHead })),
    })),
  };
}

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
  await db.update(t.joinReg).set({ venueId: x.id }).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_venue', target: `join_reg:${id}`, detail: `${r.venueText || '（原清單）'} → ${x.name}` });
  return true;
}

/** 核准／退回／改回待審。退回必填原因；核准前要先指定清單上的團練場 */
export async function decideReg(db: Db, actor: string, id: number, status: 'approved' | 'rejected' | 'pending', reason = '', now = new Date()) {
  const r = await regOf(db, id);
  const why = clean(reason);
  if (status === 'rejected' && why.length < 2) throw new BookingError('INVALID', '請填寫退回原因');
  if (status === 'approved' && !r.venueId) throw new BookingError('INVALID', '這份登記的團練場不在清單上（填的是「其他」），請先指定團練場再核准');
  if (status !== 'rejected') {
    // 退回後再恢復：揪團人手機可能已在別份登記
    const mine = await db.select({ phone: t.joinLeader.phone }).from(t.joinLeader).where(eq(t.joinLeader.regId, id));
    const dup = mine.length ? await db.select({ phone: t.joinLeader.phone, regId: t.joinLeader.regId }).from(t.joinLeader)
      .innerJoin(t.joinReg, eq(t.joinReg.id, t.joinLeader.regId))
      .where(and(eq(t.joinReg.eventId, r.eventId), ne(t.joinReg.status, 'rejected'), ne(t.joinReg.id, id), inArray(t.joinLeader.phone, mine.map((m) => m.phone)))) : [];
    if (dup.length) throw new BookingError('INVALID', `手機 ${dup[0].phone} 已在第 ${dup[0].regId} 號登記，請先處理那一份`);
  }
  await db.update(t.joinReg).set({ status, reason: status === 'rejected' ? why : '', decidedAt: status === 'pending' ? null : now, decidedBy: status === 'pending' ? null : actor })
    .where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: `join_reg_${status}`, target: `join_reg:${id}`, detail: why || null });
  return true;
}

/** 後台修改登記內容（負責人、揪團人、備註）。揪團人可增可減，至少一位 */
export const regEditInput = z.object({
  headName: name('負責人'),
  headPhone: phone,
  note: z.string().max(200).default('').transform((s) => s.trim()),
  leaders: z.array(z.object({
    id: z.number().int().positive().optional(),
    name: name('揪團人'),
    phone,
    email: z.string().max(120).default('').transform((s) => s.trim()),
    noEmail: z.boolean().default(false),
  })).min(1, '至少要有一位揪團人').max(JOIN_MAX_LEADERS),
});

export async function editReg(db: Db, actor: string, id: number, raw: unknown) {
  const p = regEditInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const x = p.data;
  const r = await regOf(db, id);
  for (const l of x.leaders) {
    if (!l.noEmail && l.email && !emailRe.test(l.email)) throw new BookingError('INVALID', `${l.name} 的 Email 格式不正確`);
  }
  const phones = x.leaders.map((l) => l.phone);
  if (new Set(phones).size !== phones.length) throw new BookingError('INVALID', '揪團人的手機重複了');
  if (r.status !== 'rejected') {
    const dup = await db.select({ phone: t.joinLeader.phone, regId: t.joinLeader.regId }).from(t.joinLeader)
      .innerJoin(t.joinReg, eq(t.joinReg.id, t.joinLeader.regId))
      .where(and(eq(t.joinReg.eventId, r.eventId), ne(t.joinReg.status, 'rejected'), ne(t.joinReg.id, id), inArray(t.joinLeader.phone, phones)));
    if (dup.length) throw new BookingError('INVALID', `手機 ${dup[0].phone} 已在第 ${dup[0].regId} 號登記`);
  }
  await db.transaction(async (tx) => {
    await tx.update(t.joinReg).set({ headName: x.headName, headPhone: x.headPhone, note: x.note }).where(eq(t.joinReg.id, id));
    const cur = await tx.select().from(t.joinLeader).where(eq(t.joinLeader.regId, id));
    const keep = new Set(x.leaders.map((l) => l.id).filter(Boolean));
    const gone = cur.filter((c) => !keep.has(c.id)).map((c) => c.id);
    if (gone.length) await tx.delete(t.joinLeader).where(inArray(t.joinLeader.id, gone));
    for (const l of x.leaders) {
      const v = { name: l.name, phone: l.phone, email: l.noEmail ? '' : l.email, noEmail: l.noEmail, sameAsHead: l.name === x.headName && l.phone === x.headPhone };
      if (l.id && cur.some((c) => c.id === l.id)) await tx.update(t.joinLeader).set(v).where(eq(t.joinLeader.id, l.id));
      else await tx.insert(t.joinLeader).values({ ...v, regId: id, code: newCode() });
    }
    await tx.insert(t.auditLog).values({ actor, action: 'join_reg_edit', target: `join_reg:${id}`, detail: `${x.leaders.length} 位揪團人` });
  });
  return true;
}

export async function deleteReg(db: Db, actor: string, id: number) {
  const r = await regOf(db, id);
  if (r.status !== 'rejected') throw new BookingError('INVALID', '只能刪除已退回的登記');
  await db.delete(t.joinReg).where(eq(t.joinReg.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'join_reg_delete', target: `join_reg:${id}`, detail: r.headName });
  return true;
}
