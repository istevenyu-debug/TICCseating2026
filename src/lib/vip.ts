/**
 * 招待（VIP）：特定人士、未付費，由主管或網管在後台直接選位。
 *
 * - 建立後座位立即保留（已售出），金額 0、不開發票，統計另外列。
 * - 寄送方式：scheduled 演出前 N 天自動寄出（每場可設定 N，預設 3）／now 立即寄／none 不寄（印紙本入場券親手交）。
 *   排程寄送：通知先排進佇列，send_after 到了才寄（系統開著時每 30 秒檢查一次）。
 * - 寄出前可改座位、改寄送方式、取消；寄出內容含座位與「我的劃位」連結（QR code 在信內與劃位頁）。
 */
import { randomInt } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { seatLabel } from './layout';
import { linkUrl } from './admin';

export type VipMode = 'scheduled' | 'now' | 'none';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 演出前 N 天的上午 10 點（台北時間）；已經過了就回傳 null（立即寄） */
export function vipSendAt(showAt: Date, days: number, now = new Date()): Date | null {
  const day = new Date(showAt.getTime() - days * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const at = new Date(`${day}T10:00:00+08:00`);
  return at > now ? at : null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** 招待用的購票方式：用「單張購票」；沒有就建立一個不公開的 */
async function vipCombo(tx: Tx, eventId: number) {
  const [c] = await tx.select().from(t.combo).where(and(eq(t.combo.eventId, eventId), eq(t.combo.isSingle, true))).limit(1);
  if (c) return c.id;
  const [n] = await tx.insert(t.combo).values({ eventId, name: '招待', isSingle: true, active: false, sort: 99 }).returning();
  return n.id;
}

/** 檢查座位可用，並把連座組裡沒被選到的座位改回單人（招待可以只拿連座的一部分） */
async function takeSeats(tx: Tx, eventId: number, seatIds: string[], orderId: number) {
  const ids = [...new Set(seatIds)];
  if (!ids.length) throw new BookingError('INVALID', '請在座位圖上選取座位');
  if (ids.length > 60) throw new BookingError('INVALID', '一次最多 60 席');
  const es = await tx.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.seatId, ids)));
  if (es.length !== ids.length) throw new BookingError('INVALID', '有座位不存在');
  const busy = es.filter((s) => s.status !== 'free' && s.orderId !== orderId);
  if (busy.length) throw new BookingError('SEAT_TAKEN', `${busy.length} 席已有人訂，請重新選取。`, busy.map((s) => s.seatId));
  const bundles = [...new Set(es.map((s) => s.bundle).filter((b): b is string => !!b))];
  if (bundles.length) await tx.update(t.eventSeat).set({ bundle: null }).where(and(eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.bundle, bundles)));
  const got = await tx.update(t.eventSeat).set({ status: 'sold', orderId, holdUntil: null, bundle: null, version: sql`${t.eventSeat.version} + 1` })
    .where(and(eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.seatId, ids), sql`(${t.eventSeat.status} = 'free' OR ${t.eventSeat.orderId} = ${orderId})`))
    .returning({ id: t.eventSeat.seatId });
  if (got.length !== ids.length) throw new BookingError('SEAT_TAKEN', '有座位剛被訂走，請重新選取。');
  return { ids, brokeBundles: bundles.length };
}

async function seatText(tx: Tx | Db, orderId: number) {
  const seats = await tx.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code })
    .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(eq(t.orderSeat.orderId, orderId))
    .orderBy(t.venueSeat.y, t.venueSeat.x);
  return seats.map((s) => `${seatLabel(s)}（${s.code}）`).join('、');
}

function vipMessage(evName: string, showAt: Date, name: string, seats: string, url: string) {
  const when = showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return `【${evName}】${name} 您好，主辦單位誠摯邀請您蒞臨，已為您保留座位：${seats}。演出時間 ${when}。入場 QR code 附在本信，也可至您的劃位頁查看：${url}`;
}

/** 依寄送方式重排這筆招待的通知（尚未寄出的才會被換掉） */
async function scheduleNotice(tx: Tx, ev: typeof t.event.$inferSelect, o: typeof t.orders.$inferSelect, mode: VipMode, base?: string) {
  await tx.delete(t.notification).where(and(eq(t.notification.orderId, o.id), eq(t.notification.status, 'queued')));
  if (mode === 'none') return null;
  const [lk] = await tx.select().from(t.inviteLink).where(eq(t.inviteLink.id, o.linkId));
  const at = mode === 'scheduled' ? vipSendAt(ev.showAt, ev.vipNotifyDays) : null;
  const content = vipMessage(ev.name, ev.showAt, o.buyerName ?? '', await seatText(tx, o.id), linkUrl(lk.code, base));
  const rows = [
    ...(o.buyerEmail ? [{ orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: o.buyerEmail, content, sendAfter: at }] : []),
    ...(o.buyerPhone ? [{ orderId: o.id, linkId: o.linkId, channel: 'sms', template: 'order_confirmed', recipient: o.buyerPhone, content, sendAfter: at }] : []),
  ];
  if (!rows.length) throw new BookingError('INVALID', '要寄出劃位資料，請填 Email 或手機；不寄的話請選「不寄，印紙本入場券」。');
  await tx.insert(t.notification).values(rows);
  return at;
}

export async function createVip(db: Db, actor: string, v: { name: string; phone: string; email: string; seatIds: string[]; mode: VipMode; note?: string }, base?: string) {
  const ev = await currentEvent(db);
  const name = v.name.trim();
  if (!name) throw new BookingError('INVALID', '請填寫招待對象姓名');
  return db.transaction(async (tx) => {
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const c = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
      const [ex] = await tx.select({ id: t.inviteLink.id }).from(t.inviteLink).where(eq(t.inviteLink.code, c));
      if (!ex) code = c;
    }
    const expiresAt = new Date(`${ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}T23:59:59+08:00`);
    const [lk] = await tx.insert(t.inviteLink).values({ eventId: ev.id, code, kind: 'vip', name, phone: v.phone, quota: v.seatIds.length, expiresAt, note: v.note ?? '' }).returning();
    const [o0] = await tx.insert(t.orders).values({
      eventId: ev.id, linkId: lk.id, comboId: await vipCombo(tx, ev.id), sets: 1, status: 'paid', amount: 0, vip: true, notifyMode: v.mode,
      buyerName: name, buyerPhone: v.phone || null, buyerEmail: v.email || null, submittedAt: new Date(), seenAt: new Date(),
    }).returning();
    const orderNo = `T${ev.id}-${String(o0.id).padStart(5, '0')}`;
    const [o] = await tx.update(t.orders).set({ orderNo }).where(eq(t.orders.id, o0.id)).returning();
    const { ids, brokeBundles } = await takeSeats(tx, ev.id, v.seatIds, o.id);
    await tx.insert(t.orderSeat).values(ids.map((seatId, i) => ({ orderId: o.id, seatId, unitPrice: 0, holderName: i === 0 ? name : `${name}${String(i + 1).padStart(2, '0')}`, holderId4: '' })));
    const at = await scheduleNotice(tx, ev, o, v.mode, base);
    await tx.insert(t.auditLog).values({ actor, action: 'vip_create', target: `order:${o.id}`, detail: JSON.stringify({ name, seats: ids, mode: v.mode }) });
    return { orderId: o.id, orderNo, sendAt: at?.toISOString() ?? null, brokeBundles };
  });
}

async function vipOrder(tx: Tx, id: number) {
  const [o] = await tx.select().from(t.orders).where(eq(t.orders.id, id)).for('update');
  if (!o || !o.vip) throw new BookingError('NOT_FOUND', '找不到這筆招待');
  if (o.status !== 'paid') throw new BookingError('INVALID', '這筆招待已取消');
  return o;
}

/** 改座位：放掉原座位、換成新選的；還沒寄出的通知內容一併更新 */
export async function updateVipSeats(db: Db, actor: string, id: number, seatIds: string[], base?: string) {
  const ev = await currentEvent(db);
  return db.transaction(async (tx) => {
    const o = await vipOrder(tx, id);
    const old = await tx.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    const keep = new Set(seatIds);
    const drop = old.filter((s) => !keep.has(s.seatId)).map((s) => s.seatId);
    if (drop.length) await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, drop)));
    const { ids } = await takeSeats(tx, ev.id, seatIds, id);
    await tx.delete(t.checkin).where(and(eq(t.checkin.orderId, id), inArray(t.checkin.seatId, drop.length ? drop : ['-'])));
    await tx.delete(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    const name = o.buyerName ?? '';
    await tx.insert(t.orderSeat).values(ids.map((seatId, i) => ({ orderId: id, seatId, unitPrice: 0, holderName: i === 0 ? name : `${name}${String(i + 1).padStart(2, '0')}`, holderId4: '' })));
    await tx.update(t.inviteLink).set({ quota: ids.length }).where(eq(t.inviteLink.id, o.linkId));
    const queued = await tx.select({ id: t.notification.id }).from(t.notification).where(and(eq(t.notification.orderId, id), eq(t.notification.status, 'queued')));
    if (queued.length) await scheduleNotice(tx, ev, o, o.notifyMode as VipMode, base);
    await tx.insert(t.auditLog).values({ actor, action: 'vip_seats', target: `order:${id}`, detail: JSON.stringify({ seats: ids }) });
    return { seats: ids.length };
  });
}

/** 改寄送方式（只影響還沒寄出的；已寄出又選「立即寄」會再寄一次） */
export async function setVipMode(db: Db, actor: string, id: number, mode: VipMode, base?: string) {
  const ev = await currentEvent(db);
  return db.transaction(async (tx) => {
    const o = await vipOrder(tx, id);
    await tx.update(t.orders).set({ notifyMode: mode }).where(eq(t.orders.id, id));
    const at = await scheduleNotice(tx, ev, { ...o, notifyMode: mode }, mode, base);
    await tx.insert(t.auditLog).values({ actor, action: 'vip_mode', target: `order:${id}`, detail: mode });
    return { sendAt: at?.toISOString() ?? null };
  });
}

export async function cancelVip(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  await db.transaction(async (tx) => {
    const o = await vipOrder(tx, id);
    await tx.update(t.eventSeat).set({ status: 'free', orderId: null, version: sql`${t.eventSeat.version} + 1` }).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.orderId, id)));
    await tx.delete(t.notification).where(and(eq(t.notification.orderId, id), eq(t.notification.status, 'queued')));
    await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'vip_cancel' }).where(eq(t.orders.id, id));
    await tx.update(t.inviteLink).set({ status: 'disabled' }).where(eq(t.inviteLink.id, o.linkId));
    await tx.insert(t.auditLog).values({ actor, action: 'vip_cancel', target: `order:${id}`, detail: o.buyerName });
  });
}

/** 改「演出前幾天寄」：還沒寄出的排程一起改時間 */
export async function setVipDays(db: Db, actor: string, days: number) {
  const ev = await currentEvent(db);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new BookingError('INVALID', '天數請填 0–60');
  await db.update(t.event).set({ vipNotifyDays: days }).where(eq(t.event.id, ev.id));
  const at = vipSendAt(ev.showAt, days);
  const ids = (await db.select({ id: t.orders.id }).from(t.orders).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.vip, true), eq(t.orders.notifyMode, 'scheduled')))).map((x) => x.id);
  if (ids.length) await db.update(t.notification).set({ sendAfter: at }).where(and(inArray(t.notification.orderId, ids), eq(t.notification.status, 'queued')));
  await db.insert(t.auditLog).values({ actor, action: 'vip_days', target: `event:${ev.id}`, detail: String(days) });
  return { sendAt: at?.toISOString() ?? null };
}

export async function listVips(db: Db) {
  const ev = await currentEvent(db);
  const os = await db.select().from(t.orders).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.vip, true))).orderBy(t.orders.id);
  const ids = os.map((o) => o.id);
  const seats = ids.length ? await db.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code })
    .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(inArray(t.orderSeat.orderId, ids)) : [];
  const notes = ids.length ? await db.select().from(t.notification).where(inArray(t.notification.orderId, ids)) : [];
  const links = ids.length ? await db.select({ id: t.inviteLink.id, code: t.inviteLink.code }).from(t.inviteLink).where(inArray(t.inviteLink.id, os.map((o) => o.linkId))) : [];
  return {
    days: ev.vipNotifyDays, defaultSendAt: vipSendAt(ev.showAt, ev.vipNotifyDays)?.toISOString() ?? null,
    list: os.map((o) => {
      const n = notes.filter((x) => x.orderId === o.id);
      const queued = n.find((x) => x.status === 'queued');
      const sent = n.filter((x) => x.status === 'sent').map((x) => x.sentAt!).sort((a, b) => +b - +a)[0];
      return {
        id: o.id, orderNo: o.orderNo, status: o.status, name: o.buyerName ?? '', phone: o.buyerPhone ?? '', email: o.buyerEmail ?? '', mode: o.notifyMode,
        seats: seats.filter((s) => s.orderId === o.id).map((s) => ({ id: s.seatId, label: seatLabel(s), code: s.code })),
        sendAt: queued ? (queued.sendAfter?.toISOString() ?? 'now') : null, sentAt: sent?.toISOString() ?? null,
        failed: n.some((x) => x.status === 'failed' || x.status === 'simulated'), code: links.find((l) => l.id === o.linkId)?.code ?? '',
      };
    }),
  };
}

