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
import { submitInput, type SubmitInput } from './validation';
import { qrSecret, qrValue } from './qr';
import { entitle } from './entitle';

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
  if (link.status !== 'active' || link.kind === 'public') throw new BookingError('LINK_DISABLED', '此購票連結已停用，請聯繫主辦方。');
  if (link.expiresAt < now) throw new BookingError('LINK_EXPIRED', '此購票連結已過期，請聯繫主辦方。');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, link.eventId));
  return { link, ev };
}

/** 推播訂閱用：確認連結有效 */
export async function linkForPush(db: Db, code: string, _visitorIdIn?: string, now = new Date()) {
  const { link } = await loadLink(db, code, now);
  return { link, visitorId: null as string | null };
}

type LinkRow = typeof t.inviteLink.$inferSelect;
type EventRow = typeof t.event.$inferSelect;

/** 這條專屬連結的訂單 */
function ownedBy(link: LinkRow) {
  return eq(t.orders.linkId, link.id);
}

export function saleStateFor(ev: EventRow, _link: LinkRow, now: Date): { state: ReturnType<typeof saleState>; startsAt: string | null } {
  const base = saleState(ev, now);
  return { state: base, startsAt: base === 'not_started' && ev.saleStart ? ev.saleStart.toISOString() : null };
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
  if (link.quota === 0) return ev.maxPerOrder;
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

/** 這條連結付款買了什麼、已劃多少（由訂單收款產生的連結才有；手動連結回傳 null） */
export async function linkEntitle(db: Exec, linkId: number) {
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.linkId, linkId)).limit(1);
  if (!po) return null;
  const os = await db.select({ id: t.orders.id, comboId: t.orders.comboId, sets: t.orders.sets, isSingle: t.combo.isSingle })
    .from(t.orders).innerJoin(t.combo, eq(t.combo.id, t.orders.comboId))
    .where(and(eq(t.orders.linkId, linkId), inArray(t.orders.status, ACTIVE_ORDER)));
  const zs = os.length
    ? await db.select({ orderId: t.orderSeat.orderId, zoneId: t.eventSeat.zoneId }).from(t.orderSeat)
      .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, po.eventId)))
      .where(inArray(t.orderSeat.orderId, os.map((o) => o.id)))
    : [];
  // 分批發出（例：週二功德、週三金區）：只算已發出的項目
  const items = po.released ? po.items.filter((i) => po.released!.includes(`${i.kind}:${i.id}`)) : po.items;
  return entitle(items, os.map((o) => ({ comboId: o.comboId, sets: o.sets, isSingle: o.isSingle, zoneIds: zs.filter((z) => z.orderId === o.id).map((z) => z.zoneId) })));
}

/* ---------- 逾時釋放 ---------- */

export async function freeSeatsOf(db: Exec, orderIds: number[]) {
  if (!orderIds.length) return;
  await db.update(t.eventSeat)
    .set({ status: 'free', orderId: null, holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
    .where(inArray(t.eventSeat.orderId, orderIds));
}


/** 釋放逾時的暫存（選位後未在時間內送出）。由每次請求觸發。已收款，送出後不會被自動取消。 */
export async function sweepExpired(db: Db, eventId: number, now: Date) {
  await db.transaction(async (tx) => {
    const held = await tx.update(t.orders)
      .set({ status: 'expired', closedReason: 'hold_timeout', holdUntil: null })
      .where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'held'), lt(t.orders.holdUntil, now)))
      .returning({ id: t.orders.id });
    await freeSeatsOf(tx, held.map((o) => o.id));
  });
}

/* ---------- 查詢 ---------- */

export type ViewSeatStatus = 'free' | 'mine' | 'held' | 'pending' | 'sold' | 'blocked';

export async function getBookingState(db: Db, code: string, now = new Date(), _visitorIdIn?: string) {
  const { link, ev } = await loadLink(db, code, now);
  await sweepExpired(db, ev.id, now);

  const pub = ev.published ?? { open: false, zoneIds: [], comboIds: [], at: '' };
  const openZones = new Set(pub.zoneIds);
  const openCombos = new Set(pub.comboIds);

  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort), asc(t.priceZone.id));
  const combosAll = await loadCombos(db, ev.id);
  const combos = combosAll.filter((c) => openCombos.has(c.id));
  // 開放的組合票裡的贈票區（票價 0）：就算沒在價格設定勾「開放」，也要能劃
  for (const c of combos) if (!c.isSingle) for (const i of c.items) if (zones.find((z) => z.id === i.zoneId)?.price === 0) openZones.add(i.zoneId);
  const sets = await usedComboSets(db, ev.id);

  const myOrders = await db.select().from(t.orders).where(ownedBy(link)).orderBy(t.orders.id);
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
  const used = await usedQuota(db, link.id);

  const myIds = myOrders.map((o) => o.id);
  const notes = await db.select().from(t.notification).where(eq(t.notification.linkId, link.id)).orderBy(t.notification.id);
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
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.linkId, link.id)).limit(1);
  const poItems = po ? (po.released ? po.items.filter((i) => po.released!.includes(`${i.kind}:${i.id}`)) : po.items) : [];
  const comboItem = poItems.find((i) => i.kind === 'combo' && combos.some((c) => c.id === i.id));
  const ent = await linkEntitle(db, link.id);
  const { invoiceForLink } = await import('./einvoice');
  const inv = await invoiceForLink(db, link.id); // 只有「即開」時顯示
  const prefill = {
    name: link.name, phone: link.phone, email: po?.email ?? '',
    comboId: comboItem?.id ?? 0, bought: poItems.map((i) => `${i.name} × ${i.qty}`).join('、'),
  };
  return {
    now: now.toISOString(),
    sale: sf.state,
    startsAt: sf.startsAt,
    event: {
      name: ev.name, showAt: ev.showAt.toISOString(), vipInstalled: ev.vipInstalled,
      maxPerOrder: ev.maxPerOrder, holdMinutes: ev.holdMinutes,
    },
    link: {
      kind: link.kind, name: link.name, phoneTail: link.phone ? link.phone.slice(-3) : '',
      quota: link.quota, used, expiresAt: link.expiresAt.toISOString(),
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
    paid: ent, // 付款買了什麼、已劃多少（手動連結為 null）
    invoice: inv && { no: inv.invoiceNo, date: inv.invoiceDate.slice(0, 10), random: inv.randomNumber, amount: inv.amount, test: inv.env !== 'prod' },
  };
}

export type BookingState = Awaited<ReturnType<typeof getBookingState>>;

/* ---------- 暫存 ---------- */

export async function holdSeats(db: Db, code: string, seatIdsIn: string[], comboId: number, now = new Date(), _visitorIdIn?: string) {
  const seatIds = [...new Set(seatIdsIn)];
  const pre = await loadLink(db, code, now);
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
      .where(and(ownedBy(link), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));

    const canBuy = canBuyOf(ev, link, await usedQuota(tx, link.id));
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

    // 贈票區（票價 0）只要是這個組合票的內容就可以劃
    const giftOk = (zid: number, price: number) => price === 0 && !cb.isSingle && cb.items.some((i) => i.zoneId === zid);
    const valid = rows.filter((r) => r.sellable && (pub.zoneIds.includes(r.zoneId) || giftOk(r.zoneId, r.price)) && (r.seatType !== 'vip' || ev.vipInstalled));
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

    // 由訂單收款產生的連結：只能劃付了錢的組合與張數（舊的暫存已在上面放掉，不重複計算）
    const ent = await linkEntitle(tx, link.id);
    if (ent) {
      const paidText = ent.rows.map((r) => `${r.name} × ${r.qty}`).join('、');
      if (!cb.isSingle) {
        const e = ent.rows.find((r) => r.kind === 'combo' && r.id === cb.id);
        if (!e) throw new BookingError('PAID', `您付款購買的是「${paidText}」，請用這個購票方式劃位。`);
        if (sets > e.left) throw new BookingError('PAID', e.left > 0 ? `您付款購買的「${e.name}」還可劃 ${e.left} 組，這次選了 ${sets} 組，請減少座位。` : `您付款購買的「${e.name}」已經全部劃完了。`);
      } else {
        const count = new Map<number, number>();
        valid.forEach((r) => count.set(r.zoneId, (count.get(r.zoneId) ?? 0) + 1));
        for (const [z, n] of count) {
          const e = ent.rows.find((r) => r.kind === 'zone' && r.id === z);
          if (!e) throw new BookingError('PAID', `「${zoneName(z)}」不在您付款購買的內容（${paidText}）裡。`);
          if (n > e.left) throw new BookingError('PAID', e.left > 0 ? `您付款購買的「${e.name}」還可劃 ${e.left} 張，這次選了 ${n} 張，請減少座位。` : `您付款購買的「${e.name}」已經全部劃完了。`);
        }
      }
    }
    const amount = calcAmount(valid.map((r) => r.price), cb, sets);
    const holdUntil = new Date(now.getTime() + ev.holdMinutes * 60_000);
    const [order] = await tx.insert(t.orders).values({
      eventId: ev.id, linkId: link.id, comboId: cb.id, sets, status: 'held', amount, holdUntil, createdAt: now,
      buyerName: link.name, buyerPhone: link.phone || null,
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

export async function releaseHold(db: Db, code: string, now = new Date(), _visitorIdIn?: string) {
  const { link } = await loadLink(db, code, now);
  await db.transaction(async (tx) => {
    const old = await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'abandoned', holdUntil: null })
      .where(and(ownedBy(link), eq(t.orders.status, 'held'))).returning({ id: t.orders.id });
    await freeSeatsOf(tx, old.map((o) => o.id));
  });
}

/* ---------- 送出訂購資料 ---------- */

export async function submitOrder(db: Db, code: string, raw: unknown, now = new Date(), _visitorIdIn?: string) {
  const parsed = submitInput.safeParse(raw);
  if (!parsed.success) {
    throw new BookingError('INVALID', parsed.error.issues[0]?.message ?? '資料格式不正確', parsed.error.issues);
  }
  const input: SubmitInput = parsed.data;
  const { link, ev } = await loadLink(db, code, now);

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(t.orders)
      .where(and(eq(t.orders.id, input.orderId), ownedBy(link))).for('update');
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

    // 持票人：畫面上先依購票人姓名與證末 4 碼自動帶入（姓名02、03…／證號末 4 碼＋序號），購票人可逐張修改。
    // 證號可為某人的末 4 碼，或自動編號的「末 4 碼＋2–3 位序號」
    const holders = input.holders;
    if (holders.some((h) => !/^[0-9A-Z]{4}(\d{2,3})?$/.test(h.id4))) throw new BookingError('INVALID', '持票人證號應為身分證末 4 碼（或自動編號的末 4 碼＋序號）');
    for (const h of holders) {
      await tx.update(t.orderSeat).set({ holderName: h.name, holderId4: h.id4 })
        .where(and(eq(t.orderSeat.orderId, order.id), eq(t.orderSeat.seatId, h.seatId)));
    }
    // 已在預購單收款，這裡只記錄
    await tx.insert(t.payment).values({ orderId: order.id, reportedLast5: '', reportedAmount: order.amount, reportedAt: '已先匯款' });
    await tx.update(t.orders).set({
      status: 'pending', buyerName: input.buyer.name, buyerPhone: input.buyer.phone, buyerEmail: input.buyer.email,
      submittedAt: now, payDueAt: null, holdUntil: null, seenAt: null,
    }).where(eq(t.orders.id, order.id));
    await tx.update(t.eventSeat).set({ status: 'pending', holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
      .where(eq(t.eventSeat.orderId, order.id));

    await tx.insert(t.notification).values({
      orderId: order.id, linkId: link.id, channel: 'email', template: 'order_received', recipient: input.buyer.email,
      content: `【${ev.name}】已收到您的劃位資料（劃位編號 ${order.orderNo}）。主辦方確認後，會寄出劃位成功通知與入場 QR code。`,
    });
    await tx.insert(t.auditLog).values({ actor: `link:${link.code}`, action: 'submit', target: `order:${order.id}` });
    return { orderNo: order.orderNo!, amount: order.amount };
  });
}
