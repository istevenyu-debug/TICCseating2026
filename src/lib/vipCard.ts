/**
 * VIP 票卡連結（11/28）：給 VIP 負責人一條連結 /vc/<code>，一頁看全部 VIP 的票卡（一席一張、剛好一個手機畫面），
 * 截圖用 LINE 傳；也可在每位 VIP 下方「寄給本人」（填或沿用 Email，寄一封只有他自己 QR 的信）。
 * - 範圍：類別 VIP、未取消的 VIP／公益訂單（之後新增、換座位自動更新）。
 * - 鎖負責人 Email：輸入 Email → 寄 6 位數驗證碼（10 分鐘、最多錯 5 次）→ 通過後這支手機記到演出當天 23:00（使用者 11/28 定）。
 * - 負責人不能改已有的姓名、座位；寄給本人不換 QR（同一張票）。寄過的「演出前自動寄」不再重複。
 * - 11/28：沒有姓名的票卡，負責人可以補填（只填空白，不能改已有的）；QR 不變。
 * - 11/28：負責人可以自己劃 VIP 座位：VIP 排＋2 樓第 1–12 排的空位（可賣的空位與 VIP 排；保留席、輪椅席、年代、揪團贈席不行）；
 *   每席一筆 VIP（類別 VIP、不寄信），票卡馬上出現在頁面。不能自己取消，要取消請找後台。
 * 設定存 app_setting `vipcard`（全場一條，可停用、換新連結）。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ticketData, linkUrl } from './admin';
import { BookingError } from './booking';
import { qrSecret, qrValue } from './qr';
import { createVip } from './vip';
import { seatLabel } from './layout';
import type { ViewSeatStatus } from './booking';

const KEY = 'vipcard';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_MIN = 10;
const OTP_TRIES = 5;
/** 負責人自己劃位：2 樓第 1–N 排（加 VIP 排） */
export const VIP_SELF_ROWS = 12;
/** 沒有姓名（空白、只有符號、待定之類） */
export const blankName = (s: string | null | undefined) => /^[\s\-—_?？.。、]*$|^(待定|未定|待補|保留|空|無)$/.test((s ?? '').trim());

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

async function linkOf(db: Db, code: string, admin = false) {
  const l = await getVipCard(db);
  if (!l || l.code !== code) throw new BookingError('LINK_NOT_FOUND', '連結不存在或已更換，請向主辦方索取新連結。');
  if (l.status !== 'on' && !admin) throw new BookingError('LINK_CLOSED', '這條連結目前停用中，請聯絡主辦方。');
  return l;
}
/**
 * 誰在操作：負責人（這支手機的通行碼）或已登入後台的系統管理員（11/28：系統管理員不用驗證碼直接進，
 * 停用中也能看；操作紀錄記系統管理員本人，不影響負責人的登入）。由 API 依後台登入 cookie 判斷，前端送不進來。
 */
export type VcAuth = string | { admin: string };
async function authed(db: Db, code: string, auth: VcAuth, now: Date) {
  if (typeof auth === 'object') {
    const l = await linkOf(db, code, true);
    return Object.assign(l, { actor: `系統管理員:${auth.admin}`, asAdmin: true });
  }
  const l = await linkOf(db, code);
  const h = sha(auth || '-');
  if (!auth || !l.devices.some((d) => d.h === h && Date.parse(d.exp) > now.getTime())) throw new BookingError('AUTH', '請先驗證 Email。');
  return Object.assign(l, { actor: `VIP負責人:${l.name}`, asAdmin: false });
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
  await db.insert(t.notification).values({ channel: 'email', template: 'vip_otp', recipient: l.email, content: `【${ev.name}】${l.name} 您好，VIP 票卡頁的驗證碼是 ${otp}，${OTP_MIN} 分鐘內有效。請回到 VIP 票卡頁輸入驗證碼。如果不是您本人操作，請忽略這封信。${base ? `${base.replace(/\/$/, '')}/vc/${l.code}` : ''}` });
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
export async function vipCardPage(db: Db, code: string, token: VcAuth, now = new Date()) {
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
      serial: tk.serial, value: qrValue(secret, tk.serial), seat: tk.label, seatId: tk.seatId, name: blankName(tk.holderName) ? '' : tk.holderName, needName: blankName(tk.holderName), org: o.vipOrg,
      orderId: o.id, email: o.buyerEmail ? maskEmail(o.buyerEmail) : '', sentAt: sent?.sentAt?.toISOString() ?? null,
      sending: !!queued && (!queued.sendAfter || queued.sendAfter <= now), entered: used.some((u) => u.serial === tk.serial),
    };
  });
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, leader: l.name, cards, asAdmin: l.asAdmin, off: l.status !== 'on',
    total: os.length, sent: os.filter((o) => notes.some((x) => x.orderId === o.id && x.status === 'sent')).length,
  };
}

/** 寄給本人：可填新 Email（會存進那位 VIP 的資料）；寄一封只有他自己 QR 的信；2 分鐘內不重寄 */
export async function vipCardSend(db: Db, code: string, token: VcAuth, v: { orderId: number; email?: string }, base: string, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, v.orderId), eq(t.orders.eventId, ev.id), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, 'VIP')));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這位 VIP，請重新整理頁面。');
  const email = (v.email ?? '').trim().toLowerCase() || o.buyerEmail || '';
  if (!email) throw new BookingError('INVALID', '請填這位 VIP 的 Email。');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不對');
  const [last] = await db.select().from(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.channel, 'email'))).orderBy(desc(t.notification.createdAt)).limit(1);
  // 時間差要 ≥ 0：測試用的 now 比資料庫寫入時間早時不算（之前 11/28 10:00 後測試會壞）
  const ago = last ? now.getTime() - last.createdAt.getTime() : -1;
  if (last && ago >= 0 && ago < 120_000) throw new BookingError('TOO_MANY', '剛剛寄過了，請 2 分鐘後再試。');
  const [lk] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.id, o.linkId));
  const seats = (await ticketData(db, [o.id])).tickets.map((x) => x.label).join('、');
  const when = ev.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const content = `【${ev.name}】${o.buyerName ?? ''} 您好，主辦單位誠摯邀請您蒞臨，已為您保留座位：${seats}。演出時間 ${when}。入場 QR code 附在本信，也可至您的劃位頁查看：${linkUrl(lk.code, base)}`;
  await db.transaction(async (tx) => {
    // 寄過就不再「演出前自動寄」：清掉排程、寄送方式改成「立即寄」
    await tx.delete(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.status, 'queued')));
    await tx.update(t.orders).set({ buyerEmail: email, notifyMode: 'now' }).where(eq(t.orders.id, o.id));
    await tx.insert(t.notification).values({ orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: email, content, createdAt: now });
    await tx.insert(t.auditLog).values({ actor: l.actor, action: 'vipcard_send', target: `order:${o.id}`, detail: JSON.stringify({ email, before: o.buyerEmail }) });
  });
  return { to: maskEmail(email) };
}

/** 補填姓名：只能填空白的（已有姓名的不能改）；QR 不變 */
export async function vipCardName(db: Db, code: string, token: VcAuth, v: { orderId: number; seatId: string; name: string }, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const name = v.name.trim().slice(0, 60);
  if (blankName(name)) throw new BookingError('INVALID', '請填姓名職稱');
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, v.orderId), eq(t.orders.eventId, ev.id), eq(t.orders.vip, true), eq(t.orders.status, 'paid'), eq(t.orders.vipCat, 'VIP')));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這位 VIP，請重新整理頁面。');
  const [os] = await db.select().from(t.orderSeat).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, v.seatId)));
  if (!os) throw new BookingError('NOT_FOUND', '找不到這個座位，請重新整理頁面。');
  if (!blankName(os.holderName)) throw new BookingError('INVALID', '這席已經有姓名了，要修改請聯絡主辦方。');
  await db.transaction(async (tx) => {
    await tx.update(t.orderSeat).set({ holderName: name }).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, v.seatId)));
    if (blankName(o.buyerName)) {
      await tx.update(t.orders).set({ buyerName: name }).where(eq(t.orders.id, o.id));
      await tx.update(t.inviteLink).set({ name }).where(eq(t.inviteLink.id, o.linkId));
    }
    await tx.insert(t.auditLog).values({ actor: l.actor, action: 'vipcard_name', target: `order:${o.id}`, detail: JSON.stringify({ seatId: v.seatId, name }) });
  });
  return { ok: true };
}

/** 負責人自己劃位：座位圖（VIP 排＋2 樓第 1–12 排） */
async function selfSeats(db: Db, eventId: number) {
  return db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, code: t.venueSeat.code, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, sellable: t.seatUsage.sellable, usage: t.seatUsage.code,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.venueSeat.floor, '2M')));
}
type SelfSeat = Awaited<ReturnType<typeof selfSeats>>[number];
const inRange = (s: SelfSeat, vipInstalled: boolean) => (s.seatType === 'vip' ? vipInstalled : s.seatType !== 'wheelchair' && s.rowNo != null && s.rowNo >= 1 && s.rowNo <= VIP_SELF_ROWS);
const canTake = (s: SelfSeat) => s.status === 'free' && !['join-gift', 'era-sold'].includes(s.usage) && (s.sellable || s.seatType === 'vip');

export async function vipCardSeatMap(db: Db, code: string, token: VcAuth, now = new Date()) {
  await authed(db, code, token, now);
  const ev = await ev0(db);
  const zones = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), eq(t.priceZone.floor, '2M')));
  const rows = (await selfSeats(db, ev.id)).filter((s) => inRange(s, ev.vipInstalled));
  return {
    vipInstalled: ev.vipInstalled, rows: VIP_SELF_ROWS,
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, gift: z.price === 0 })),
    seats: rows.map((s) => ({
      id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), zoneId: s.zoneId, bundle: null as string | null,
      status: (canTake(s) ? 'free' : s.status !== 'free' ? 'sold' : 'blocked') as ViewSeatStatus,
    })),
  };
}

/** 負責人自己劃位：每席一筆 VIP（類別 VIP、不寄信）；任何一席不行就都不建立 */
export async function vipCardBook(db: Db, code: string, token: VcAuth, v: { seats: { seatId: string; name: string }[]; org?: string }, now = new Date()) {
  const l = await authed(db, code, token, now);
  const ev = await ev0(db);
  const list = v.seats.map((x) => ({ seatId: x.seatId, name: x.name.trim().slice(0, 60) }));
  if (!list.length) throw new BookingError('INVALID', '請先選座位');
  if (list.length > 20) throw new BookingError('INVALID', '一次最多 20 席');
  if (new Set(list.map((x) => x.seatId)).size !== list.length) throw new BookingError('INVALID', '座位重複了');
  if (list.some((x) => blankName(x.name))) throw new BookingError('INVALID', '每一席都要填姓名職稱');
  const all = await selfSeats(db, ev.id);
  const pick = list.map((x) => all.find((s) => s.id === x.seatId));
  if (pick.some((s) => !s || !inRange(s, ev.vipInstalled))) throw new BookingError('INVALID', `只能選 VIP 排和 2 樓第 1–${VIP_SELF_ROWS} 排的座位`);
  const taken = pick.filter((s) => !canTake(s!));
  if (taken.length) throw new BookingError('SEAT_TAKEN', `${taken.map((s) => seatLabel(s!)).join('、')} 已經不能選了，請重新選。`, taken.map((s) => s!.id));
  const org = (v.org ?? '').trim().slice(0, 60);
  const done: string[] = [];
  for (const x of list) {
    try {
      await createVip(db, l.actor, { name: x.name, phone: '', email: '', seatIds: [x.seatId], mode: 'none', cat: 'VIP', org, holders: [x.name], note: `${l.asAdmin ? '系統管理員從 VIP 票卡頁' : 'VIP 負責人自己'}劃位 ${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}` });
      done.push(x.seatId);
    } catch (e) {
      const lb = (id: string) => seatLabel(all.find((s) => s.id === id)!);
      throw new BookingError('SEAT_TAKEN', `${done.length ? `已完成 ${done.map(lb).join('、')}；` : ''}${lb(x.seatId)} 沒有成功（${(e as Error).message}），請重新選。`);
    }
  }
  return { count: done.length };
}
