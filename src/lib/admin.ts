/**
 * 後台邏輯：席位用途、票種、依排數與區塊指定座位、購票方式（組合票）、發布、
 * 專屬連結、訂單（暫存／待確認／確認到帳／取消／刪除）、統計。
 *
 * 所有會改動資料的函式都會寫入 audit_log，actor 為後台帳號名稱。
 */
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import {
  ACTIVE_ORDER, BookingError, freeSeatsOf, loadCombos, sweepExpired, usedComboSets,
} from './booking';
import { BLOCKS, rowKey, seatLabel, type Block } from './layout';

export const COLOR_PRESETS = [
  '#b8ccf3', '#c4e5cf', '#f0dbb1', '#e6c3e5', '#bde2ea', '#f5c4c4', '#d9e7a8', '#c9c2f0', '#ffd29d',
  '#ffadad', '#9fd8c8', '#d3d3d3', '#4f7bd8', '#2f9a62', '#d9822b', '#c0392b', '#8e44ad', '#555e70',
];

const audit = (db: Db, actor: string, action: string, target: string, detail?: unknown) =>
  db.insert(t.auditLog).values({ actor, action, target, detail: detail === undefined ? null : JSON.stringify(detail) });

/** MVP 為主辦方自用、單一場次：取最新的場次 */
export async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(desc(t.event.id)).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '尚未建立場次，請先執行 npm run db:seed。');
  return ev;
}

/* ---------- 讀取整份後台狀態 ---------- */

export async function getAdminState(db: Db, now = new Date()) {
  const ev = await currentEvent(db);
  await sweepExpired(db, ev.id, now);
  const [evNow] = await db.select().from(t.event).where(eq(t.event.id, ev.id));

  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort), asc(t.priceZone.id));
  const usages = await db.select().from(t.seatUsage).where(eq(t.seatUsage.eventId, ev.id)).orderBy(asc(t.seatUsage.id));
  const combos = await loadCombos(db, ev.id);
  const sets = await usedComboSets(db, ev.id);

  const seatRows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo,
    seatType: t.venueSeat.seatType, block: t.venueSeat.block, code: t.venueSeat.code,
    zoneId: t.eventSeat.zoneId, usageId: t.eventSeat.usageId, status: t.eventSeat.status, orderId: t.eventSeat.orderId,
  }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .where(eq(t.eventSeat.eventId, ev.id));
  const seats = seatRows.map((s) => ({
    id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, block: s.block, code: s.code,
    row: rowKey(s), label: seatLabel(s), zoneId: s.zoneId, usageId: s.usageId, status: s.status, orderId: s.orderId,
    installed: s.seatType !== 'vip' || evNow.vipInstalled,
  }));
  const seatById = Object.fromEntries(seats.map((s) => [s.id, s]));

  const orderRows = await db.select().from(t.orders).where(eq(t.orders.eventId, ev.id)).orderBy(desc(t.orders.id));
  const ids = orderRows.map((o) => o.id);
  const oseats = ids.length ? await db.select().from(t.orderSeat).where(inArray(t.orderSeat.orderId, ids)) : [];
  const pays = ids.length ? await db.select().from(t.payment).where(inArray(t.payment.orderId, ids)) : [];
  const links = await db.select().from(t.inviteLink).where(eq(t.inviteLink.eventId, ev.id)).orderBy(desc(t.inviteLink.id));
  const linkById = Object.fromEntries(links.map((l) => [l.id, l]));
  const comboById = Object.fromEntries(combos.map((c) => [c.id, c]));

  const orders = orderRows.map((o) => {
    const p = pays.find((x) => x.orderId === o.id);
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, amount: o.amount, comboName: comboById[o.comboId]?.name ?? '',
      buyerName: o.buyerName ?? linkById[o.linkId]?.name ?? '', buyerPhone: o.buyerPhone ?? '', buyerEmail: o.buyerEmail ?? '',
      linkCode: linkById[o.linkId]?.code ?? '',
      createdAt: o.createdAt.toISOString(), submittedAt: o.submittedAt?.toISOString() ?? null,
      holdUntil: o.holdUntil?.toISOString() ?? null, payDueAt: o.payDueAt?.toISOString() ?? null,
      isNew: o.status === 'pending' && !o.seenAt, closedReason: o.closedReason,
      seats: oseats.filter((s) => s.orderId === o.id).map((s) => ({
        seatId: s.seatId, code: seatById[s.seatId]?.code ?? s.seatId, label: seatById[s.seatId]?.label ?? s.seatId,
        holderName: s.holderName, holderId4: s.holderId4, unitPrice: s.unitPrice,
      })),
      payment: p ? {
        last5: p.reportedLast5, amount: p.reportedAmount, time: p.reportedAt,
        confirmedDate: p.confirmedDate, confirmedAmount: p.confirmedAmount, confirmedBy: p.confirmedBy, note: p.note,
      } : null,
    };
  });

  const usedByLink = new Map<number, number>();
  orderRows.filter((o) => o.status === 'pending' || o.status === 'paid').forEach((o) => {
    usedByLink.set(o.linkId, (usedByLink.get(o.linkId) ?? 0) + oseats.filter((s) => s.orderId === o.id).length);
  });

  const usageById = Object.fromEntries(usages.map((u) => [u.id, u]));
  const inst = seats.filter((s) => s.installed);
  const stats = {
    total: inst.length,
    sale: inst.filter((s) => s.status === 'free' && usageById[s.usageId]?.sellable).length,
    held: inst.filter((s) => s.status === 'held').length,
    pending: inst.filter((s) => s.status === 'pending').length,
    sold: inst.filter((s) => s.status === 'sold').length,
    reserved: inst.filter((s) => s.status === 'free' && !usageById[s.usageId]?.sellable).length,
    revenue: orders.filter((o) => o.status === 'paid').reduce((a, o) => a + (o.payment?.confirmedAmount ?? o.amount), 0),
    newOrders: orders.filter((o) => o.isNew).length,
  };

  const draft = draftOf(evNow, zones, combos);
  const pub = evNow.published;
  const dirty = !pub || pub.open !== draft.open
    || [...pub.zoneIds].sort((a, b) => a - b).join() !== draft.zoneIds.join()
    || [...pub.comboIds].sort((a, b) => a - b).join() !== draft.comboIds.join();

  return {
    now: now.toISOString(),
    event: {
      id: evNow.id, name: evNow.name, showAt: evNow.showAt.toISOString(), vipInstalled: evNow.vipInstalled, saleOpen: evNow.saleOpen,
      saleStart: evNow.saleStart?.toISOString() ?? null, saleEnd: evNow.saleEnd?.toISOString() ?? null,
      maxPerOrder: evNow.maxPerOrder, holdMinutes: evNow.holdMinutes, payHours: evNow.payHours,
      bankName: evNow.bankName, bankAccount: evNow.bankAccount, accountName: evNow.accountName,
    },
    published: pub, dirty,
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, price: z.price, open: z.open, seatCount: inst.filter((s) => s.zoneId === z.id).length })),
    usages: usages.map((u) => ({ id: u.id, code: u.code, name: u.name, sellable: u.sellable })),
    combos: combos.map((c) => ({ ...c, usedSets: sets[c.id] ?? 0 })),
    seats, orders,
    links: links.map((l) => ({
      id: l.id, code: l.code, name: l.name, phone: l.phone, quota: l.quota, used: usedByLink.get(l.id) ?? 0,
      expiresAt: l.expiresAt.toISOString(), status: l.status,
    })),
    stats,
  };
}

export type AdminState = Awaited<ReturnType<typeof getAdminState>>;

function draftOf(ev: typeof t.event.$inferSelect, zones: { id: number; open: boolean }[], combos: { id: number; active: boolean }[]) {
  return {
    open: ev.saleOpen,
    zoneIds: zones.filter((z) => z.open).map((z) => z.id).sort((a, b) => a - b),
    comboIds: combos.filter((c) => c.active).map((c) => c.id).sort((a, b) => a - b),
  };
}

/* ---------- 開放訂購與發布 ---------- */

export async function updateEventSettings(db: Db, actor: string, v: Partial<{
  name: string; saleOpen: boolean; saleStart: Date | null; saleEnd: Date | null; maxPerOrder: number; holdMinutes: number;
  payHours: number; bankName: string; bankAccount: string; accountName: string; vipInstalled: boolean;
}>) {
  const ev = await currentEvent(db);
  if (v.vipInstalled === false) {
    const [busy] = await db.select({ n: sql<number>`count(*)::int` }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.seatType, 'vip'), sql`${t.eventSeat.status} <> 'free'`));
    if (busy.n > 0) throw new BookingError('BUSY', `VIP 排已有 ${busy.n} 席有訂單，不能取消加裝。`);
  }
  await db.update(t.event).set(v).where(eq(t.event.id, ev.id));
  await audit(db, actor, 'event_settings', `event:${ev.id}`, v);
}

/** 把目前後台勾選的開放設定發布到購票頁 */
export async function publish(db: Db, actor: string, now = new Date()) {
  const ev = await currentEvent(db);
  const zones = await db.select({ id: t.priceZone.id, open: t.priceZone.open, name: t.priceZone.name, price: t.priceZone.price })
    .from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const combos = await loadCombos(db, ev.id);
  const d = draftOf(ev, zones, combos);
  const bad = zones.filter((z) => d.zoneIds.includes(z.id) && (!z.name || !(z.price > 0)));
  if (bad.length) throw new BookingError('INVALID', '有開放的票種還沒填名稱或票價，請先補齊再發布。');
  const badCombo = combos.filter((c) => d.comboIds.includes(c.id) && !c.isSingle && (!c.name || !(c.price > 0) || !c.items.length));
  if (badCombo.length) throw new BookingError('INVALID', `組合「${badCombo[0].name || '未命名'}」還沒填完名稱、內容或套票價格，請先補齊再發布。`);
  const published: t.Published = { ...d, at: now.toISOString() };
  await db.update(t.event).set({ published }).where(eq(t.event.id, ev.id));
  await audit(db, actor, 'publish', `event:${ev.id}`, published);
  return published;
}

/* ---------- 票種 ---------- */

export async function createZone(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const used = new Set(zones.map((z) => z.color.toLowerCase()));
  const color = COLOR_PRESETS.find((c) => !used.has(c)) ?? COLOR_PRESETS[0];
  const [z] = await db.insert(t.priceZone).values({
    eventId: ev.id, name: '', price: 0, color, sort: Math.max(0, ...zones.map((x) => x.sort)) + 1,
  }).returning();
  await audit(db, actor, 'zone_create', `zone:${z.id}`);
  return z;
}

export async function updateZone(db: Db, actor: string, id: number, v: Partial<{ name: string; price: number; color: string; open: boolean }>) {
  if (v.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.color)) throw new BookingError('INVALID', '顏色格式不正確');
  await db.update(t.priceZone).set(v).where(eq(t.priceZone.id, id));
  await audit(db, actor, 'zone_update', `zone:${id}`, v);
}

export async function deleteZone(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  const [z] = await db.select().from(t.priceZone).where(and(eq(t.priceZone.id, id), eq(t.priceZone.eventId, ev.id)));
  if (!z) throw new BookingError('NOT_FOUND', '找不到此票種');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.eventSeat).where(eq(t.eventSeat.zoneId, id));
  if (n > 0) throw new BookingError('BUSY', `「${z.name || '未命名'}」還有 ${n} 個座位，請先把這些座位改成其他票種再刪除。`);
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(t.comboItem).where(eq(t.comboItem.zoneId, id));
  if (m > 0) throw new BookingError('BUSY', `「${z.name || '未命名'}」還被組合票使用，請先修改組合內容。`);
  await db.delete(t.priceZone).where(eq(t.priceZone.id, id));
  await audit(db, actor, 'zone_delete', `zone:${id}`, z);
}

/** 依排數與區塊指定票種；blocks 為空代表全部區塊。已有訂單的座位不變。 */
export async function assignZoneByRule(db: Db, actor: string, zoneId: number, rows: number[], blocks: string[]) {
  const ev = await currentEvent(db);
  if (!rows.length) throw new BookingError('INVALID', '請選擇排數');
  const blk = new Set(blocks.length ? blocks : BLOCKS);
  const vs = await db.select().from(t.venueSeat);
  const target = vs.filter((s) => rows.includes(rowKey(s)) && blk.has(s.block as Block)).map((s) => s.id);
  return assignZoneSeats(db, actor, zoneId, target, ev.id);
}

export async function assignZoneSeats(db: Db, actor: string, zoneId: number, seatIds: string[], eventId?: number) {
  const evId = eventId ?? (await currentEvent(db)).id;
  if (!seatIds.length) return { updated: 0, skipped: 0 };
  const [z] = await db.select().from(t.priceZone).where(and(eq(t.priceZone.id, zoneId), eq(t.priceZone.eventId, evId)));
  if (!z) throw new BookingError('NOT_FOUND', '找不到此票種');
  const done = await db.update(t.eventSeat).set({ zoneId })
    .where(and(eq(t.eventSeat.eventId, evId), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free')))
    .returning({ seatId: t.eventSeat.seatId });
  await audit(db, actor, 'assign_zone', `zone:${zoneId}`, { count: done.length });
  return { updated: done.length, skipped: seatIds.length - done.length };
}

/* ---------- 席位用途 ---------- */

export async function setSeatUsage(db: Db, actor: string, usageId: number, seatIds: string[]) {
  const ev = await currentEvent(db);
  const [u] = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.id, usageId), eq(t.seatUsage.eventId, ev.id)));
  if (!u) throw new BookingError('NOT_FOUND', '找不到此用途');
  const done = await db.update(t.eventSeat).set({ usageId })
    .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free')))
    .returning({ seatId: t.eventSeat.seatId });
  await audit(db, actor, 'set_usage', `usage:${usageId}`, { count: done.length });
  return { updated: done.length, skipped: seatIds.length - done.length };
}

/* ---------- 購票方式（組合票） ---------- */

export async function createCombo(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort));
  const all = await db.select().from(t.combo).where(eq(t.combo.eventId, ev.id));
  const [c] = await db.insert(t.combo).values({ eventId: ev.id, name: '', price: 0, sort: Math.max(0, ...all.map((x) => x.sort)) + 1 }).returning();
  if (zones[0]) await db.insert(t.comboItem).values({ comboId: c.id, zoneId: zones[0].id, qty: 1 });
  await audit(db, actor, 'combo_create', `combo:${c.id}`);
  return c;
}

export async function updateCombo(db: Db, actor: string, id: number, v: Partial<{
  name: string; price: number; limitSets: number; active: boolean; items: { zoneId: number; qty: number }[];
}>) {
  const [c] = await db.select().from(t.combo).where(eq(t.combo.id, id));
  if (!c) throw new BookingError('NOT_FOUND', '找不到此購票方式');
  const { items, ...rest } = v;
  if (Object.keys(rest).length) await db.update(t.combo).set(rest).where(eq(t.combo.id, id));
  if (items && !c.isSingle) {
    const merged = new Map<number, number>();
    items.filter((i) => i.qty > 0).forEach((i) => merged.set(i.zoneId, (merged.get(i.zoneId) ?? 0) + i.qty));
    await db.delete(t.comboItem).where(eq(t.comboItem.comboId, id));
    if (merged.size) await db.insert(t.comboItem).values([...merged].map(([zoneId, qty]) => ({ comboId: id, zoneId, qty })));
  }
  await audit(db, actor, 'combo_update', `combo:${id}`, v);
}

export async function deleteCombo(db: Db, actor: string, id: number) {
  const [c] = await db.select().from(t.combo).where(eq(t.combo.id, id));
  if (!c) throw new BookingError('NOT_FOUND', '找不到此購票方式');
  if (c.isSingle) throw new BookingError('INVALID', '單張購票不能刪除，可改為不開放。');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.orders).where(eq(t.orders.comboId, id));
  if (n > 0) throw new BookingError('BUSY', `「${c.name}」已有訂單，不能刪除，可改為不開放。`);
  await db.delete(t.combo).where(eq(t.combo.id, id));
  await audit(db, actor, 'combo_delete', `combo:${id}`, c);
}

/* ---------- 專屬連結 ---------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function linkUrl(code: string) {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}/t/${code}`;
}

export async function createInviteLink(db: Db, actor: string, v: { name: string; phone: string; quota: number; expiresAt: Date }) {
  const ev = await currentEvent(db);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const [exists] = await db.select({ id: t.inviteLink.id }).from(t.inviteLink).where(eq(t.inviteLink.code, code));
    if (exists) continue;
    const [l] = await db.insert(t.inviteLink).values({ eventId: ev.id, code, ...v }).returning();
    await db.insert(t.notification).values({
      linkId: l.id, channel: 'sms', template: 'invite', recipient: v.phone,
      content: `【${ev.name}】${v.name} 您好，您的專屬購票連結：${linkUrl(code)} 可訂 ${v.quota} 張。`,
    });
    await audit(db, actor, 'link_create', `link:${l.id}`, { name: v.name, quota: v.quota });
    return l;
  }
  throw new BookingError('SERVER', '產生連結代碼失敗，請再試一次。');
}

export async function updateInviteLink(db: Db, actor: string, id: number, v: Partial<{ quota: number; expiresAt: Date; status: 'active' | 'disabled' }>) {
  await db.update(t.inviteLink).set(v).where(eq(t.inviteLink.id, id));
  await audit(db, actor, 'link_update', `link:${id}`, v);
}

/* ---------- 訂單 ---------- */

export function confirmMessage(eventName: string, o: { buyerName: string | null; orderNo: string | null }, amount: number, seatText: string, showAt: Date) {
  const when = showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `【${eventName}】${o.buyerName ?? ''} 您好，已確認收到您的匯款 NT$${amount.toLocaleString('en-US')}。劃位成功：${seatText}。訂單編號 ${o.orderNo}，演出時間 ${when}。入場時請攜帶身分證件核對實名。`;
}

export async function markOrderSeen(db: Db, id: number, now = new Date()) {
  await db.update(t.orders).set({ seenAt: now }).where(and(eq(t.orders.id, id), isNull(t.orders.seenAt)));
}

/** 確認到帳：座位改為已售出，並通知消費者劃位成功 */
export async function confirmPayment(db: Db, actor: string, id: number, v: { date: string; amount: number; note?: string }, now = new Date()) {
  const ev = await currentEvent(db);
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    if (o.status !== 'pending') throw new BookingError('INVALID', '只有「待確認到帳」的訂單可以確認到帳。');
    await tx.update(t.orders).set({ status: 'paid', seenAt: o.seenAt ?? now }).where(eq(t.orders.id, id));
    await tx.update(t.eventSeat).set({ status: 'sold', version: sql`${t.eventSeat.version} + 1` }).where(eq(t.eventSeat.orderId, id));
    await tx.update(t.payment).set({ confirmedDate: v.date, confirmedAmount: v.amount, confirmedBy: actor, note: v.note ?? null, confirmedAt: now })
      .where(eq(t.payment.orderId, id));
    const seats = await tx.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code })
      .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(eq(t.orderSeat.orderId, id));
    const seatText = seats.map((s) => `${seatLabel(s)}（${s.code}）`).join('、');
    const content = confirmMessage(ev.name, o, v.amount, seatText, ev.showAt);
    await tx.insert(t.notification).values([
      { orderId: id, linkId: o.linkId, channel: 'sms', template: 'order_confirmed', recipient: o.buyerPhone ?? '', content },
      { orderId: id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: o.buyerEmail ?? '', content },
    ]);
    await tx.insert(t.auditLog).values({ actor, action: 'confirm_payment', target: `order:${id}`, detail: JSON.stringify(v) });
    return { content };
  });
}

/** 取消訂單（暫存中或待確認到帳）：釋放座位，待確認的訂單會通知消費者 */
export async function cancelOrder(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    if (o.status !== 'held' && o.status !== 'pending') throw new BookingError('INVALID', '只有暫存中或待確認到帳的訂單可以取消。');
    await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'admin_cancel', holdUntil: null }).where(eq(t.orders.id, id));
    await freeSeatsOf(tx, [id]);
    if (o.status === 'pending') {
      const content = `【${ev.name}】訂單 ${o.orderNo} 已由主辦方取消，座位已釋放。如有疑問請聯繫主辦方。`;
      await tx.insert(t.notification).values([
        { orderId: id, linkId: o.linkId, channel: 'sms', template: 'order_cancelled', recipient: o.buyerPhone ?? '', content },
        { orderId: id, linkId: o.linkId, channel: 'email', template: 'order_cancelled', recipient: o.buyerEmail ?? '', content },
      ]);
    }
    await tx.insert(t.auditLog).values({ actor, action: 'cancel_order', target: `order:${id}` });
  });
}

/** 刪除訂單（測試資料清理用）：座位釋放，訂單內容完整記入操作紀錄 */
export async function deleteOrder(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    const seats = await tx.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    await freeSeatsOf(tx, [id]);
    await tx.update(t.notification).set({ orderId: null }).where(eq(t.notification.orderId, id));
    await tx.delete(t.payment).where(eq(t.payment.orderId, id));
    await tx.delete(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    await tx.delete(t.orders).where(eq(t.orders.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'delete_order', target: `order:${id}`, detail: JSON.stringify({ order: o, seats }) });
  });
}

/* ---------- 入場券 ---------- */

export async function ticketData(db: Db, orderIds: number[]) {
  const ev = await currentEvent(db);
  if (!orderIds.length) return { event: ev, tickets: [] };
  const rows = await db.select({
    orderId: t.orders.id, orderNo: t.orders.orderNo, status: t.orders.status, comboId: t.orders.comboId,
    seatId: t.orderSeat.seatId, holderName: t.orderSeat.holderName, holderId4: t.orderSeat.holderId4,
    rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code, entrance: t.venueSeat.entrance,
    zoneName: t.priceZone.name,
  }).from(t.orders)
    .innerJoin(t.orderSeat, eq(t.orderSeat.orderId, t.orders.id))
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId))
    .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, t.orders.eventId)))
    .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
    .where(and(eq(t.orders.eventId, ev.id), inArray(t.orders.id, orderIds), eq(t.orders.status, 'paid')))
    .orderBy(asc(t.orders.id), asc(t.venueSeat.y), asc(t.venueSeat.x));
  const combos = await loadCombos(db, ev.id);
  const n = new Map<number, number>();
  return {
    event: ev,
    tickets: rows.map((r) => {
      const k = (n.get(r.orderId) ?? 0) + 1;
      n.set(r.orderId, k);
      return {
        serial: `${r.orderNo}-${String(k).padStart(2, '0')}`, orderNo: r.orderNo, label: seatLabel(r), code: r.code,
        zoneName: r.zoneName, comboName: combos.find((c) => c.id === r.comboId)?.name ?? '',
        holderName: r.holderName ?? '', holderId4: r.holderId4 ?? '', entrance: r.entrance,
      };
    }),
  };
}

export { ACTIVE_ORDER };
