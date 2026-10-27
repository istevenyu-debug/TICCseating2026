/**
 * 訂位核心邏輯：查詢座位、暫存、放棄、送出、逾時釋放。
 * 所有時間相關函式都接受 now 參數，方便測試。
 *
 * 防止一位兩賣的關鍵：暫存時以「只在 status = 'free' 時才更新」的條件式 UPDATE 搶座位，
 * 實際更新筆數少於要求數量就整筆交易回滾。PostgreSQL 的列鎖保證同一座位只有一筆交易成功。
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { seatLabel } from './layout';
import { calcAmount, comboProblem } from './pricing';
import { submitInput, type SubmitInput } from './validation';

export class BookingError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

const ACTIVE_ORDER = ['held', 'pending', 'paid'];
const COUNTED_ORDER = ['pending', 'paid']; // 計入連結已訂張數

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

/* ---------- 連結與場次 ---------- */

async function loadLink(db: Exec, code: string, now: Date) {
  const [link] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, code));
  if (!link) throw new BookingError('LINK_NOT_FOUND', '找不到此購票連結，請確認網址是否完整。');
  if (link.status !== 'active') throw new BookingError('LINK_DISABLED', '此購票連結已停用，請聯繫主辦方。');
  if (link.expiresAt < now) throw new BookingError('LINK_EXPIRED', '此購票連結已過期，請聯繫主辦方。');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, link.eventId));
  return { link, ev };
}

export function saleState(ev: typeof t.event.$inferSelect, now: Date): 'open' | 'closed' | 'not_started' | 'ended' {
  if (!ev.saleOpen) return 'closed';
  if (ev.saleStart && now < ev.saleStart) return 'not_started';
  if (ev.saleEnd && now > ev.saleEnd) return 'ended';
  return 'open';
}

const SALE_MSG = { closed: '目前未開放訂購。', not_started: '尚未開始訂購。', ended: '訂購已截止。' } as const;

async function usedQuota(db: Exec, linkId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` })
    .from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId))
    .where(and(eq(t.orders.linkId, linkId), inArray(t.orders.status, COUNTED_ORDER)));
  return r?.n ?? 0;
}

async function usedComboSets(db: Exec, eventId: number): Promise<Record<number, number>> {
  const rows = await db.select({ comboId: t.orders.comboId, n: sql<number>`count(*)::int` })
    .from(t.orders)
    .where(and(eq(t.orders.eventId, eventId), inArray(t.orders.status, ACTIVE_ORDER)))
    .groupBy(t.orders.comboId);
  return Object.fromEntries(rows.map((r) => [r.comboId, r.n]));
}

/* ---------- 逾時釋放 ---------- */

async function freeSeatsOf(db: Exec, orderIds: number[]) {
  if (!orderIds.length) return;
  await db.update(t.eventSeat)
    .set({ status: 'free', orderId: null, holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
    .where(inArray(t.eventSeat.orderId, orderIds));
}

/** 釋放逾時的暫存與逾期未確認到帳的訂單。由每次請求與排程呼叫。 */
export async function sweepExpired(db: Db, eventId: number, now: Date) {
  await db.transaction(async (tx) => {
    const held = await tx.update(t.orders)
      .set({ status: 'expired', closedReason: 'hold_timeout', holdUntil: null })
      .where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'held'), lt(t.orders.holdUntil, now)))
      .returning({ id: t.orders.id });
    const pend = await tx.update(t.orders)
      .set({ status: 'expired', closedReason: 'pay_timeout' })
      .where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'pending'), lt(t.orders.payDueAt, now)))
      .returning({ id: t.orders.id, orderNo: t.orders.orderNo, linkId: t.orders.linkId, phone: t.orders.buyerPhone, email: t.orders.buyerEmail });
    await freeSeatsOf(tx, [...held, ...pend].map((o) => o.id));
    for (const o of pend) {
      const content = `訂單 ${o.orderNo} 逾期未確認到帳，已取消並釋放座位。如已匯款請聯繫主辦方。`;
      await tx.insert(t.notification).values([
        { orderId: o.id, linkId: o.linkId, channel: 'sms', template: 'order_expired', recipient: o.phone ?? '', content },
        { orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_expired', recipient: o.email ?? '', content },
      ]);
      await tx.insert(t.auditLog).values({ actor: 'system', action: 'order_expired', target: `order:${o.id}` });
    }
  });
}

/* ---------- 查詢 ---------- */

export type ViewSeatStatus = 'free' | 'mine' | 'held' | 'pending' | 'sold' | 'blocked';

export async function getBookingState(db: Db, code: string, now = new Date()) {
  const { link, ev } = await loadLink(db, code, now);
  await sweepExpired(db, ev.id, now);

  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const combos = await db.select().from(t.combo)
    .where(and(eq(t.combo.eventId, ev.id), eq(t.combo.active, true))).orderBy(t.combo.sort);
  const sets = await usedComboSets(db, ev.id);

  const myOrders = await db.select().from(t.orders)
    .where(eq(t.orders.linkId, link.id)).orderBy(t.orders.id);
  const myHeld = myOrders.find((o) => o.status === 'held') ?? null;

  const seatRows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo,
    seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, orderId: t.eventSeat.orderId,
    sellable: t.seatUsage.sellable,
  }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(eq(t.eventSeat.eventId, ev.id));

  const zoneCode = Object.fromEntries(zones.map((z) => [z.id, z.code]));
  const seats = seatRows
    .filter((s) => s.seatType !== 'vip' || ev.vipInstalled)
    .map((s) => {
      let status: ViewSeatStatus;
      if (myHeld && s.orderId === myHeld.id) status = 'mine';
      else if (s.status !== 'free') status = s.status as ViewSeatStatus;
      else if (!s.sellable) status = 'blocked';
      else status = 'free';
      return { id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, label: seatLabel(s), zone: zoneCode[s.zoneId], status };
    });

  const orderSeats = myOrders.length
    ? await db.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId, holderName: t.orderSeat.holderName })
      .from(t.orderSeat).where(inArray(t.orderSeat.orderId, myOrders.map((o) => o.id)))
    : [];
  const labelOf = Object.fromEntries(seats.map((s) => [s.id, s.label]));
  const comboById = Object.fromEntries(combos.map((c) => [c.id, c]));
  const used = await usedQuota(db, link.id);

  return {
    now: now.toISOString(),
    sale: saleState(ev, now),
    event: {
      name: ev.name, showAt: ev.showAt.toISOString(), vipInstalled: ev.vipInstalled,
      maxPerOrder: ev.maxPerOrder, holdMinutes: ev.holdMinutes, payHours: ev.payHours,
      bankName: ev.bankName, bankAccount: ev.bankAccount, accountName: ev.accountName,
    },
    link: { name: link.name, phoneTail: link.phone.slice(-3), quota: link.quota, used, expiresAt: link.expiresAt.toISOString() },
    canBuy: Math.max(0, Math.min(ev.maxPerOrder, link.quota - used)),
    zones: zones.map((z) => ({ code: z.code, name: z.name, color: z.color, price: z.price })),
    combos: combos.map((c) => ({
      code: c.code, name: c.name, qty: c.qty, discountPct: c.discountPct, sameZone: c.sameZone,
      limitSets: c.limitSets, active: c.active, usedSets: sets[c.id] ?? 0,
    })),
    seats,
    held: myHeld && {
      orderId: myHeld.id, holdUntil: myHeld.holdUntil!.toISOString(), amount: myHeld.amount,
      comboCode: comboById[myHeld.comboId]?.code ?? 'single',
      seatIds: orderSeats.filter((s) => s.orderId === myHeld.id).map((s) => s.seatId),
    },
    orders: myOrders.filter((o) => o.status !== 'held' && o.submittedAt).reverse().map((o) => ({
      orderNo: o.orderNo, status: o.status, amount: o.amount, payDueAt: o.payDueAt?.toISOString() ?? null,
      seats: orderSeats.filter((s) => s.orderId === o.id).map((s) => ({ label: labelOf[s.seatId] ?? s.seatId, holder: s.holderName })),
    })),
  };
}

export type BookingState = Awaited<ReturnType<typeof getBookingState>>;

/* ---------- 暫存 ---------- */

export async function holdSeats(db: Db, code: string, seatIdsIn: string[], comboCode: string, now = new Date()) {
  const seatIds = [...new Set(seatIdsIn)];
  const pre = await loadLink(db, code, now);
  await sweepExpired(db, pre.ev.id, now);

  return db.transaction(async (tx) => {
    // 鎖住連結，讓同一連結的請求依序處理
    const [link] = await tx.select().from(t.inviteLink).where(eq(t.inviteLink.id, pre.link.id)).for('update');
    const [ev] = await tx.select().from(t.event).where(eq(t.event.id, link.eventId));
    const st = saleState(ev, now);
    if (st !== 'open') throw new BookingError('SALE_CLOSED', SALE_MSG[st]);

    // 同一連結只能有一筆暫存：先放掉舊的
    const old = await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'replaced', holdUntil: null })
      .where(and(eq(t.orders.linkId, link.id), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));

    const canBuy = Math.min(ev.maxPerOrder, link.quota - (await usedQuota(tx, link.id)));
    if (seatIds.length > canBuy) {
      throw new BookingError('QUOTA', canBuy > 0 ? `此連結最多可再訂 ${canBuy} 張。` : '此連結的可訂張數已用完。');
    }

    const [cb] = await tx.select().from(t.combo)
      .where(and(eq(t.combo.eventId, ev.id), eq(t.combo.code, comboCode)));
    if (!cb) throw new BookingError('COMBO', '找不到此票種。');

    const rows = await tx.select({
      seatId: t.eventSeat.seatId, seatType: t.venueSeat.seatType, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo,
      zoneCode: t.priceZone.code, price: t.priceZone.price, sellable: t.seatUsage.sellable,
    }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
      .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds)));

    const valid = rows.filter((r) => r.sellable && (r.seatType !== 'vip' || ev.vipInstalled));
    if (valid.length !== seatIds.length) {
      const ok = new Set(valid.map((r) => r.seatId));
      throw new BookingError('SEAT_UNAVAILABLE', '部分座位不開放訂購。', seatIds.filter((s) => !ok.has(s)));
    }

    const sets = (await usedComboSets(tx, ev.id))[cb.id] ?? 0;
    const problem = comboProblem(cb, valid.map((r) => r.zoneCode), sets);
    if (problem) throw new BookingError('COMBO', problem);

    const amount = calcAmount(valid.map((r) => r.price), cb);
    const holdUntil = new Date(now.getTime() + ev.holdMinutes * 60_000);
    const [order] = await tx.insert(t.orders).values({
      eventId: ev.id, linkId: link.id, comboId: cb.id, status: 'held', amount, holdUntil, createdAt: now,
    }).returning();
    const orderNo = `T${ev.id}-${String(order.id).padStart(5, '0')}`;
    await tx.update(t.orders).set({ orderNo }).where(eq(t.orders.id, order.id));

    // 條件式搶位：只有仍為 free 的座位會被更新
    const got = await tx.update(t.eventSeat)
      .set({ status: 'held', orderId: order.id, holdUntil, version: sql`${t.eventSeat.version} + 1` })
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free')))
      .returning({ seatId: t.eventSeat.seatId });
    if (got.length !== seatIds.length) {
      const g = new Set(got.map((r) => r.seatId));
      const taken = rows.filter((r) => !g.has(r.seatId));
      throw new BookingError('SEAT_TAKEN', `${taken.map(seatLabel).join('、')} 已被他人選走，請重新選擇。`, taken.map((r) => r.seatId));
    }

    await tx.insert(t.orderSeat).values(valid.map((r) => ({ orderId: order.id, seatId: r.seatId, unitPrice: r.price })));
    await tx.insert(t.auditLog).values({ actor: `link:${link.code}`, action: 'hold', target: `order:${order.id}`, detail: seatIds.join(',') });
    return { orderId: order.id, orderNo, amount, holdUntil: holdUntil.toISOString() };
  });
}

/* ---------- 放棄暫存 ---------- */

export async function releaseHold(db: Db, code: string, now = new Date()) {
  const { link } = await loadLink(db, code, now);
  await db.transaction(async (tx) => {
    const old = await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'abandoned', holdUntil: null })
      .where(and(eq(t.orders.linkId, link.id), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));
  });
}

/* ---------- 送出訂購資料 ---------- */

export async function submitOrder(db: Db, code: string, raw: unknown, now = new Date()) {
  const parsed = submitInput.safeParse(raw);
  if (!parsed.success) {
    throw new BookingError('INVALID', parsed.error.issues[0]?.message ?? '資料格式不正確', parsed.error.issues);
  }
  const input: SubmitInput = parsed.data;
  const { link, ev } = await loadLink(db, code, now);

  const result = await db.transaction(async (tx) => {
    const [order] = await tx.select().from(t.orders)
      .where(and(eq(t.orders.id, input.orderId), eq(t.orders.linkId, link.id))).for('update');
    if (!order || order.status !== 'held') {
      throw new BookingError('HOLD_GONE', '找不到暫存中的座位，可能已逾時或已送出，請重新選位。');
    }
    if (order.holdUntil! < now) {
      throw new BookingError('HOLD_EXPIRED', `暫存已超過 ${ev.holdMinutes} 分鐘，座位已釋放，請重新選位。`);
    }

    const seats = await tx.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, order.id));
    const want = new Set(seats.map((s) => s.seatId));
    const given = new Set(input.holders.map((h) => h.seatId));
    if (want.size !== given.size || [...want].some((s) => !given.has(s))) {
      throw new BookingError('INVALID', '每個座位都需要填寫一位持票人。');
    }

    for (const h of input.holders) {
      await tx.update(t.orderSeat).set({ holderName: h.name, holderId4: h.id4 })
        .where(and(eq(t.orderSeat.orderId, order.id), eq(t.orderSeat.seatId, h.seatId)));
    }
    await tx.insert(t.payment).values({
      orderId: order.id, reportedLast5: input.transfer.last5, reportedAmount: input.transfer.amount, reportedAt: input.transfer.time,
    });
    const payDueAt = new Date(now.getTime() + ev.payHours * 3_600_000);
    await tx.update(t.orders).set({
      status: 'pending', buyerName: input.buyer.name, buyerPhone: input.buyer.phone, buyerEmail: input.buyer.email,
      submittedAt: now, payDueAt, holdUntil: null,
    }).where(eq(t.orders.id, order.id));
    await tx.update(t.eventSeat).set({ status: 'pending', holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
      .where(eq(t.eventSeat.orderId, order.id));

    await tx.insert(t.notification).values({
      orderId: order.id, linkId: link.id, channel: 'email', template: 'order_received', recipient: input.buyer.email,
      content: `【${ev.name}】已收到您的訂購資料（訂單 ${order.orderNo}，NT$${order.amount.toLocaleString('en-US')}）。主辦方確認到帳後將通知劃位結果。`,
    });
    await tx.insert(t.auditLog).values({ actor: `link:${link.code}`, action: 'submit', target: `order:${order.id}` });
    return { orderNo: order.orderNo!, amount: order.amount, payDueAt: payDueAt.toISOString(), amountMismatch: input.transfer.amount !== order.amount };
  });
  return result;
}
