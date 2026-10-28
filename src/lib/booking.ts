/**
 * 訂位核心邏輯（購票端）：查詢座位、暫存、放棄、送出、逾時釋放。
 * 所有時間相關函式都接受 now 參數，方便測試。
 *
 * 防止一位兩賣的關鍵：暫存時以「只在 status = 'free' 時才更新」的條件式 UPDATE 搶座位，
 * 實際更新筆數少於要求數量就整筆交易回滾。PostgreSQL 的列鎖保證同一座位只有一筆交易成功。
 *
 * 購票端只看「已發布」的開放設定（event.published）：未發布的票種座位顯示為不可選，
 * 未發布的購票方式不顯示。
 */
import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { seatLabel } from './layout';
import { calcAmount, comboProblem, comboSets, type ComboRule } from './pricing';
import { autoHolders, submitInput, type SubmitInput } from './validation';
import { qrSecret, qrValue } from './qr';

export class BookingError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

export const ACTIVE_ORDER = ['held', 'pending', 'paid'];
const COUNTED_ORDER = ['pending', 'paid']; // 計入連結已訂張數

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Exec = Db | Tx;

/* ---------- 連結與場次 ---------- */

async function loadLink(db: Exec, code: string, now: Date) {
  const [link] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, code));
  if (!link) throw new BookingError('LINK_NOT_FOUND', '找不到此購票連結，請確認網址是否完整。');
  if (link.status !== 'active') throw new BookingError('LINK_DISABLED', '此購票連結已停用，請聯繫主辦方。');
  if (link.expiresAt < now) throw new BookingError('LINK_EXPIRED', '此購票連結已過期，請聯繫主辦方。');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, link.eventId));
  return { link, ev };
}

/** 推播訂閱用：確認連結有效並取得訪客代碼 */
export async function linkForPush(db: Db, code: string, visitorIdIn?: string, now = new Date()) {
  const { link } = await loadLink(db, code, now);
  return { link, visitorId: checkVisitor(link, visitorIdIn) };
}

type LinkRow = typeof t.inviteLink.$inferSelect;
type EventRow = typeof t.event.$inferSelect;

/** 公開連結由多位訪客共用，以瀏覽器產生的訪客代碼區分各自的暫存與訂單 */
function checkVisitor(link: LinkRow, visitorId?: string) {
  if (link.kind !== 'public') return null;
  if (!visitorId || !/^[A-Za-z0-9_-]{16,64}$/.test(visitorId)) {
    throw new BookingError('INVALID', '請重新整理頁面後再試。');
  }
  return visitorId;
}

/** 這位訪客擁有的訂單：專屬連結看整條連結；公開連結只看自己的訪客代碼 */
function ownedBy(link: LinkRow, visitorId: string | null) {
  return link.kind === 'public'
    ? and(eq(t.orders.linkId, link.id), eq(t.orders.visitorId, visitorId ?? '-'))
    : eq(t.orders.linkId, link.id);
}

/** 依連結種類判斷開放狀態：公開連結另有開始時間（先專屬、再公開） */
export function saleStateFor(ev: EventRow, link: LinkRow, now: Date): { state: ReturnType<typeof saleState>; startsAt: string | null } {
  const base = saleState(ev, now);
  if (base !== 'open') return { state: base, startsAt: base === 'not_started' && ev.saleStart ? ev.saleStart.toISOString() : null };
  if (link.kind === 'public' && ev.publicSaleStart && now < ev.publicSaleStart) {
    return { state: 'not_started', startsAt: ev.publicSaleStart.toISOString() };
  }
  return { state: 'open', startsAt: null };
}

/** 購票端看到的開放狀態，依已發布的設定與開賣時間判斷 */
export function saleState(ev: typeof t.event.$inferSelect, now: Date): 'open' | 'closed' | 'not_started' | 'ended' {
  if (!ev.published?.open) return 'closed';
  if (ev.saleStart && now < ev.saleStart) return 'not_started';
  if (ev.saleEnd && now > ev.saleEnd) return 'ended';
  return 'open';
}

const SALE_MSG = { closed: '目前未開放訂購。', not_started: '尚未開始訂購。', ended: '訂購已截止。' } as const;

/** 這次最多可勾幾張：每筆訂單上限，再加上專屬連結的剩餘張數（0 = 不限） */
function canBuyOf(ev: EventRow, link: LinkRow, used: number) {
  if (link.kind === 'public' || link.quota === 0) return ev.maxPerOrder;
  return Math.max(0, Math.min(ev.maxPerOrder, link.quota - used));
}

async function usedQuota(db: Exec, linkId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` })
    .from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId))
    .where(and(eq(t.orders.linkId, linkId), inArray(t.orders.status, COUNTED_ORDER)));
  return r?.n ?? 0;
}

export async function usedComboSets(db: Exec, eventId: number): Promise<Record<number, number>> {
  const rows = await db.select({ comboId: t.orders.comboId, n: sql<number>`coalesce(sum(${t.orders.sets}), 0)::int` })
    .from(t.orders)
    .where(and(eq(t.orders.eventId, eventId), inArray(t.orders.status, ACTIVE_ORDER)))
    .groupBy(t.orders.comboId);
  return Object.fromEntries(rows.map((r) => [r.comboId, r.n]));
}

/** 場次的購票方式（含組合內容） */
export async function loadCombos(db: Exec, eventId: number): Promise<(ComboRule & { active: boolean; sort: number; autoHolders: boolean })[]> {
  const combos = await db.select().from(t.combo).where(eq(t.combo.eventId, eventId)).orderBy(asc(t.combo.sort), asc(t.combo.id));
  const items = combos.length
    ? await db.select().from(t.comboItem).where(inArray(t.comboItem.comboId, combos.map((c) => c.id)))
    : [];
  return combos.map((c) => ({
    id: c.id, name: c.name, isSingle: c.isSingle, price: c.price, limitSets: c.limitSets, active: c.active, sort: c.sort, autoHolders: c.autoHolders,
    items: items.filter((i) => i.comboId === c.id).map((i) => ({ zoneId: i.zoneId, qty: i.qty })),
  }));
}

/* ---------- 逾時釋放 ---------- */

export async function freeSeatsOf(db: Exec, orderIds: number[]) {
  if (!orderIds.length) return;
  await db.update(t.eventSeat)
    .set({ status: 'free', orderId: null, holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
    .where(inArray(t.eventSeat.orderId, orderIds));
}

export function expiredMessage(eventName: string, orderNo: string | null) {
  return `【${eventName}】訂單 ${orderNo} 逾期未確認到帳，已取消並釋放座位。如已匯款請聯繫主辦方。`;
}

/** 釋放逾時的暫存與逾期未確認到帳的訂單。由每次請求觸發。 */
export async function sweepExpired(db: Db, eventId: number, now: Date) {
  await db.transaction(async (tx) => {
    const held = await tx.update(t.orders)
      .set({ status: 'expired', closedReason: 'hold_timeout', holdUntil: null })
      .where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'held'), lt(t.orders.holdUntil, now)))
      .returning({ id: t.orders.id });
    // 先匯款再給連結：已經收過款，送出後不會因「逾時未確認到帳」被取消
    const [evp] = await tx.select({ payFirst: t.event.payFirst }).from(t.event).where(eq(t.event.id, eventId));
    const pend = evp?.payFirst ? [] : await tx.update(t.orders)
      .set({ status: 'expired', closedReason: 'pay_timeout' })
      .where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'pending'), lt(t.orders.payDueAt, now)))
      .returning({ id: t.orders.id, orderNo: t.orders.orderNo, linkId: t.orders.linkId, phone: t.orders.buyerPhone, email: t.orders.buyerEmail });
    await freeSeatsOf(tx, [...held, ...pend].map((o) => o.id));
    if (pend.length) {
      const [ev] = await tx.select({ name: t.event.name }).from(t.event).where(eq(t.event.id, eventId));
      for (const o of pend) {
        const content = expiredMessage(ev.name, o.orderNo);
        await tx.insert(t.notification).values([
          { orderId: o.id, linkId: o.linkId, channel: 'sms', template: 'order_expired', recipient: o.phone ?? '', content },
          { orderId: o.id, linkId: o.linkId, channel: 'email', template: 'order_expired', recipient: o.email ?? '', content },
          { orderId: o.id, linkId: o.linkId, channel: 'push', template: 'order_expired', recipient: '訂購人手機', content },
        ]);
        await tx.insert(t.auditLog).values({ actor: 'system', action: 'order_expired', target: `order:${o.id}` });
      }
    }
  });
}

/* ---------- 查詢 ---------- */

export type ViewSeatStatus = 'free' | 'mine' | 'held' | 'pending' | 'sold' | 'blocked';

export async function getBookingState(db: Db, code: string, now = new Date(), visitorIdIn?: string) {
  const { link, ev } = await loadLink(db, code, now);
  const visitorId = checkVisitor(link, visitorIdIn);
  await sweepExpired(db, ev.id, now);

  const pub = ev.published ?? { open: false, zoneIds: [], comboIds: [], at: '' };
  const openZones = new Set(pub.zoneIds);
  const openCombos = new Set(pub.comboIds);

  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort), asc(t.priceZone.id));
  const combosAll = await loadCombos(db, ev.id);
  const combos = combosAll.filter((c) => openCombos.has(c.id));
  const sets = await usedComboSets(db, ev.id);

  const myOrders = await db.select().from(t.orders).where(ownedBy(link, visitorId)).orderBy(t.orders.id);
  const myHeld = myOrders.find((o) => o.status === 'held') ?? null;

  const seatRows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, code: t.venueSeat.code,
    seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, bundle: t.eventSeat.bundle,
    sellable: t.seatUsage.sellable,
  }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(eq(t.eventSeat.eventId, ev.id));

  const seats = seatRows
    .filter((s) => s.seatType !== 'vip' || ev.vipInstalled)
    .map((s) => {
      let status: ViewSeatStatus;
      if (myHeld && s.orderId === myHeld.id) status = 'mine';
      else if (s.status !== 'free') status = s.status as ViewSeatStatus;
      else if (!s.sellable || !openZones.has(s.zoneId)) status = 'blocked';
      else status = 'free';
      return { id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), zoneId: s.zoneId, status, bundle: s.bundle };
    });

  const orderSeats = myOrders.length
    ? await db.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId, holderName: t.orderSeat.holderName, holderId4: t.orderSeat.holderId4 })
      .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId))
      .where(inArray(t.orderSeat.orderId, myOrders.map((o) => o.id)))
      .orderBy(asc(t.venueSeat.y), asc(t.venueSeat.x))
    : [];
  const seatById = Object.fromEntries(seatRows.map((s) => [s.id, s]));
  const used = link.kind === 'public' ? 0 : await usedQuota(db, link.id);

  const myIds = myOrders.map((o) => o.id);
  const notes = link.kind === 'public'
    ? (myIds.length ? await db.select().from(t.notification).where(inArray(t.notification.orderId, myIds)).orderBy(t.notification.id) : [])
    : await db.select().from(t.notification).where(or(eq(t.notification.linkId, link.id))).orderBy(t.notification.id);
  // 同一則訊息可能同時以簡訊與 Email 發送，購票頁只顯示一次
  const seen = new Set<string>();
  const inbox = notes.filter((n) => {
    const k = `${n.orderId}|${n.template}|${n.content}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).reverse().map((n) => ({ id: n.id, at: n.createdAt.toISOString(), template: n.template, content: n.content }));

  const sf = saleStateFor(ev, link, now);
  const secret = await qrSecret(db);
  // 由訂單（收款）產生的連結：帶入訂購時填的資料與購買的購票方式
  const [po] = link.kind === 'public' ? [] : await db.select().from(t.preorder).where(eq(t.preorder.linkId, link.id)).limit(1);
  const comboItem = po?.items.find((i) => i.kind === 'combo' && combos.some((c) => c.id === i.id));
  const prefill = {
    name: link.kind === 'public' ? '' : link.name, phone: link.kind === 'public' ? '' : link.phone, email: po?.email ?? '',
    comboId: comboItem?.id ?? 0, bought: po ? po.items.map((i) => `${i.name} × ${i.qty}`).join('、') : '',
  };
  return {
    now: now.toISOString(),
    sale: sf.state,
    startsAt: sf.startsAt,
    event: {
      name: ev.name, showAt: ev.showAt.toISOString(), vipInstalled: ev.vipInstalled,
      maxPerOrder: ev.maxPerOrder, holdMinutes: ev.holdMinutes, payHours: ev.payHours, payFirst: ev.payFirst,
      bankName: ev.payFirst ? '' : ev.bankName, bankAccount: ev.payFirst ? '' : ev.bankAccount, accountName: ev.payFirst ? '' : ev.accountName,
    },
    link: {
      kind: link.kind, name: link.kind === 'public' ? '' : link.name, phoneTail: link.phone ? link.phone.slice(-3) : '',
      quota: link.kind === 'public' ? 0 : link.quota, used, expiresAt: link.expiresAt.toISOString(), perPhone: ev.publicPerPhone,
    },
    canBuy: canBuyOf(ev, link, used),
    zones: zones.filter((z) => openZones.has(z.id)).map((z) => ({ id: z.id, name: z.name, color: z.color, price: z.price })),
    combos: combos.map((c) => ({ id: c.id, name: c.name, isSingle: c.isSingle, price: c.price, limitSets: c.limitSets, items: c.items, usedSets: sets[c.id] ?? 0, autoHolders: c.autoHolders })),
    seats,
    held: myHeld && {
      orderId: myHeld.id, orderNo: myHeld.orderNo, holdUntil: myHeld.holdUntil!.toISOString(), amount: myHeld.amount,
      comboId: myHeld.comboId,
      seatIds: orderSeats.filter((s) => s.orderId === myHeld.id).map((s) => s.seatId),
    },
    orders: myOrders.filter((o) => o.status !== 'held' && o.submittedAt).reverse().map((o) => ({
      orderNo: o.orderNo, status: o.status, amount: o.amount, payDueAt: o.payDueAt?.toISOString() ?? null,
      comboName: combosAll.find((c) => c.id === o.comboId)?.name ?? '', sets: o.sets,
      buyerName: o.buyerName, buyerPhone: o.buyerPhone, buyerEmail: o.buyerEmail,
      // 劃位成功後才提供入場憑證（序號與入場券列印頁一致）
      seats: orderSeats.filter((s) => s.orderId === o.id).map((s, i) => {
        const v = seatById[s.seatId];
        return {
          label: v ? seatLabel(v) : s.seatId, code: v?.code ?? '', holder: s.holderName, holderId4: s.holderId4,
          zoneName: zones.find((z) => z.id === v?.zoneId)?.name ?? '',
          serial: o.status === 'paid' ? `${o.orderNo}-${String(i + 1).padStart(2, '0')}` : null,
          qr: o.status === 'paid' ? qrValue(secret, `${o.orderNo}-${String(i + 1).padStart(2, '0')}`) : null,
        };
      }),
    })),
    inbox,
    prefill,
  };
}

export type BookingState = Awaited<ReturnType<typeof getBookingState>>;

/* ---------- 暫存 ---------- */

export async function holdSeats(db: Db, code: string, seatIdsIn: string[], comboId: number, now = new Date(), visitorIdIn?: string) {
  const seatIds = [...new Set(seatIdsIn)];
  const pre = await loadLink(db, code, now);
  const visitorId = checkVisitor(pre.link, visitorIdIn);
  await sweepExpired(db, pre.ev.id, now);

  return db.transaction(async (tx) => {
    // 鎖住連結，讓同一連結的請求依序處理
    const [link] = await tx.select().from(t.inviteLink).where(eq(t.inviteLink.id, pre.link.id)).for('update');
    const [ev] = await tx.select().from(t.event).where(eq(t.event.id, link.eventId));
    const st = saleStateFor(ev, link, now).state;
    if (st !== 'open') throw new BookingError('SALE_CLOSED', SALE_MSG[st]);
    const pub = ev.published!;

    // 同一位購票者只能有一筆暫存：先放掉舊的
    const old = await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'replaced', holdUntil: null })
      .where(and(ownedBy(link, visitorId), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));

    const canBuy = canBuyOf(ev, link, link.kind === 'public' ? 0 : await usedQuota(tx, link.id));
    if (seatIds.length > canBuy) {
      throw new BookingError('QUOTA', canBuy > 0 ? `此連結最多可再訂 ${canBuy} 張。` : '此連結的可訂張數已用完。');
    }

    const cb = (await loadCombos(tx, ev.id)).find((c) => c.id === comboId);
    if (!cb || !pub.comboIds.includes(cb.id)) throw new BookingError('COMBO', '此購票方式目前未開放。');

    const rows = await tx.select({
      seatId: t.eventSeat.seatId, seatType: t.venueSeat.seatType, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo,
      zoneId: t.eventSeat.zoneId, zoneName: t.priceZone.name, price: t.priceZone.price, sellable: t.seatUsage.sellable,
    }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
      .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds)));

    // 連座：選了其中一位，整組都要一起選
    const bundles = [...new Set((await tx.select({ b: t.eventSeat.bundle }).from(t.eventSeat)
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds)))).map((r) => r.b).filter((b): b is string => !!b))];
    if (bundles.length) {
      const members = await tx.select({ seatId: t.eventSeat.seatId }).from(t.eventSeat)
        .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.bundle, bundles)));
      const want = new Set(seatIds);
      const missing = members.map((m) => m.seatId).filter((id) => !want.has(id));
      if (missing.length) throw new BookingError('BUNDLE', '連座的座位需整組一起訂購（按一下會同時選取整組）。', missing);
    }

    const valid = rows.filter((r) => r.sellable && pub.zoneIds.includes(r.zoneId) && (r.seatType !== 'vip' || ev.vipInstalled));
    if (valid.length !== seatIds.length) {
      const ok = new Set(valid.map((r) => r.seatId));
      throw new BookingError('SEAT_UNAVAILABLE', '部分座位目前不開放訂購。', seatIds.filter((s) => !ok.has(s)));
    }

    const zones = await tx.select({ id: t.priceZone.id, name: t.priceZone.name }).from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
    const zoneName = (id: number) => zones.find((z) => z.id === id)?.name ?? '';
    const usedSets = (await usedComboSets(tx, ev.id))[cb.id] ?? 0;
    const giftZones = new Set(valid.filter((r) => r.price === 0).map((r) => r.zoneId));
    const problem = comboProblem(cb, valid.map((r) => r.zoneId), usedSets, zoneName, giftZones);
    if (problem) throw new BookingError('COMBO', problem);

    const sets = cb.isSingle ? 1 : comboSets(cb, valid.map((r) => r.zoneId));
    const amount = calcAmount(valid.map((r) => r.price), cb, sets);
    const holdUntil = new Date(now.getTime() + ev.holdMinutes * 60_000);
    const [order] = await tx.insert(t.orders).values({
      eventId: ev.id, linkId: link.id, comboId: cb.id, sets, status: 'held', amount, holdUntil, createdAt: now, visitorId,
      buyerName: link.kind === 'public' ? '（公開連結・填寫中）' : link.name, buyerPhone: link.kind === 'public' ? null : link.phone,
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

    // 單張購票以票價記單價；組合票將套票價平均分攤（餘數加在第一張）
    const unit = cb.isSingle ? null : Math.floor(amount / valid.length);
    await tx.insert(t.orderSeat).values(valid.map((r, i) => ({
      orderId: order.id, seatId: r.seatId,
      unitPrice: unit === null ? r.price : unit + (i === 0 ? amount - unit * valid.length : 0),
    })));
    await tx.insert(t.auditLog).values({ actor: `link:${link.code}`, action: 'hold', target: `order:${order.id}`, detail: seatIds.join(',') });
    return { orderId: order.id, orderNo, amount, holdUntil: holdUntil.toISOString() };
  });
}

/* ---------- 放棄暫存 ---------- */

export async function releaseHold(db: Db, code: string, now = new Date(), visitorIdIn?: string) {
  const { link } = await loadLink(db, code, now);
  const visitorId = checkVisitor(link, visitorIdIn);
  await db.transaction(async (tx) => {
    const old = await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'abandoned', holdUntil: null })
      .where(and(ownedBy(link, visitorId), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));
  });
}

/* ---------- 送出訂購資料 ---------- */

export async function submitOrder(db: Db, code: string, raw: unknown, now = new Date(), visitorIdIn?: string) {
  const parsed = submitInput.safeParse(raw);
  if (!parsed.success) {
    throw new BookingError('INVALID', parsed.error.issues[0]?.message ?? '資料格式不正確', parsed.error.issues);
  }
  const input: SubmitInput = parsed.data;
  const { link, ev } = await loadLink(db, code, now);
  const visitorId = checkVisitor(link, visitorIdIn);

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(t.orders)
      .where(and(eq(t.orders.id, input.orderId), ownedBy(link, visitorId))).for('update');
    if (!order || order.status !== 'held') {
      throw new BookingError('HOLD_GONE', '找不到暫存中的座位，可能已逾時、已送出或已被主辦方取消，請重新選位。');
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

    // 公開連結：同一支手機的累計張數上限（0 = 不限）
    if (link.kind === 'public' && ev.publicPerPhone > 0) {
      const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(t.orderSeat)
        .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId))
        .where(and(eq(t.orders.eventId, ev.id), eq(t.orders.buyerPhone, input.buyer.phone), inArray(t.orders.status, COUNTED_ORDER)));
      if ((r?.n ?? 0) + seats.length > ev.publicPerPhone) {
        throw new BookingError('QUOTA', `每支手機最多可訂 ${ev.publicPerPhone} 張，這支手機已訂 ${r?.n ?? 0} 張。`);
      }
    }

    // 持票人自動編號（例如功德組）：由伺服器依購票人姓名與證末 4 碼產生，不採用前端送來的持票人
    const [cb] = await tx.select().from(t.combo).where(eq(t.combo.id, order.comboId));
    let holders = input.holders;
    if (cb?.autoHolders) {
      if (!input.idBase) throw new BookingError('INVALID', '請填寫購票人身分證末 4 碼。');
      const gen = autoHolders(input.buyer.name, input.idBase, input.holders.length);
      holders = input.holders.map((h, i) => ({ seatId: h.seatId, ...gen[i] }));
    } else if (input.holders.some((h) => h.id4.length !== 4)) {
      throw new BookingError('INVALID', '身分證末 4 碼應為 4 個英數字');
    }

    for (const h of holders) {
      await tx.update(t.orderSeat).set({ holderName: h.name, holderId4: h.id4 })
        .where(and(eq(t.orderSeat.orderId, order.id), eq(t.orderSeat.seatId, h.seatId)));
    }
    if (!ev.payFirst && !input.transfer) throw new BookingError('INVALID', '請填寫匯款資訊');
    await tx.insert(t.payment).values(input.transfer && !ev.payFirst
      ? { orderId: order.id, reportedLast5: input.transfer.last5, reportedAmount: input.transfer.amount, reportedAt: input.transfer.time }
      : { orderId: order.id, reportedLast5: '', reportedAmount: order.amount, reportedAt: '已先匯款' });
    const payDueAt = new Date(now.getTime() + (ev.payFirst ? 365 * 24 : ev.payHours) * 3_600_000);
    await tx.update(t.orders).set({
      status: 'pending', buyerName: input.buyer.name, buyerPhone: input.buyer.phone, buyerEmail: input.buyer.email,
      submittedAt: now, payDueAt, holdUntil: null, seenAt: null,
    }).where(eq(t.orders.id, order.id));
    await tx.update(t.eventSeat).set({ status: 'pending', holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
      .where(eq(t.eventSeat.orderId, order.id));

    await tx.insert(t.notification).values({
      orderId: order.id, linkId: link.id, channel: 'email', template: 'order_received', recipient: input.buyer.email,
      content: ev.payFirst
        ? `【${ev.name}】已收到您的劃位資料（訂單 ${order.orderNo}）。主辦方確認後，會寄出劃位成功通知與入場 QR code。`
        : `【${ev.name}】已收到您的訂購資料（訂單 ${order.orderNo}，NT$${order.amount.toLocaleString('en-US')}）。主辦方確認到帳後將通知劃位結果。`,
    });
    await tx.insert(t.auditLog).values({ actor: `link:${link.code}`, action: 'submit', target: `order:${order.id}` });
    return { orderNo: order.orderNo!, amount: order.amount, payDueAt: payDueAt.toISOString(), amountMismatch: !!input.transfer && !ev.payFirst && input.transfer.amount !== order.amount };
  });
}
