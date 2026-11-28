/**
 * 驗票志工管理（11/29 使用者）：
 *  - 驗票負責人：用專屬管理連結（/crew/m/<token>，可加入主畫面當 APP）招募、分配位置、寄驗票連結、看當天狀況。
 *  - 志工：用報名連結（/crew/j/<token>）填姓名、Email、電話；之後只拿自己的驗票連結（＝一個位置一條 gate 連結）。
 *  - 一個位置（gate）一人。換人時若舊連結已寄出／LINE 傳過，自動換新連結（舊連結立即失效）。
 *  - 寄信一定要負責人按；伺服器再檢查一次：只寄給已分配、有 Email、還沒寄過（或位置／連結已改）的人。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { createGates } from './ticket';
import { liveAt } from './practice';
import { isValidEmail } from './validation';

const LEAD_KEY = 'crew.lead';
export const ONLINE_MS = 60_000; // 驗票頁每 20 秒回報一次；1 分鐘內有回報＝在線

type Dev = { h: string; exp: string };
export interface LeadCfg {
  name: string; email: string; lineId: string; token: string; joinToken: string; active: boolean;
  /** 管理頁要驗證負責人 Email（11-29 使用者：只給固定的人用）；通過的手機記到演出當天 23:00 */
  otp?: { h: string; exp: string; tries: number; at: string }; devices: Dev[];
}
const EMPTY: LeadCfg = { name: '', email: '', lineId: '', token: '', joinToken: '', active: true, devices: [] };
const OTP_MIN = 10;
const OTP_TRIES = 5;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const maskEmail = (e: string) => { const [u, d] = e.split('@'); return d ? `${u.slice(0, 1)}***@${d}` : ''; };

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
const newToken = () => randomBytes(15).toString('base64url');
const clean = (s: unknown, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanEmail = (s: unknown) => String(s ?? '').trim().toLowerCase().slice(0, 120);

export async function getLead(db: Db): Promise<LeadCfg> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, LEAD_KEY));
  try { return r?.value ? { ...EMPTY, devices: [], ...JSON.parse(r.value) } : { ...EMPTY, devices: [] }; } catch { return { ...EMPTY, devices: [] }; }
}
async function putLead(db: Db, v: LeadCfg) {
  await db.insert(t.appSetting).values({ key: LEAD_KEY, value: JSON.stringify(v) }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: JSON.stringify(v) } });
}

/* ---------- 後台（系統管理員）：設定負責人、連結 ---------- */

export async function leadAdminView(db: Db) {
  const l = await getLead(db);
  const ev = await ev0(db);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.crew).where(and(eq(t.crew.eventId, ev.id), eq(t.crew.removed, false)));
  return { name: l.name, email: l.email, lineId: l.lineId, token: l.token, joinToken: l.joinToken, active: l.active, crew: n, devices: l.devices.filter((d) => Date.parse(d.exp) > Date.now()).length };
}

export async function saveLead(db: Db, actor: string, v: { name: string; email: string; lineId: string }) {
  const cur = await getLead(db);
  const email = cleanEmail(v.email);
  if (email && !isValidEmail(email)) throw new BookingError('INVALID', 'Email 格式不正確');
  // 換了負責人 Email：已驗證的手機全部要重新驗證
  const next: LeadCfg = { ...cur, name: clean(v.name, 40), email, lineId: clean(v.lineId, 40), token: cur.token || newToken(), joinToken: cur.joinToken || newToken(),
    ...(email !== cur.email ? { devices: [], otp: undefined } : {}) };
  await putLead(db, next);
  await db.insert(t.auditLog).values({ actor, action: 'crew_lead_save', target: LEAD_KEY, detail: JSON.stringify({ name: next.name, email: next.email, lineId: next.lineId }) });
  return leadAdminView(db);
}

/** 換新連結：which＝manage（負責人管理）或 join（志工報名）；舊連結立即失效 */
export async function renewLeadLink(db: Db, actor: string, which: 'manage' | 'join') {
  const cur = await getLead(db);
  const next = { ...cur, ...(which === 'manage' ? { token: newToken(), devices: [], otp: undefined } : { joinToken: newToken() }) };
  await putLead(db, next);
  await db.insert(t.auditLog).values({ actor, action: 'crew_lead_renew', target: LEAD_KEY, detail: which });
  return leadAdminView(db);
}

export async function setLeadActive(db: Db, actor: string, active: boolean) {
  const cur = await getLead(db);
  await putLead(db, { ...cur, active });
  await db.insert(t.auditLog).values({ actor, action: 'crew_lead_active', target: LEAD_KEY, detail: String(active) });
  return leadAdminView(db);
}

/** 寄管理連結給負責人（系統管理員按才寄） */
export async function mailLead(db: Db, actor: string, base: string) {
  const l = await getLead(db);
  if (!l.token || !l.email) throw new BookingError('INVALID', '請先填負責人 Email 並儲存');
  const ev = await ev0(db);
  const content = `【${ev.name}】${l.name || '負責人'} 您好，這是您的驗票管理連結，請用手機開啟：${base}/crew/m/${l.token}　開啟後可以「加入主畫面」，之後就像 APP 一樣從桌面打開。　在「招募」分頁可以把志工報名連結分享到 LINE；志工報名後，在「分配」把每個人排到位置，再到「發送」寄出驗票連結。　第一次打開要輸入您的 Email（${l.email}）收驗證碼，驗證過的手機可以用到演出當天。加入主畫面後，請在主畫面的 APP 裡再驗證一次。此連結請勿轉傳。`;
  const [n] = await db.insert(t.notification).values({ channel: 'email', template: 'crew_lead', recipient: l.email, content }).returning({ id: t.notification.id });
  await db.insert(t.auditLog).values({ actor, action: 'crew_lead_mail', target: LEAD_KEY, detail: JSON.stringify({ to: l.email, notif: n.id }) });
  return { to: l.email };
}

/* ---------- 志工報名（公開連結） ---------- */

async function byJoinToken(db: Db, token: string) {
  const l = await getLead(db);
  if (!l.joinToken || token !== l.joinToken) throw new BookingError('LINK_NOT_FOUND', '報名連結不存在或已換新，請向驗票負責人索取新連結。');
  if (!l.active) throw new BookingError('LINK_DISABLED', '報名已暫停，請聯絡驗票負責人。');
  return l;
}

export async function joinInfo(db: Db, token: string) {
  const l = await byJoinToken(db, token);
  const ev = await ev0(db);
  return { event: ev.name, showAt: ev.showAt.toISOString(), leadName: l.name, lineId: l.lineId };
}

/** 報名：同一個 Email 再填一次＝更新姓名、電話（不改位置） */
export async function crewSignup(db: Db, token: string, v: { name: string; email: string; phone: string }, now = new Date()) {
  await byJoinToken(db, token);
  const ev = await ev0(db);
  const name = clean(v.name, 40);
  const email = cleanEmail(v.email);
  const phone = String(v.phone ?? '').replace(/[^\d+]/g, '').slice(0, 20);
  if (!name) throw new BookingError('INVALID', '請填姓名');
  if (!isValidEmail(email)) throw new BookingError('INVALID', 'Email 格式不正確');
  if (phone.replace(/\D/g, '').length < 8) throw new BookingError('INVALID', '請填手機號碼');
  const [old] = await db.select().from(t.crew).where(and(eq(t.crew.eventId, ev.id), eq(t.crew.email, email)));
  if (old) {
    await db.update(t.crew).set({ name, phone, removed: false, updatedAt: now }).where(eq(t.crew.id, old.id));
    return { code: old.code, again: true };
  }
  const code = randomBytes(9).toString('base64url');
  await db.insert(t.crew).values({ eventId: ev.id, code, name, email, phone, createdAt: now, updatedAt: now });
  await db.insert(t.auditLog).values({ actor: `志工報名:${name}`, action: 'crew_signup', target: `crew:${email}`, detail: JSON.stringify({ name, phone }) });
  return { code, again: false };
}

/** 報名完成頁按「加負責人 LINE 好友」 */
export async function crewFriend(db: Db, token: string, code: string) {
  await byJoinToken(db, token);
  await db.update(t.crew).set({ friend: true }).where(eq(t.crew.code, String(code).slice(0, 40)));
  return { ok: true };
}

/* ---------- 負責人管理頁 ---------- */

async function byToken(db: Db, token: string, admin = false) {
  const l = await getLead(db);
  if (!l.token || token !== l.token) throw new BookingError('LINK_NOT_FOUND', '管理連結不存在或已換新，請向系統管理員索取新連結。');
  if (!l.active && !admin) throw new BookingError('LINK_DISABLED', '管理連結已停用。');
  return l;
}

/**
 * 誰在操作：負責人（這支手機驗證過 Email 的通行碼）或已登入後台的系統管理員（不用驗證碼，停用中也能看；
 * 紀錄記系統管理員本人）。由 API 依後台登入 cookie 判斷，前端送不進來。
 */
export type CrewAuth = string | { admin: string };
async function authed(db: Db, token: string, auth: CrewAuth, now: Date) {
  if (typeof auth === 'object') return { l: await byToken(db, token, true), actor: `系統管理員:${auth.admin}`, asAdmin: true };
  const l = await byToken(db, token);
  const h = sha(auth || '-');
  if (!auth || !l.devices.some((d) => d.h === h && Date.parse(d.exp) > now.getTime())) throw new BookingError('AUTH', '請先驗證 Email。');
  return { l, actor: `驗票負責人:${l.name || '負責人'}`, asAdmin: false };
}

/** 驗證頁用：只回負責人稱呼與遮住的 Email */
export async function leadGate(db: Db, token: string) {
  const l = await byToken(db, token);
  const ev = await ev0(db);
  return { event: ev.name, leadName: l.name, email: maskEmail(l.email), ready: !!l.email };
}

/** 寄驗證碼：Email 要跟後台設定的一樣；60 秒內不重寄 */
export async function sendLeadOtp(db: Db, token: string, email: string, now = new Date(), base = '') {
  const l = await byToken(db, token);
  if (!l.email) throw new BookingError('INVALID', '系統管理員還沒設定負責人 Email。');
  if (cleanEmail(email) !== l.email) throw new BookingError('INVALID', '這個 Email 沒有權限，請確認是主辦方登記的負責人 Email。');
  if (l.otp && now.getTime() - Date.parse(l.otp.at) < 60_000) throw new BookingError('TOO_MANY', '驗證碼剛寄出，請 1 分鐘後再試。');
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  l.otp = { h: sha(`${l.token}:${otp}`), exp: new Date(now.getTime() + OTP_MIN * 60_000).toISOString(), tries: 0, at: now.toISOString() };
  await putLead(db, l);
  const ev = await ev0(db);
  await db.insert(t.notification).values({ channel: 'email', template: 'crew_otp', recipient: l.email,
    content: `【${ev.name}】${l.name || '負責人'} 您好，驗票管理頁的驗證碼是 ${otp}，${OTP_MIN} 分鐘內有效。請回到驗票管理頁輸入驗證碼。如果不是您本人操作，請忽略這封信。${base ? `${base.replace(/\/$/, '')}/crew/m/${l.token}` : ''}` });
  return { sentTo: maskEmail(l.email) };
}

/** 驗證：通過後回傳這支手機的通行碼（記到演出當天 23:00） */
export async function verifyLeadOtp(db: Db, token: string, otp: string, now = new Date()) {
  const l = await byToken(db, token);
  if (!l.otp || Date.parse(l.otp.exp) < now.getTime()) throw new BookingError('INVALID', '驗證碼已過期，請重新寄送。');
  if (l.otp.tries >= OTP_TRIES) throw new BookingError('INVALID', '錯太多次了，請重新寄送驗證碼。');
  if (sha(`${l.token}:${String(otp).trim()}`) !== l.otp.h) {
    l.otp.tries++;
    await putLead(db, l);
    throw new BookingError('INVALID', `驗證碼不對（還可以試 ${OTP_TRIES - l.otp.tries} 次）。`);
  }
  const dev = randomBytes(24).toString('base64url');
  const ev = await ev0(db);
  const day = ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const end = new Date(`${day}T23:00:00+08:00`).getTime();
  const until = now.getTime() < end ? end : now.getTime() + 86400_000;
  l.otp = undefined;
  l.devices = [...l.devices.filter((d) => Date.parse(d.exp) > now.getTime()), { h: sha(dev), exp: new Date(until).toISOString() }].slice(-10);
  await putLead(db, l);
  await db.insert(t.auditLog).values({ actor: `驗票負責人:${l.name || '負責人'}`, action: 'crew_lead_verify', target: LEAD_KEY, detail: '' });
  return { token: dev };
}

const sentKey = (g: { id: number; token: string }) => `${g.id}|${g.token}`;
const lineText = (ev: string, name: string, pos: string, url: string, base: string) =>
  `${name} 您好，\n12/9「${ev}」您負責 ${pos} 驗票。\n您的驗票連結（只給您用，請勿轉傳）：\n${url}\n點開 → 按「開始掃描」→ 允許相機。17:00 以前掃都算練習，可以先掃自己的票試試。\n練習單：${base}/crew/practice`;

/** 管理頁資料 */
export async function leadState(db: Db, token: string, auth: CrewAuth, base: string, now = new Date()) {
  const { l, asAdmin } = await authed(db, token, auth, now);
  const ev = await ev0(db);
  const live = await liveAt(db);
  const crew = await db.select().from(t.crew).where(and(eq(t.crew.eventId, ev.id), eq(t.crew.removed, false))).orderBy(t.crew.id);
  const gates = await db.select().from(t.gate).where(eq(t.gate.eventId, ev.id)).orderBy(t.gate.sort, t.gate.id);
  const real = await db.select({ g: t.checkin.gateId, n: sql<number>`count(*)::int` }).from(t.checkin).where(eq(t.checkin.eventId, ev.id)).groupBy(t.checkin.gateId);
  const prac = await db.select({ g: t.checkinPractice.gateId, n: sql<number>`(count(*) filter (where ${t.checkinPractice.result} = 'ok'))::int`, all: sql<number>`count(*)::int`, kinds: sql<string[]>`array_agg(distinct ${t.checkinPractice.kind})` })
    .from(t.checkinPractice).where(eq(t.checkinPractice.eventId, ev.id)).groupBy(t.checkinPractice.gateId);
  const notifIds = crew.map((c) => c.mailNotifId).filter((x): x is number => !!x);
  const notifs = notifIds.length ? await db.select({ id: t.notification.id, status: t.notification.status, error: t.notification.error, at: t.notification.sentAt, created: t.notification.createdAt }).from(t.notification).where(inArray(t.notification.id, notifIds)) : [];
  const positions = gates.map((g) => {
    const c = crew.find((x) => x.gateId === g.id);
    const p = prac.find((x) => x.g === g.id);
    return {
      id: g.id, name: g.name, active: g.active, crewId: c?.id ?? null, crewName: c?.name ?? '',
      openedAt: g.openedAt?.toISOString() ?? null, seenAt: g.seenAt?.toISOString() ?? null,
      online: !!g.seenAt && now.getTime() - g.seenAt.getTime() < ONLINE_MS,
      here: real.find((x) => x.g === g.id)?.n ?? 0, prac: p?.n ?? 0, pracAll: p?.all ?? 0, kinds: (p?.kinds ?? []).filter(Boolean),
    };
  });
  return {
    event: ev.name, showAt: ev.showAt.toISOString(), liveAt: live.toISOString(), practice: now < live, now: now.toISOString(),
    asAdmin, lead: { name: l.name, lineId: l.lineId }, joinUrl: `${base}/crew/j/${l.joinToken}`, practiceUrl: `${base}/crew/practice`,
    positions,
    crew: crew.map((c) => {
      const g = gates.find((x) => x.id === c.gateId);
      const n = notifs.find((x) => x.id === c.mailNotifId);
      const url = g ? `${base}/scan/${g.token}` : '';
      return {
        id: c.id, name: c.name, email: c.email, phone: c.phone, friend: c.friend, gateId: c.gateId, gateName: g?.name ?? '',
        mail: n ? { status: n.status, error: n.error ?? '', at: (n.at ?? n.created).toISOString() } : null,
        mailStale: !!c.mailNotifId && (!g || c.mailedGate !== sentKey(g)),
        lineAt: c.lineAt?.toISOString() ?? null,
        line: g ? lineText(ev.name, c.name, g.name, url, base) : '',
        createdAt: c.createdAt.toISOString(),
      };
    }),
  };
}

/** 要寄驗票連結的人：已分配、有 Email、還沒寄過，或位置／連結改過 */
async function toMail(db: Db, eventId: number) {
  const crew = await db.select().from(t.crew).where(and(eq(t.crew.eventId, eventId), eq(t.crew.removed, false)));
  const gates = await db.select().from(t.gate).where(eq(t.gate.eventId, eventId));
  return crew.flatMap((c) => {
    const g = gates.find((x) => x.id === c.gateId);
    if (!g || !g.active || !isValidEmail(c.email)) return [];
    if (c.mailNotifId && c.mailedGate === sentKey(g)) return [];
    return [{ crew: c, gate: g }];
  });
}

async function queueCrewMail(db: Db, actor: string, base: string, ev: { name: string }, c: typeof t.crew.$inferSelect, g: typeof t.gate.$inferSelect) {
  const url = `${base}/scan/${g.token}`;
  const content = `【${ev.name}】${c.name} 您好，12/9 您負責「${g.name}」驗票。請點以下連結開啟您的驗票頁（只給您用，請勿轉傳）：${url}　請先點開一次，按「開始掃描」並允許使用相機。　正式驗票時間以前掃描都只算練習、不會影響入場，可以先掃自己手上的票，或掃練習單上的練習票：${base}/crew/practice　建議把這封信或連結加入書籤，12/9 當天直接打開。`;
  const [n] = await db.insert(t.notification).values({ channel: 'email', template: 'crew_link', recipient: c.email, content }).returning({ id: t.notification.id });
  await db.update(t.crew).set({ mailNotifId: n.id, mailedGate: sentKey(g), updatedAt: new Date() }).where(eq(t.crew.id, c.id));
  await db.insert(t.auditLog).values({ actor, action: 'crew_mail', target: `crew:${c.id}`, detail: JSON.stringify({ to: c.email, gate: g.name, notif: n.id }) });
}

/** 換人時：舊連結已經寄出或 LINE 傳過 → 換新連結（舊的立即失效） */
async function renewIfSent(db: Db, actor: string, gateId: number, prev: typeof t.crew.$inferSelect | undefined) {
  if (!prev || (!prev.mailNotifId && !prev.lineAt)) return false;
  await db.update(t.gate).set({ token: newToken(), openedAt: null, seenAt: null }).where(eq(t.gate.id, gateId));
  await db.insert(t.auditLog).values({ actor, action: 'gate_update', target: `gate:${gateId}`, detail: JSON.stringify({ renewToken: true, reason: '換人' }) });
  return true;
}

export type LeadAction =
  | { action: 'pos.add'; names: string[] }
  | { action: 'pos.renew'; gateId: number }
  | { action: 'pos.edit'; gateId: number; name?: string; active?: boolean }
  | { action: 'pos.delete'; gateId: number }
  | { action: 'assign'; gateId: number; crewId: number | null }
  | { action: 'mail.preview' }
  | { action: 'mail.send'; ids: number[] }
  | { action: 'mail.one'; crewId: number }
  | { action: 'line'; crewId: number }
  | { action: 'crew.remove'; crewId: number }
  | { action: 'crew.edit'; crewId: number; name: string; email: string; phone: string };

export async function leadAction(db: Db, token: string, auth: CrewAuth, a: LeadAction, base: string, now = new Date()) {
  const { actor } = await authed(db, token, auth, now);
  const ev = await ev0(db);
  const crewOf = async (id: number) => {
    const [c] = await db.select().from(t.crew).where(and(eq(t.crew.id, id), eq(t.crew.eventId, ev.id), eq(t.crew.removed, false)));
    if (!c) throw new BookingError('NOT_FOUND', '找不到這位志工');
    return c;
  };
  const gateOf = async (id: number) => {
    const [g] = await db.select().from(t.gate).where(and(eq(t.gate.id, id), eq(t.gate.eventId, ev.id)));
    if (!g) throw new BookingError('NOT_FOUND', '找不到這個位置');
    return g;
  };
  switch (a.action) {
    case 'pos.add': {
      const names = a.names.map((n) => clean(n, 20)).filter(Boolean);
      if (!names.length) throw new BookingError('INVALID', '請填位置名稱，例：4F左-A');
      return createGates(db, actor, names);
    }
    case 'pos.renew': {
      await gateOf(a.gateId);
      await db.update(t.gate).set({ token: newToken(), openedAt: null, seenAt: null }).where(eq(t.gate.id, a.gateId));
      await db.insert(t.auditLog).values({ actor, action: 'gate_update', target: `gate:${a.gateId}`, detail: JSON.stringify({ renewToken: true }) });
      return { ok: true };
    }
    case 'pos.edit': {
      const g = await gateOf(a.gateId);
      const set: Partial<typeof t.gate.$inferInsert> = {};
      if (a.name !== undefined) {
        const name = clean(a.name, 20);
        if (!name) throw new BookingError('INVALID', '請填位置名稱');
        const [dup] = await db.select().from(t.gate).where(and(eq(t.gate.eventId, ev.id), eq(t.gate.name, name)));
        if (dup && dup.id !== g.id) throw new BookingError('INVALID', `已經有「${name}」了`);
        set.name = name;
      }
      if (a.active !== undefined) set.active = a.active;
      await db.update(t.gate).set(set).where(eq(t.gate.id, g.id));
      await db.insert(t.auditLog).values({ actor, action: 'gate_update', target: `gate:${g.id}`, detail: JSON.stringify({ from: g.name, ...a }) });
      return { ok: true };
    }
    case 'pos.delete': {
      // 已經有正式入場紀錄的位置不能刪（紀錄要留著看是哪個門），改用停用
      const g = await gateOf(a.gateId);
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.checkin).where(eq(t.checkin.gateId, g.id));
      if (n) throw new BookingError('INVALID', `「${g.name}」已經驗過 ${n} 張票，不能刪除，請改用「停用」。`);
      await db.transaction(async (tx) => {
        await tx.update(t.crew).set({ gateId: null, updatedAt: new Date() }).where(eq(t.crew.gateId, g.id));
        await tx.delete(t.checkinPractice).where(eq(t.checkinPractice.gateId, g.id));
        await tx.delete(t.gate).where(eq(t.gate.id, g.id));
        await tx.insert(t.auditLog).values({ actor, action: 'gate_delete', target: `gate:${g.id}`, detail: g.name });
      });
      return { ok: true };
    }
    case 'assign': {
      const g = await gateOf(a.gateId);
      const [prev] = await db.select().from(t.crew).where(and(eq(t.crew.gateId, g.id), eq(t.crew.removed, false)));
      if (a.crewId && prev?.id === a.crewId) return { renewed: false };
      const c = a.crewId ? await crewOf(a.crewId) : null;
      let renewed = false;
      await db.transaction(async (tx) => {
        if (prev) await tx.update(t.crew).set({ gateId: null, updatedAt: new Date() }).where(eq(t.crew.id, prev.id));
        if (c) {
          // 這個人原本在別的位置：那個位置空出來；若連結已給過他，換新
          if (c.gateId && c.gateId !== g.id) await renewIfSent(tx as unknown as Db, actor, c.gateId, c);
          await tx.update(t.crew).set({ gateId: g.id, lineAt: null, updatedAt: new Date() }).where(eq(t.crew.id, c.id));
        }
        renewed = await renewIfSent(tx as unknown as Db, actor, g.id, prev);
        await tx.insert(t.auditLog).values({ actor, action: 'crew_assign', target: `gate:${g.id}`, detail: JSON.stringify({ gate: g.name, from: prev?.name ?? '', to: c?.name ?? '' }) });
      });
      return { renewed };
    }
    case 'mail.preview': {
      const list = await toMail(db, ev.id);
      const crew = await db.select().from(t.crew).where(and(eq(t.crew.eventId, ev.id), eq(t.crew.removed, false)));
      return {
        send: list.map((x) => ({ id: x.crew.id, name: x.crew.name, email: x.crew.email, gate: x.gate.name, again: !!x.crew.mailNotifId })),
        skipSent: crew.filter((c) => c.gateId && c.mailNotifId && !list.some((x) => x.crew.id === c.id)).length,
        skipNoGate: crew.filter((c) => !c.gateId).length,
      };
    }
    case 'mail.send': {
      // 伺服器再檢查一次：只寄預覽後仍然該寄的人
      const list = (await toMail(db, ev.id)).filter((x) => a.ids.includes(x.crew.id));
      for (const x of list) await queueCrewMail(db, actor, base, ev, x.crew, x.gate);
      return { sent: list.length };
    }
    case 'mail.one': {
      const c = await crewOf(a.crewId);
      if (!c.gateId) throw new BookingError('INVALID', '這位志工還沒分配位置');
      if (!isValidEmail(c.email)) throw new BookingError('INVALID', '這位志工的 Email 不正確');
      const g = await gateOf(c.gateId);
      if (!g.active) throw new BookingError('INVALID', '這個位置的連結已停用');
      await queueCrewMail(db, actor, base, ev, c, g);
      return { sent: 1 };
    }
    case 'line': {
      const c = await crewOf(a.crewId);
      if (!c.gateId) throw new BookingError('INVALID', '這位志工還沒分配位置');
      await db.update(t.crew).set({ lineAt: new Date() }).where(eq(t.crew.id, c.id));
      await db.insert(t.auditLog).values({ actor, action: 'crew_line', target: `crew:${c.id}`, detail: '' });
      return { ok: true };
    }
    case 'crew.remove': {
      const c = await crewOf(a.crewId);
      await db.update(t.crew).set({ removed: true, gateId: null, updatedAt: new Date() }).where(eq(t.crew.id, c.id));
      if (c.gateId) await renewIfSent(db, actor, c.gateId, c);
      await db.insert(t.auditLog).values({ actor, action: 'crew_remove', target: `crew:${c.id}`, detail: c.name });
      return { ok: true };
    }
    case 'crew.edit': {
      const c = await crewOf(a.crewId);
      const email = cleanEmail(a.email);
      if (!clean(a.name)) throw new BookingError('INVALID', '請填姓名');
      if (!isValidEmail(email)) throw new BookingError('INVALID', 'Email 格式不正確');
      const [dup] = await db.select().from(t.crew).where(and(eq(t.crew.eventId, ev.id), eq(t.crew.email, email)));
      if (dup && dup.id !== c.id) throw new BookingError('INVALID', '這個 Email 已經有另一位志工');
      // Email 改了：要重寄（清掉寄信紀錄）
      await db.update(t.crew).set({ name: clean(a.name, 40), email, phone: String(a.phone ?? '').replace(/[^\d+]/g, '').slice(0, 20), updatedAt: new Date(), ...(email !== c.email ? { mailNotifId: null, mailedGate: '' } : {}) }).where(eq(t.crew.id, c.id));
      await db.insert(t.auditLog).values({ actor, action: 'crew_edit', target: `crew:${c.id}`, detail: JSON.stringify({ name: a.name, email }) });
      return { ok: true };
    }
  }
}
