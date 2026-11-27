/**
 * VIP 票卡連結（11/28）：給 VIP 負責人一條連結 /vc/<code>，一頁看全部 VIP 的票卡（一席一張、剛好一個手機畫面），
 * 截圖用 LINE 傳；也可在每位 VIP 下方「寄給本人」（填或沿用 Email，寄一封只有他自己 QR 的信）。
 * - 範圍：類別 VIP、未取消的 VIP／公益訂單（之後新增、換座位自動更新）。
 * - 鎖負責人 Email：輸入 Email → 寄 6 位數驗證碼（10 分鐘、最多錯 5 次）→ 通過後這支手機記到演出當天 23:00（使用者 11/28 定）。
 * - 負責人不能改姓名、座位；寄給本人不換 QR（同一張票）。寄過的「演出前自動寄」不再重複。
 * 設定存 app_setting `vipcard`（全場一條，可停用、換新連結）。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ticketData, linkUrl } from './admin';
import { BookingError } from './booking';
import { qrSecret, qrValue } from './qr';

const KEY = 'vipcard';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_MIN = 10;
const OTP_TRIES = 5;

type Dev = { h: string; exp: string };
export type VipCardLink = {
  code: string; name: string; email: string; status: 'on' | 'off'; createdAt: string; by: string;
  otp?: { h: string; exp: string; tries: number; at: string }; devices: Dev[];
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const newCode = () => randomBytes(9).toString('base64url');
export const maskEmail = (e: string) => { const [u, d] = e.split('@'); return d ? `${u.slice(0, 1)}***@${d}` : ''; };

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
export async function getVipCard(db: Db): Promise<VipCardLink | null> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY));
  if (!r) return null;
  try { return JSON.parse(r.value) as VipCardLink; } catch { return null; }
}
async function save(db: Db, l: VipCardLink) {
  const value = JSON.stringify(l);
  await db.insert(t.appSetting).values({ key: KEY, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
}

/* ---------- 後台 ---------- */

/** 建立或改負責人（第一次建立會產生連結；改人不換連結，但已記住的手機要重新驗證） */
export async function setVipCard(db: Db, actor: string, v: { name: string; email: string }) {
  const name = v.name.trim().slice(0, 60);
  const email = v.email.trim().toLowerCase();
  if (!name) throw new BookingError('INVALID', '請填負責人姓名');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不對');
  const old = await getVipCard(db);
  const l: VipCardLink = old
    ? { ...old, name, email, devices: old.email === email ? old.devices : [], otp: undefined }
    : { code: newCode(), name, email, status: 'on', createdAt: new Date().toISOString(), by: actor, devices: [] };
  await save(db, l);
  await db.insert(t.auditLog).values({ actor, action: old ? 'vipcard_update' : 'vipcard_create', target: KEY, detail: JSON.stringify({ name, email }) });
  return adminView(l);
}
/** 停用／啟用／換新連結（換新：舊連結立刻失效、所有手機要重新驗證） */
export async function vipCardAction(db: Db, actor: string, what: 'off' | 'on' | 'renew') {
  const l = await getVipCard(db);
  if (!l) throw new BookingError('INVALID', '還沒有建立 VIP 票卡連結');
  if (what === 'renew') Object.assign(l, { code: newCode(), devices: [], otp: undefined, status: 'on' });
  else l.status = what;
  await save(db, l);
  await db.insert(t.auditLog).values({ actor, action: `vipcard_${what}`, target: KEY, detail: '' });
  return adminView(l);
}
export function adminView(l: VipCardLink | null) {
  if (!l) return null;
  const now = Date.now();
  return { code: l.code, name: l.name, email: l.email, status: l.status, devices: l.devices.filter((d) => Date.parse(d.exp) > now).length };
}

/* ---------- 負責人頁 /vc/<code> ---------- */

async function linkOf(db: Db, code: string) {
  const l = await getVipCard(db);
  if (!l || l.code !== code) throw new BookingError('LINK_NOT_FOUND', '連結不存在或已更換，請向主辦方索取新連結。');
  if (l.status !== 'on') throw new BookingError('LINK_CLOSED', '這條連結目前停用中，請聯絡主辦方。');
  return l;
}
async function authed(db: Db, code: string, token: string, now: Date) {
  const l = await linkOf(db, code);
  const h = sha(token || '-');
  if (!token || !l.devices.some((d) => d.h === h && Date.parse(d.exp) > now.getTime())) throw new BookingError('AUTH', '請先驗證 Email。');
  return l;
}

/** 寄驗證碼：Email 要跟後台設定的一樣；60 秒內不重寄 */
export async function sendVipOtp(db: Db, code: string, email: string, now = new Date()) {
  const l = await linkOf(db, code);
  if (email.trim().toLowerCase() !== l.email) throw new BookingError('INVALID', '這個 Email 沒有權限，請確認是主辦方登記的 Email。');
  if (l.otp && now.getTime() - Date.parse(l.otp.at) < 60_000) throw new BookingError('TOO_MANY', '驗證碼剛寄出，請 1 分鐘後再試。');
  const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  l.otp = { h: sha(`${l.code}:${otp}`), exp: new Date(now.getTime() + OTP_MIN * 60_000).toISOString(), tries: 0, at: now.toISOString() };
  await save(db, l);
  const ev = await ev0(db);
  await db.insert(t.notification).values({ channel: 'email', template: 'vip_otp', recipient: l.email, content: `【${ev.name}】${l.name} 您好，VIP 票卡頁的驗證碼是 ${otp}，${OTP_MIN} 分鐘內有效。如果不是您本人操作，請忽略這封信。` });
  return { sentTo: maskEmail(l.email) };
}

/** 驗證：通過後回傳這支手機的通行碼（記住 7 天） */
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
  // 這支手機記到演出當天 23:00（台北）；萬一已過了，就記 1 天
  const ev = await ev0(db);
  const day = ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const end = new Date(`${day}T23:00:00+08:00`).getTime();
  const until = now.getTime() < end ? end : now.getTime() + 86400_000;
  l.otp = undefined;
  l.devices = [...l.devices.filter((d) => Date.parse(d.exp) > now.getTime()), { h: sha(token), exp: new Date(until).toISOString() }].slice(-20);
  await save(db, l);
  await db.insert(t.auditLog).values({ actor: `VIP負責人:${l.name}`, action: 'vipcard_verify', target: KEY, detail: '' });
  return { token };
}

/** VIP 訂單（類別 VIP、未取消） */
async function vipOrders(db: Db, eventId: number) {
  return db.select().from(t.orders).where(and(eq(t.orders.eventId, eventId), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, 'VIP')));
}

/** 票卡頁資料：每席一張（依座位排序），每位 VIP 的寄送狀態 */
export async function vipCardPage(db: Db, code: string, token: string, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const os = await vipOrders(db, ev.id);
  const { tickets } = await ticketData(db, os.map((o) => o.id));
  const secret = await qrSecret(db);
  const used = tickets.length ? await db.select({ serial: t.checkin.serial }).from(t.checkin).where(and(eq(t.checkin.eventId, ev.id), inArray(t.checkin.serial, tickets.map((x) => x.serial)))) : [];
  const notes = os.length ? await db.select().from(t.notification).where(and(inArray(t.notification.orderId, os.map((o) => o.id)), eq(t.notification.channel, 'email'))).orderBy(desc(t.notification.createdAt)) : [];
  const seats = await db.select({ id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y }).from(t.venueSeat).where(inArray(t.venueSeat.id, tickets.map((x) => x.seatId).concat('-')));
  const pos = (id: string) => { const s = seats.find((x) => x.id === id); return s ? s.y * 1000 + s.x : 0; };
  const cards = [...tickets].sort((a, b) => pos(a.seatId) - pos(b.seatId)).map((tk) => {
    const o = os.find((x) => x.id === tk.orderId)!;
    const n = notes.filter((x) => x.orderId === o.id);
    const sent = n.find((x) => x.status === 'sent');
    const queued = n.find((x) => x.status === 'queued');
    return {
      serial: tk.serial, value: qrValue(secret, tk.serial), seat: tk.label, name: tk.holderName || o.buyerName || '', org: o.vipOrg,
      orderId: o.id, email: o.buyerEmail ? maskEmail(o.buyerEmail) : '', sentAt: sent?.sentAt?.toISOString() ?? null,
      sending: !!queued && (!queued.sendAfter || queued.sendAfter <= now), entered: used.some((u) => u.serial === tk.serial),
    };
  });
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, leader: l.name, cards,
    total: os.length, sent: os.filter((o) => notes.some((x) => x.orderId === o.id && x.status === 'sent')).length,
  };
}

/** 寄給本人：可填新 Email（會存進那位 VIP 的資料）；寄一封只有他自己 QR 的信；2 分鐘內不重寄 */
export async function vipCardSend(db: Db, code: string, token: string, v: { orderId: number; email?: string }, base: string, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, v.orderId), eq(t.orders.eventId, ev.id), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, 'VIP')));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這位 VIP，請重新整理頁面。');
  const email = (v.email ?? '').trim().toLowerCase() || o.buyerEmail || '';
  if (!email) throw new BookingError('INVALID', '請填這位 VIP 的 Email。');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不對');
  const [last] = await db.select().from(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.channel, 'email'))).orderBy(desc(t.notification.createdAt)).limit(1);
  if (last && now.getTime() - last.createdAt.getTime() < 120_000) throw new BookingError('TOO_MANY', '剛剛寄過了，請 2 分鐘後再試。');
  const [lk] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.id, o.linkId));
  const seats = (await ticketData(db, [o.id])).tickets.map((x) => x.label).join('、');
  const when = ev.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const content = `【${ev.name}】${o.buyerName ?? ''} 您好，主辦單位誠摯邀請您蒞臨，已為您保留座位：${seats}。演出時間 ${when}。入場 QR code 附在本信，也可至您的劃位頁查看：${linkUrl(lk.code, base)}`;
  await db.transaction(async (tx) => {
    // 寄過就不再「演出前自動寄」：清掉排程、寄送方式改成「立即寄」
    await tx.delete(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.status, 'queued')));
    await tx.update(t.orders).set({ buyerEmail: email, notifyMode: 'now' }).where(eq(t.orders.id, o.id));
    await tx.insert(t.notification).values({ orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: email, content, createdAt: now });
    await tx.insert(t.auditLog).values({ actor: `VIP負責人:${l.name}`, action: 'vipcard_send', target: `order:${o.id}`, detail: JSON.stringify({ email, before: o.buyerEmail }) });
  });
  return { to: maskEmail(email) };
}
