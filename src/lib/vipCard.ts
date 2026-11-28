/**
 * VIP／公益 票卡連結（11/28–29）：給負責人一條連結 /vc/<code>，一頁看全部票卡（一席一張、剛好一個手機畫面），
 * 截圖用 LINE 傳；也可在每張下方「寄給本人」（寄一封只有他自己 QR 的信）。
 * - 兩條連結：VIP（類別 VIP）、公益（類別 公益），各鎖自己的負責人 Email。之後新增、換座位自動更新。
 * - 鎖負責人 Email：輸入 Email → 寄 6 位數驗證碼（10 分鐘、最多錯 5 次）→ 通過後這支手機記到演出當天 23:00。
 * - 寄信一定要負責人按（匯入時帶入的 Email 只是預填）；「全部寄出」先列出「還沒寄、有 Email」的清單，再按一次才寄。
 *   寄給本人不換 QR（同一張票）。寄過的「演出前自動寄」不再重複。2 分鐘內同一筆不重寄。
 * - 信裡有「確認收到」按鈕：開頁面後要再按「我收到了」才算（信箱掃毒會自動開連結，只開不算）。
 * - 姓名：空白的可以補填；已有姓名不能改，要換人＝「取消這席」（按兩次，已入場的不行；舊 QR 失效、座位釋出）再新增。
 *   同一筆的其他座位 QR 不變（先把票號固定下來）。取消不寄信。
 * - 自己劃位：VIP＝VIP 排＋2 樓第 1–12 排的空位；公益＝「保留：公益」的空位（任何樓層）。每席一筆、不寄信，Email 選填（只存不寄）。
 * - 劃位、取消、補填、寄出、確認收到都留紀錄（後台 log，頁面「紀錄」）。
 * 設定存 app_setting `vipcard`（VIP）、`vipcard.charity`（公益）。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ticketData } from './admin';
import { BookingError } from './booking';
import { qrSecret, qrValue } from './qr';
import { cancelVip, createVip, setVipMode, type VipMode } from './vip';
import { seatLabel } from './layout';
import type { ViewSeatStatus } from './booking';

export type VcKind = 'vip' | 'charity';
const KEYS: Record<VcKind, string> = { vip: 'vipcard', charity: 'vipcard.charity' };
const CAT: Record<VcKind, string> = { vip: 'VIP', charity: '公益' };
const ROLE: Record<VcKind, string> = { vip: 'VIP負責人', charity: '公益負責人' };
export const VC_LABEL: Record<VcKind, string> = { vip: 'VIP', charity: '公益' };
const CHARITY_USAGE = 'hold-charity';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_MIN = 10;
const OTP_TRIES = 5;
/** 負責人自己劃位：2 樓第 1–N 排（加 VIP 排） */
export const VIP_SELF_ROWS = 12;
/** 沒有姓名（空白、只有符號、待定之類） */
export const blankName = (s: string | null | undefined) => /^[\s\-—_?？.。、]*$|^(待定|未定|待補|保留|空|無)$/.test((s ?? '').trim());

type Dev = { h: string; exp: string };
export type VipCardLink = {
  code: string; name: string; email: string; status: 'on' | 'off'; createdAt: string; by: string; kind?: VcKind;
  otp?: { h: string; exp: string; tries: number; at: string }; devices: Dev[];
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const newCode = () => randomBytes(9).toString('base64url');
export const maskEmail = (e: string) => { const [u, d] = e.split('@'); return d ? `${u.slice(0, 1)}***@${d}` : ''; };
const kindOf = (l: VipCardLink): VcKind => l.kind ?? 'vip';
const tw = (d: Date) => d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
export async function getVipCard(db: Db, kind: VcKind = 'vip'): Promise<VipCardLink | null> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEYS[kind]));
  if (!r) return null;
  try { return { ...(JSON.parse(r.value) as VipCardLink), kind }; } catch { return null; }
}
async function save(db: Db, l: VipCardLink) {
  const { actor: _a, asAdmin: _b, ...plain } = l as VipCardLink & { actor?: string; asAdmin?: boolean };
  const value = JSON.stringify(plain);
  await db.insert(t.appSetting).values({ key: KEYS[kindOf(l)], value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
}
async function log(db: Db, actor: string, action: string, target: string, kind: VcKind, text: string, extra: Record<string, unknown> = {}) {
  await db.insert(t.auditLog).values({ actor, action, target, detail: JSON.stringify({ kind, text, ...extra }) });
}

/* ---------- 後台 ---------- */

/** 建立或改負責人（第一次建立會產生連結；改人不換連結，但已記住的手機要重新驗證） */
export async function setVipCard(db: Db, actor: string, v: { name: string; email: string }, kind: VcKind = 'vip') {
  const name = v.name.trim().slice(0, 60);
  const email = v.email.trim().toLowerCase();
  if (!name) throw new BookingError('INVALID', '請填負責人姓名');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不對');
  const old = await getVipCard(db, kind);
  const l: VipCardLink = old
    ? { ...old, name, email, devices: old.email === email ? old.devices : [], otp: undefined }
    : { code: newCode(), name, email, status: 'on', createdAt: new Date().toISOString(), by: actor, devices: [], kind };
  await save(db, l);
  await db.insert(t.auditLog).values({ actor, action: old ? 'vipcard_update' : 'vipcard_create', target: KEYS[kind], detail: JSON.stringify({ name, email, kind }) });
  return adminView(l);
}
/** 停用／啟用／換新連結（換新：舊連結立刻失效、所有手機要重新驗證） */
export async function vipCardAction(db: Db, actor: string, what: 'off' | 'on' | 'renew', kind: VcKind = 'vip') {
  const l = await getVipCard(db, kind);
  if (!l) throw new BookingError('INVALID', `還沒有建立 ${VC_LABEL[kind]} 票卡連結`);
  if (what === 'renew') Object.assign(l, { code: newCode(), devices: [], otp: undefined, status: 'on' });
  else l.status = what;
  await save(db, l);
  await db.insert(t.auditLog).values({ actor, action: `vipcard_${what}`, target: KEYS[kind], detail: JSON.stringify({ kind }) });
  return adminView(l);
}
export function adminView(l: VipCardLink | null) {
  if (!l) return null;
  const now = Date.now();
  return { code: l.code, name: l.name, email: l.email, status: l.status, devices: l.devices.filter((d) => Date.parse(d.exp) > now).length };
}

/* ---------- 負責人頁 /vc/<code> ---------- */

async function linkOf(db: Db, code: string, admin = false) {
  let l: VipCardLink | null = null;
  for (const k of ['vip', 'charity'] as const) { const x = await getVipCard(db, k); if (x && x.code === code) l = x; }
  if (!l) throw new BookingError('LINK_NOT_FOUND', '連結不存在或已更換，請向主辦方索取新連結。');
  if (l.status !== 'on' && !admin) throw new BookingError('LINK_CLOSED', '這條連結目前停用中，請聯絡主辦方。');
  return l;
}
/**
 * 誰在操作：負責人（這支手機的通行碼）或已登入後台的系統管理員（不用驗證碼直接進，停用中也能看；
 * 操作紀錄記系統管理員本人，不影響負責人的登入）。由 API 依後台登入 cookie 判斷，前端送不進來。
 */
export type VcAuth = string | { admin: string };
async function authed(db: Db, code: string, auth: VcAuth, now: Date) {
  if (typeof auth === 'object') {
    const l = await linkOf(db, code, true);
    return Object.assign(l, { actor: `系統管理員:${auth.admin}`, asAdmin: true, k: kindOf(l) });
  }
  const l = await linkOf(db, code);
  const h = sha(auth || '-');
  if (!auth || !l.devices.some((d) => d.h === h && Date.parse(d.exp) > now.getTime())) throw new BookingError('AUTH', '請先驗證 Email。');
  return Object.assign(l, { actor: `${ROLE[kindOf(l)]}:${l.name}`, asAdmin: false, k: kindOf(l) });
}

/** 寄驗證碼：Email 要跟後台設定的一樣；60 秒內不重寄 */
export async function sendVipOtp(db: Db, code: string, email: string, now = new Date(), base = '') {
  const l = await linkOf(db, code);
  if (email.trim().toLowerCase() !== l.email) throw new BookingError('INVALID', '這個 Email 沒有權限，請確認是主辦方登記的 Email。');
  if (l.otp && now.getTime() - Date.parse(l.otp.at) < 60_000) throw new BookingError('TOO_MANY', '驗證碼剛寄出，請 1 分鐘後再試。');
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  l.otp = { h: sha(`${l.code}:${otp}`), exp: new Date(now.getTime() + OTP_MIN * 60_000).toISOString(), tries: 0, at: now.toISOString() };
  await save(db, l);
  const ev = await ev0(db);
  const page = `${VC_LABEL[kindOf(l)]} 票卡頁`;
  await db.insert(t.notification).values({ channel: 'email', template: 'vip_otp', recipient: l.email, content: `【${ev.name}】${l.name} 您好，${page}的驗證碼是 ${otp}，${OTP_MIN} 分鐘內有效。請回到${page}輸入驗證碼。如果不是您本人操作，請忽略這封信。${base ? `${base.replace(/\/$/, '')}/vc/${l.code}` : ''}` });
  return { sentTo: maskEmail(l.email) };
}

/** 驗證：通過後回傳這支手機的通行碼（記到演出當天 23:00） */
export async function verifyVipOtp(db: Db, code: string, otp: string, now = new Date()) {
  const l = await linkOf(db, code);
  if (!l.otp || Date.parse(l.otp.exp) < now.getTime()) throw new BookingError('INVALID', '驗證碼已過期，請重新寄送。');
  if (l.otp.tries >= OTP_TRIES) throw new BookingError('INVALID', '錯太多次了，請重新寄送驗證碼。');
  if (sha(`${l.code}:${otp.trim()}`) !== l.otp.h) {
    l.otp.tries++;
    await save(db, l);
    throw new BookingError('INVALID', `驗證碼不對（還可以試 ${OTP_TRIES - l.otp.tries} 次）。`);
  }
  const token = randomBytes(24).toString('base64url');
  const ev = await ev0(db);
  const day = ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const end = new Date(`${day}T23:00:00+08:00`).getTime();
  const until = now.getTime() < end ? end : now.getTime() + 86400_000;
  l.otp = undefined;
  l.devices = [...l.devices.filter((d) => Date.parse(d.exp) > now.getTime()), { h: sha(token), exp: new Date(until).toISOString() }].slice(-20);
  await save(db, l);
  await db.insert(t.auditLog).values({ actor: `${ROLE[kindOf(l)]}:${l.name}`, action: 'vipcard_verify', target: KEYS[kindOf(l)], detail: JSON.stringify({ kind: kindOf(l) }) });
  return { token };
}

/** 這條連結管的訂單（類別 VIP 或 公益、未取消） */
async function scopeOrders(db: Db, eventId: number, kind: VcKind) {
  return db.select().from(t.orders).where(and(eq(t.orders.eventId, eventId), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, CAT[kind])));
}
async function scopeOrder(db: Db, eventId: number, kind: VcKind, id: number) {
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, eventId), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, CAT[kind])));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這筆資料（可能已取消），請重新整理頁面。');
  return o;
}

/* ---------- 收件確認 /vr/<orderId>-<token> ---------- */

const RKEY = (orderId: number) => `vcr.${orderId}`;
/** 確認收到的網址：同一筆訂單永遠同一條（重寄也一樣），用 QR 金鑰算出來，不用另外存 */
export async function receiptUrl(db: Db, orderId: number, base: string) {
  const tok = sha(`${await qrSecret(db)}:receipt:${orderId}`).slice(0, 20);
  return `${base.replace(/\/$/, '')}/vr/${orderId}-${tok}`;
}
async function receiptOrder(db: Db, token: string) {
  const m = token.match(/^(\d{1,9})-([0-9a-f]{20})$/);
  const bad = new BookingError('LINK_NOT_FOUND', '連結不正確或已失效，請聯絡主辦單位。');
  if (!m) throw bad;
  const id = Number(m[1]);
  if (sha(`${await qrSecret(db)}:receipt:${id}`).slice(0, 20) !== m[2]) throw bad;
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.vip, true)));
  if (!o || o.status !== 'paid') throw new BookingError('LINK_NOT_FOUND', '這張票已取消，請聯絡主辦單位。');
  return o;
}
async function receiptsOf(db: Db, orderIds: number[]) {
  if (!orderIds.length) return new Map<number, string>();
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, orderIds.map(RKEY)));
  return new Map(rows.map((r) => [Number(r.key.slice(4)), (JSON.parse(r.value) as { at: string }).at]));
}
const maskName = (n: string) => (n.length <= 1 ? n : `${n[0]}${'○'.repeat(Math.min(n.length - 1, 3))}`);
/** 收件人打開頁面：只看座位、遮名字；不會因為打開就算確認 */
export async function receiptView(db: Db, token: string) {
  const o = await receiptOrder(db, token);
  const ev = await ev0(db);
  const { tickets } = await ticketData(db, [o.id]);
  const at = (await receiptsOf(db, [o.id])).get(o.id) ?? null;
  return { event: ev.name, showAt: ev.showAt.toISOString(), name: maskName((o.buyerName ?? '').split(/\s/)[0]), seats: tickets.map((x) => x.label), confirmedAt: at };
}
/** 按「我收到了」：只記第一次 */
export async function receiptConfirm(db: Db, token: string, now = new Date()) {
  const o = await receiptOrder(db, token);
  const has = (await receiptsOf(db, [o.id])).get(o.id);
  if (has) return { confirmedAt: has };
  const value = JSON.stringify({ at: now.toISOString() });
  await db.insert(t.appSetting).values({ key: RKEY(o.id), value }).onConflictDoNothing();
  const kind: VcKind = o.vipCat === '公益' ? 'charity' : 'vip';
  const seats = (await ticketData(db, [o.id])).tickets.map((x) => x.label).join('、');
  await log(db, `收件人:${o.buyerName ?? ''}`, 'vipcard_receipt', `order:${o.id}`, kind, `確認收到：${o.buyerName ?? ''}（${seats}）`);
  return { confirmedAt: now.toISOString() };
}

/* ---------- 頁面資料 ---------- */

const LOG_ACTIONS = ['vipcard_book', 'vipcard_cancel', 'vipcard_name', 'vipcard_send', 'vipcard_receipt'];
async function recentLog(db: Db, kind: VcKind) {
  const rows = await db.select().from(t.auditLog).where(inArray(t.auditLog.action, LOG_ACTIONS)).orderBy(desc(t.auditLog.id)).limit(600);
  return rows.map((r) => { let d: { kind?: VcKind; text?: string } = {}; try { d = JSON.parse(r.detail ?? ''); } catch { /* 舊紀錄 */ } return { r, d }; })
    .filter(({ d }) => (d.kind ?? 'vip') === kind && d.text)
    .slice(0, 200).map(({ r, d }) => ({ at: r.at.toISOString(), actor: r.actor, what: r.action.replace('vipcard_', ''), text: d.text! }));
}

/** 票卡頁資料：每席一張（依座位排序），寄送與確認收到的狀態、紀錄 */
export async function vipCardPage(db: Db, code: string, token: VcAuth, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const os = await scopeOrders(db, ev.id, l.k);
  const { tickets } = await ticketData(db, os.map((o) => o.id));
  const secret = await qrSecret(db);
  const used = tickets.length ? await db.select({ serial: t.checkin.serial }).from(t.checkin).where(and(eq(t.checkin.eventId, ev.id), inArray(t.checkin.serial, tickets.map((x) => x.serial)))) : [];
  const notes = os.length ? await db.select().from(t.notification).where(and(inArray(t.notification.orderId, os.map((o) => o.id)), eq(t.notification.channel, 'email'))).orderBy(desc(t.notification.createdAt)) : [];
  const rcpt = await receiptsOf(db, os.map((o) => o.id));
  const seats = await db.select({ id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, floor: t.venueSeat.floor }).from(t.venueSeat).where(inArray(t.venueSeat.id, tickets.map((x) => x.seatId).concat('-')));
  const pos = (id: string) => { const s = seats.find((x) => x.id === id); return s ? (s.floor === '2M' ? 0 : 1e7) + s.y * 1000 + s.x : 0; };
  const cards = [...tickets].sort((a, b) => pos(a.seatId) - pos(b.seatId)).map((tk) => {
    const o = os.find((x) => x.id === tk.orderId)!;
    const n = notes.filter((x) => x.orderId === o.id);
    const sent = n.find((x) => x.status === 'sent');
    const queued = n.find((x) => x.status === 'queued');
    return {
      serial: tk.serial, value: qrValue(secret, tk.serial), seat: tk.label, seatId: tk.seatId, name: blankName(tk.holderName) ? '' : tk.holderName, needName: blankName(tk.holderName), org: o.vipOrg,
      orderId: o.id, email: o.buyerEmail ?? '', sentAt: sent?.sentAt?.toISOString() ?? null,
      sending: !!queued && (!queued.sendAfter || queued.sendAfter <= now), failed: !sent && !queued && n.some((x) => x.status === 'failed'),
      receivedAt: rcpt.get(o.id) ?? null, entered: used.some((u) => u.serial === tk.serial),
    };
  });
  return {
    kind: l.k, label: VC_LABEL[l.k], event: { name: ev.name, showAt: ev.showAt.toISOString() }, leader: l.name, cards, asAdmin: l.asAdmin, off: l.status !== 'on',
    total: os.length, sent: os.filter((o) => notes.some((x) => x.orderId === o.id && x.status === 'sent')).length, log: await recentLog(db, l.k),
  };
}

/** 寄一筆（已驗過權限與範圍）：存 Email、清掉排程、寄一封有 QR 與「確認收到」按鈕的信；2 分鐘內不重寄 */
async function sendOne(db: Db, actor: string, kind: VcKind, o: typeof t.orders.$inferSelect, email: string, base: string, now: Date) {
  const ev = await ev0(db);
  if (!email) throw new BookingError('INVALID', '請填 Email。');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不對');
  const [last] = await db.select().from(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.channel, 'email'))).orderBy(desc(t.notification.createdAt)).limit(1);
  // 時間差要 ≥ 0：測試用的 now 比資料庫寫入時間早時不算
  const ago = last ? now.getTime() - last.createdAt.getTime() : -1;
  if (last && ago >= 0 && ago < 120_000) throw new BookingError('TOO_MANY', '剛剛寄過了，請 2 分鐘後再試。');
  const seats = (await ticketData(db, [o.id])).tickets.map((x) => x.label).join('、');
  const when = ev.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const content = `【${ev.name}】${o.buyerName ?? ''} 您好，主辦單位誠摯邀請您蒞臨，已為您保留座位：${seats}。演出時間 ${when}。入場 QR code 附在本信。收到後請按下方按鈕確認收到，謝謝：${await receiptUrl(db, o.id, base)}`;
  await db.transaction(async (tx) => {
    await tx.delete(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.status, 'queued')));
    await tx.update(t.orders).set({ buyerEmail: email, notifyMode: 'now' }).where(eq(t.orders.id, o.id));
    await tx.insert(t.notification).values({ orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: email, content, createdAt: now });
    await tx.insert(t.auditLog).values({ actor, action: 'vipcard_send', target: `order:${o.id}`, detail: JSON.stringify({ kind, text: `寄出 ${o.buyerName ?? ''}（${seats}）→ ${email}`, email, before: o.buyerEmail }) });
  });
  return { to: email };
}

/** 寄給本人：可填新 Email（會存進那筆資料）；寄一封只有他自己 QR 的信 */
export async function vipCardSend(db: Db, code: string, token: VcAuth, v: { orderId: number; email?: string }, base: string, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const o = await scopeOrder(db, ev.id, l.k, v.orderId);
  const email = (v.email ?? '').trim().toLowerCase() || o.buyerEmail || '';
  return sendOne(db, l.actor, l.k, o, email, base, now);
}

/** 「已寄過」：有寄成功的、或正在寄的（排在演出前自動寄、還沒到時間的不算） */
async function sentOrders(db: Db, orderIds: number[], now: Date) {
  if (!orderIds.length) return new Set<number>();
  const n = await db.select().from(t.notification).where(and(inArray(t.notification.orderId, orderIds), eq(t.notification.channel, 'email')));
  return new Set(n.filter((x) => x.status === 'sent' || (x.status === 'queued' && (!x.sendAfter || x.sendAfter <= now))).map((x) => x.orderId!));
}

/**
 * 全部寄出：先預覽（dry）＝只列「還沒寄過、有 Email」的；確認時只寄預覽清單裡、而且現在仍是「還沒寄過、有 Email、Email 沒變」的。
 * 已寄過的一律不寄（要補寄請用那張卡的「再寄一次」）。
 */
export async function vipCardSendAll(db: Db, code: string, token: VcAuth, v: { dry: boolean; pick?: { orderId: number; email: string }[] }, base: string, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const os = await scopeOrders(db, ev.id, l.k);
  const sent = await sentOrders(db, os.map((o) => o.id), now);
  const { tickets } = await ticketData(db, os.map((o) => o.id));
  const seatsOf = (id: number) => tickets.filter((x) => x.orderId === id).map((x) => x.label);
  const todo = os.filter((o) => !sent.has(o.id) && o.buyerEmail && EMAIL.test(o.buyerEmail));
  const preview = {
    list: todo.map((o) => ({ orderId: o.id, name: o.buyerName ?? '', org: o.vipOrg, email: o.buyerEmail!, seats: seatsOf(o.id) })),
    sentCount: os.filter((o) => sent.has(o.id)).length,
    noEmail: os.filter((o) => !sent.has(o.id) && !(o.buyerEmail && EMAIL.test(o.buyerEmail))).map((o) => ({ orderId: o.id, name: o.buyerName ?? '', seats: seatsOf(o.id) })),
  };
  if (v.dry) return { ...preview, done: [] as { orderId: number; to: string }[], skipped: [] as { orderId: number; why: string }[] };
  const pick = v.pick ?? [];
  if (!pick.length) throw new BookingError('INVALID', '沒有要寄的');
  if (pick.length > 300) throw new BookingError('INVALID', '一次最多 300 封');
  const done: { orderId: number; to: string }[] = [];
  const skipped: { orderId: number; why: string }[] = [];
  for (const p of pick) {
    const o = todo.find((x) => x.id === p.orderId);
    if (!o) { skipped.push({ orderId: p.orderId, why: '已寄過或已取消' }); continue; }
    if (o.buyerEmail !== p.email.trim().toLowerCase() && o.buyerEmail !== p.email) { skipped.push({ orderId: o.id, why: 'Email 已變更，請重新整理' }); continue; }
    try { done.push({ orderId: o.id, ...(await sendOne(db, l.actor, l.k, o, o.buyerEmail!, base, now)) }); } catch (e) { skipped.push({ orderId: o.id, why: (e as Error).message }); }
  }
  return { ...preview, done, skipped };
}

/** 補填姓名：只能填空白的（已有姓名的不能改，要換人請「取消這席」再新增）；QR 不變 */
export async function vipCardName(db: Db, code: string, token: VcAuth, v: { orderId: number; seatId: string; name: string }, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const name = v.name.trim().slice(0, 60);
  if (blankName(name)) throw new BookingError('INVALID', '請填姓名職稱');
  const o = await scopeOrder(db, ev.id, l.k, v.orderId);
  const [os] = await db.select().from(t.orderSeat).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, v.seatId)));
  if (!os) throw new BookingError('NOT_FOUND', '找不到這個座位，請重新整理頁面。');
  if (!blankName(os.holderName)) throw new BookingError('INVALID', '這席已經有姓名了；要換人請按「取消這席」再新增。');
  const label = (await ticketData(db, [o.id])).tickets.find((x) => x.seatId === v.seatId)?.label ?? v.seatId;
  await db.transaction(async (tx) => {
    await tx.update(t.orderSeat).set({ holderName: name }).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, v.seatId)));
    if (blankName(o.buyerName)) {
      await tx.update(t.orders).set({ buyerName: name }).where(eq(t.orders.id, o.id));
      await tx.update(t.inviteLink).set({ name }).where(eq(t.inviteLink.id, o.linkId));
    }
    await tx.insert(t.auditLog).values({ actor: l.actor, action: 'vipcard_name', target: `order:${o.id}`, detail: JSON.stringify({ kind: l.k, text: `補填姓名 ${label}：${name}`, seatId: v.seatId, name }) });
  });
  return { ok: true };
}

/**
 * 取消這席：已入場的不行；舊 QR 失效、座位釋出；不寄信。
 * 同一筆還有其他座位：先把每席的票號固定（其他人的 QR 不變），再拿掉這一席；只剩這席：整筆取消。
 */
export async function vipCardCancel(db: Db, code: string, token: VcAuth, v: { orderId: number; seatId: string }, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const o = await scopeOrder(db, ev.id, l.k, v.orderId);
  const { tickets } = await ticketData(db, [o.id]);
  const tk = tickets.find((x) => x.seatId === v.seatId);
  if (!tk) throw new BookingError('NOT_FOUND', '找不到這個座位，請重新整理頁面。');
  const [ci] = await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, ev.id), eq(t.checkin.serial, tk.serial)));
  if (ci) throw new BookingError('INVALID', `${tk.label} 已經入場，不能取消。`);
  const text = `取消 ${tk.label} ${blankName(tk.holderName) ? '（未填姓名）' : tk.holderName}（序號 ${tk.serial}，舊 QR 已失效）`;
  if (tickets.length === 1) {
    await cancelVip(db, l.actor, o.id);
  } else {
    const hadQueued = (await db.select({ id: t.notification.id }).from(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.status, 'queued')))).length > 0;
    await db.transaction(async (tx) => {
      for (const x of tickets) {
        const no = Number(x.serial.slice(x.serial.lastIndexOf('-') + 1));
        await tx.update(t.orderSeat).set({ ticketNo: no }).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, x.seatId)));
      }
      await tx.delete(t.orderSeat).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, v.seatId)));
      await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, v.seatId), eq(t.eventSeat.orderId, o.id)));
      await tx.update(t.inviteLink).set({ quota: tickets.length - 1 }).where(eq(t.inviteLink.id, o.linkId));
    });
    // 還沒寄出的排程信：換成剩下座位的內容
    if (hadQueued) await setVipMode(db, l.actor, o.id, o.notifyMode as VipMode).catch(() => undefined);
  }
  await log(db, l.actor, 'vipcard_cancel', `order:${o.id}`, l.k, text, { seatId: v.seatId, serial: tk.serial });
  return { ok: true };
}

/* ---------- 自己劃位 ---------- */

/** 座位：VIP＝2 樓（VIP 排＋第 1–12 排）；公益＝有「保留：公益」座位的樓層 */
async function selfSeats(db: Db, eventId: number, kind: VcKind) {
  const rows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, code: t.venueSeat.code, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, floor: t.venueSeat.floor,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, sellable: t.seatUsage.sellable, usage: t.seatUsage.code,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(kind === 'vip' ? and(eq(t.eventSeat.eventId, eventId), eq(t.venueSeat.floor, '2M')) : eq(t.eventSeat.eventId, eventId));
  if (kind === 'vip') return rows;
  const floors = new Set(rows.filter((s) => s.usage === CHARITY_USAGE).map((s) => s.floor));
  return rows.filter((s) => floors.has(s.floor));
}
type SelfSeat = Awaited<ReturnType<typeof selfSeats>>[number];
const inRange = (kind: VcKind, s: SelfSeat, vipInstalled: boolean) => kind === 'charity' ? s.seatType !== 'vip' || vipInstalled
  : (s.seatType === 'vip' ? vipInstalled : s.seatType !== 'wheelchair' && s.rowNo != null && s.rowNo >= 1 && s.rowNo <= VIP_SELF_ROWS);
const canTake = (kind: VcKind, s: SelfSeat) => s.status === 'free' && (kind === 'charity' ? s.usage === CHARITY_USAGE
  : !['join-gift', 'era-sold'].includes(s.usage) && (s.sellable || s.seatType === 'vip'));

export async function vipCardSeatMap(db: Db, code: string, token: VcAuth, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const rows = (await selfSeats(db, ev.id, l.k)).filter((s) => inRange(l.k, s, ev.vipInstalled));
  const floors = [...new Set(rows.map((s) => s.floor))].sort() as ('2M' | '3F')[];
  const zones = floors.length ? await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), inArray(t.priceZone.floor, floors))) : [];
  return {
    kind: l.k, vipInstalled: ev.vipInstalled, rows: VIP_SELF_ROWS, floors, free: rows.filter((s) => canTake(l.k, s)).length,
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, gift: z.price === 0 })),
    seats: rows.map((s) => ({
      id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), bundle: null as string | null, floor: s.floor,
      // 公益：不是保留席的空位不上色（看起來就是不能選）
      zoneId: l.k === 'charity' && s.status === 'free' && !canTake(l.k, s) ? -1 : s.zoneId,
      status: (canTake(l.k, s) ? 'free' : s.status !== 'free' ? 'sold' : 'blocked') as ViewSeatStatus,
    })),
  };
}

/** 負責人自己劃位：每席一筆（類別 VIP／公益、不寄信；Email 選填只存）；任何一席不行就都不建立 */
export async function vipCardBook(db: Db, code: string, token: VcAuth, v: { seats: { seatId: string; name: string; email?: string }[]; org?: string }, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const list = v.seats.map((x) => ({ seatId: x.seatId, name: x.name.trim().slice(0, 60), email: (x.email ?? '').trim().toLowerCase() }));
  if (!list.length) throw new BookingError('INVALID', '請先選座位');
  if (list.length > 20) throw new BookingError('INVALID', '一次最多 20 席');
  if (new Set(list.map((x) => x.seatId)).size !== list.length) throw new BookingError('INVALID', '座位重複了');
  if (list.some((x) => blankName(x.name))) throw new BookingError('INVALID', '每一席都要填姓名職稱');
  const badMail = list.find((x) => x.email && !EMAIL.test(x.email));
  if (badMail) throw new BookingError('INVALID', `${badMail.name} 的 Email 格式不對`);
  const all = await selfSeats(db, ev.id, l.k);
  const pick = list.map((x) => all.find((s) => s.id === x.seatId));
  if (pick.some((s) => !s || !inRange(l.k, s, ev.vipInstalled))) throw new BookingError('INVALID', l.k === 'vip' ? `只能選 VIP 排和 2 樓第 1–${VIP_SELF_ROWS} 排的座位` : '只能選「保留：公益」的座位');
  const taken = pick.filter((s) => !canTake(l.k, s!));
  if (taken.length) throw new BookingError('SEAT_TAKEN', `${taken.map((s) => seatLabel(s!)).join('、')} 已經不能選了，請重新選。`, taken.map((s) => s!.id));
  const org = (v.org ?? '').trim().slice(0, 60);
  const done: string[] = [];
  const lb = (id: string) => seatLabel(all.find((s) => s.id === id)!);
  for (const x of list) {
    try {
      const r = await createVip(db, l.actor, { name: x.name, phone: '', email: x.email, seatIds: [x.seatId], mode: 'none', cat: CAT[l.k], org, holders: [x.name], note: `${l.asAdmin ? `系統管理員從 ${VC_LABEL[l.k]} 票卡頁` : `${VC_LABEL[l.k]} 負責人自己`}劃位 ${tw(now)}` });
      done.push(x.seatId);
      await log(db, l.actor, 'vipcard_book', `order:${r.orderId}`, l.k, `劃位 ${lb(x.seatId)}：${x.name}${org ? `（${org}）` : ''}${x.email ? `，Email ${x.email}（未寄）` : ''}`, { seatId: x.seatId });
    } catch (e) {
      throw new BookingError('SEAT_TAKEN', `${done.length ? `已完成 ${done.map(lb).join('、')}；` : ''}${lb(x.seatId)} 沒有成功（${(e as Error).message}），請重新選。`);
    }
  }
  return { count: done.length };
}
