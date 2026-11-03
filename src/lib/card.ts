/**
 * 三樓信用卡購票（綠界全方位金流 AIO）。流程：先刷卡、再劃位。
 *
 *   /3f 選方案與份數、填資料 → createCardOrder 建立 pending 訂單並先佔名額 → 導到綠界
 *   → 付款成功 → markPaid：建立 preorder（source=card）與綁三樓的劃位連結、寄信、開發票 → 跳進劃位頁
 *
 * 防漏單三道保險（任何一道先到都一樣，markPaid 是冪等的）：
 *   1. 綠界主動通知 ReturnURL（/api/card/return）
 *   2. 買方回到 OrderResultURL（/api/card/result）
 *   3. 定時向綠界 QueryTradeInfo 查「付款中」的訂單（pollPending）
 *
 * 綠界規格見 developers.ecpay.com.tw：2864 產生訂單、2878 付款結果通知、2890 查詢訂單、2885 請退款、2894 信用卡明細、2902 檢查碼。
 * 綠界測試環境不提供請退款與信用卡明細查詢，所以測試模式的退票只模擬，正式刷退要用真卡驗證。
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ACTIVE_ORDER, BookingError, freeSeatsOf } from './booking';
import { createForPreorder, issueInvoice, voidInvoice } from './einvoice';
import { floor3Plans } from './floor';
import { INV_TYPES, invDesc, invProblem } from './invoiceRules';
import { rowKey, seatLabel } from './layout';
import { siteOrigin } from './push';
import { normalizePhone } from './validation';

/* ---------- 檢查碼 ---------- */

/** 等同 PHP urlencode 後再還原 .NET 的 -_.!*()：encodeURIComponent 本來就不編這幾個，只要補空白、~、' */
const macEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+').replace(/~/g, '%7e').replace(/'/g, '%27').toLowerCase();

export function checkMac(params: Record<string, string | number>, hashKey: string, hashIV: string) {
  const body = Object.keys(params).filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; })
    .map((k) => `${k}=${params[k]}`).join('&');
  return createHash('sha256').update(macEncode(`HashKey=${hashKey}&${body}&HashIV=${hashIV}`)).digest('hex').toUpperCase();
}

export function macOk(params: Record<string, string>, hashKey: string, hashIV: string) {
  const a = Buffer.from(String(params.CheckMacValue ?? ''));
  const b = Buffer.from(checkMac(params, hashKey, hashIV));
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- 設定 ---------- */

export const ECPAY_PAY_TEST = { merchantId: '3002607', hashKey: 'pwFHCqoQZGmho4w6', hashIV: 'EkRm7iFT261dpevs' };
const BASE = { test: 'https://payment-stage.ecpay.com.tw', prod: 'https://payment.ecpay.com.tw' };
export type CardMode = 'test' | 'prod';
export const CARD_MODE_NAME: Record<CardMode, string> = { test: '綠界測試環境', prod: '正式' };
/** 付款中先佔名額多久（綠界頁面沒付完，時間到名額放回） */
export const RESERVE_MIN = 30;

export interface CardSettings {
  open: boolean; saleStart: string | null; saleEnd: string | null;
  credit: boolean; // 付款方式：信用卡
  refundOn: boolean; refundDays: number; refundFeePct: number;
}
const DEFAULTS: CardSettings = { open: false, saleStart: null, saleEnd: null, credit: true, refundOn: true, refundDays: 7, refundFeePct: 10 };

const KEYS = ['card.mode', 'card.merchantId', 'card.hashKey', 'card.hashIV', 'card.checkCode', 'card.settings'] as const;
async function readKeys(db: Db) {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [...KEYS]));
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Record<(typeof KEYS)[number], string>>;
}
const put = (db: Db, key: string, value: string) => db.insert(t.appSetting).values({ key, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });

export async function getCardConfig(db: Db) {
  const s = await readKeys(db);
  const mode: CardMode = s['card.mode'] === 'prod' ? 'prod' : 'test';
  const cred = mode === 'prod'
    ? { merchantId: s['card.merchantId'] ?? '', hashKey: s['card.hashKey'] ?? '', hashIV: s['card.hashIV'] ?? '' } : ECPAY_PAY_TEST;
  let settings = DEFAULTS;
  try { settings = { ...DEFAULTS, ...JSON.parse(s['card.settings'] ?? '{}') }; } catch { /* 用預設 */ }
  return { mode, ...cred, checkCode: s['card.checkCode'] ?? '', settings };
}
export type CardConfig = Awaited<ReturnType<typeof getCardConfig>>;

/** 給後台畫面：不含 HashKey／HashIV */
export async function publicCardConfig(db: Db) {
  const s = await readKeys(db);
  const c = await getCardConfig(db);
  return { mode: c.mode, settings: c.settings, merchantId: s['card.merchantId'] ?? '', keySet: !!s['card.hashKey'], ivSet: !!s['card.hashIV'], checkCodeSet: !!s['card.checkCode'] };
}

export async function saveCardKeys(db: Db, actor: string, v: Partial<{ mode: CardMode; merchantId: string; hashKey: string; hashIV: string; checkCode: string }>) {
  const s = await readKeys(db);
  if (v.mode === 'prod') {
    const ok = (v.merchantId ?? s['card.merchantId']) && (v.hashKey || s['card.hashKey']) && (v.hashIV || s['card.hashIV']);
    if (!ok) throw new BookingError('INVALID', '正式模式請先填好金流的特店編號、HashKey、HashIV（金流那一組，不是發票那組）');
  }
  if (v.mode) await put(db, 'card.mode', v.mode);
  if (v.merchantId !== undefined) await put(db, 'card.merchantId', v.merchantId.trim());
  if (v.hashKey) await put(db, 'card.hashKey', v.hashKey.trim()); // 留空＝不變更
  if (v.hashIV) await put(db, 'card.hashIV', v.hashIV.trim());
  if (v.checkCode) await put(db, 'card.checkCode', v.checkCode.trim());
  const changed = [v.mode ? `模式：${CARD_MODE_NAME[v.mode]}` : '', v.merchantId !== undefined && v.merchantId !== (s['card.merchantId'] ?? '') ? '特店編號' : '', v.hashKey ? 'HashKey' : '', v.hashIV ? 'HashIV' : '', v.checkCode ? '商家檢查碼' : ''].filter(Boolean);
  if (changed.length) await db.insert(t.auditLog).values({ actor, action: 'card_keys', target: 'app_setting', detail: changed.join('、') });
}

export async function saveCardSettings(db: Db, actor: string, v: Partial<CardSettings>) {
  const cur = (await getCardConfig(db)).settings;
  const next = { ...cur, ...v };
  if (next.refundFeePct < 0 || next.refundFeePct > 10) throw new BookingError('INVALID', '退票手續費不得超過票面 10%（文化部藝文票券定型化契約上限）');
  await put(db, 'card.settings', JSON.stringify(next));
  await db.insert(t.auditLog).values({ actor, action: 'card_settings', target: 'app_setting', detail: JSON.stringify(v) });
  menuCache = null;
  return next;
}

export type SaleState = 'open' | 'closed' | 'not_started' | 'ended';
export function saleStateOf(s: CardSettings, now: Date): SaleState {
  if (!s.open || !s.credit) return 'closed';
  if (s.saleStart && now < new Date(s.saleStart)) return 'not_started';
  if (s.saleEnd && now > new Date(s.saleEnd)) return 'ended';
  return 'open';
}

/* ---------- 退票規則 ---------- */

const tpeDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // 2026-12-02

/** 最後可退票日（台北日期，含當天） */
export function refundLastDay(showAt: Date, days: number) {
  return tpeDate(new Date(showAt.getTime() - days * 86400_000));
}
export const refundFeeOf = (amount: number, pct: number) => Math.round(amount * pct / 100);
export function refundOpen(s: CardSettings, showAt: Date, now: Date) {
  return s.refundOn && tpeDate(now) <= refundLastDay(showAt, s.refundDays);
}
export function refundText(s: CardSettings, showAt: Date) {
  if (!s.refundOn) return '本活動票券售出後恕不退票；如因主辦方因素取消或延期，將全額退費。';
  const [, m, d] = refundLastDay(showAt, s.refundDays).split('-').map(Number);
  return `演出前 ${s.refundDays} 日（${m}/${d}）以前可申請退票，酌收票面金額 ${s.refundFeePct}% 手續費；逾期恕不受理。如因主辦方因素取消或延期，全額退費、不收手續費。`;
}

/* ---------- 庫存 ---------- */

/**
 * 三樓還能賣多少：空位 − 已付款還沒劃的 − 付款中先佔的。
 * 買方是先付錢再選位，所以賣出去但還沒選的也要先扣掉，才不會付了錢沒位子。
 */
export async function floor3Stock(db: Db | Parameters<Parameters<Db['transaction']>[0]>[0], eventId: number, now: Date) {
  const { combos, zones, comboZone } = await floor3Plans(db as Db, eventId);
  const rows = await db.select({ id: t.eventSeat.seatId, zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, bundle: t.eventSeat.bundle, sellable: t.seatUsage.sellable })
    .from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.venueSeat.floor, '3F')));
  const openSeat = (r: (typeof rows)[number]) => r.status === 'free' && r.sellable;

  // 已付款、還沒劃完的
  const owed = new Map<string, number>();
  const add = (k: string, n: number) => { if (n > 0) owed.set(k, (owed.get(k) ?? 0) + n); };
  const pos = await db.select({ linkId: t.preorder.linkId, items: t.preorder.items }).from(t.preorder)
    .where(and(eq(t.preorder.eventId, eventId), eq(t.preorder.source, 'card'), eq(t.preorder.status, 'confirmed')));
  const linkIds = pos.map((p) => p.linkId).filter((x): x is number => !!x);
  const used = linkIds.length ? await db.select({ id: t.orders.id, linkId: t.orders.linkId, comboId: t.orders.comboId, sets: t.orders.sets }).from(t.orders)
    .where(and(inArray(t.orders.linkId, linkIds), inArray(t.orders.status, ACTIVE_ORDER))) : [];
  const usedSeats = used.length ? await db.select({ orderId: t.orderSeat.orderId, zoneId: t.eventSeat.zoneId }).from(t.orderSeat)
    .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, eventId)))
    .where(inArray(t.orderSeat.orderId, used.map((o) => o.id))) : [];
  for (const p of pos) {
    const mine = used.filter((o) => o.linkId === p.linkId);
    for (const i of p.items) {
      const got = i.kind === 'combo'
        ? mine.filter((o) => o.comboId === i.id).reduce((a, o) => a + o.sets, 0)
        : usedSeats.filter((s) => s.zoneId === i.id && mine.some((o) => o.id === s.orderId)).length;
      add(`${i.kind}:${i.id}`, i.qty - got);
    }
  }
  // 付款中：先佔名額
  const pend = await db.select({ items: t.cardOrder.items }).from(t.cardOrder)
    .where(and(eq(t.cardOrder.eventId, eventId), eq(t.cardOrder.status, 'pending'), sql`${t.cardOrder.reserveUntil} > ${now.toISOString()}::timestamptz`));
  for (const p of pend) for (const i of p.items) add(`${i.kind}:${i.id}`, i.qty);

  const left: Record<string, number> = {};
  for (const z of zones) {
    if (comboZone.has(z.id)) continue;
    left[`zone:${z.id}`] = Math.max(0, rows.filter((r) => r.zoneId === z.id && !r.bundle && openSeat(r)).length - (owed.get(`zone:${z.id}`) ?? 0));
  }
  for (const c of combos.filter((x) => !x.isSingle)) {
    const size = c.items.reduce((a, i) => a + i.qty, 0);
    const groups = new Map<string, typeof rows>();
    for (const r of rows) if (r.bundle && c.items.some((i) => i.zoneId === r.zoneId)) (groups.get(r.bundle) ?? groups.set(r.bundle, []).get(r.bundle)!).push(r);
    const whole = [...groups.values()].filter((g) => g.length === size && g.every(openSeat)).length;
    left[`combo:${c.id}`] = Math.max(0, whole - (owed.get(`combo:${c.id}`) ?? 0));
  }
  return { left, freeSeats: rows.filter(openSeat).length, total: rows.length };
}

/* ---------- 購票頁 ---------- */

export async function cardMenu(db: Db, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  const cfg = await getCardConfig(db);
  const { combos, zones, comboZone, single } = await floor3Plans(db, ev.id);
  const stock = await floor3Stock(db, ev.id, now);
  const items = [
    ...combos.filter((c) => !c.isSingle && c.active && c.price > 0).map((c) => {
      const seats = c.items.reduce((a, i) => a + i.qty, 0);
      return { kind: 'combo' as const, id: c.id, name: c.name, price: c.price, unit: '組', seats, desc: c.description.trim() || `一組 ${seats} 席相連，劃位時點一下就選好整組`, left: stock.left[`combo:${c.id}`] ?? 0 };
    }),
    ...(single?.active ? zones.filter((z) => !comboZone.has(z.id) && z.open && z.price > 0).map((z) => ({
      kind: 'zone' as const, id: z.id, name: `${z.name} 單張`, price: z.price, unit: '席', seats: 1, desc: '一張一席', left: stock.left[`zone:${z.id}`] ?? 0,
    })) : []),
  ];
  return {
    state: saleStateOf(cfg.settings, now), startsAt: cfg.settings.saleStart, test: cfg.mode !== 'prod',
    event: { name: ev.name, showAt: ev.showAt.toISOString() },
    items, freeSeats: stock.freeSeats, refundText: refundText(cfg.settings, ev.showAt), invTypes: INV_TYPES,
  };
}

/** 開賣尖峰：同一份結果共用 3 秒，避免每位訪客都重算一次庫存 */
let menuCache: { at: number; data: Awaited<ReturnType<typeof cardMenu>> } | null = null;
export async function cardMenuShared(db: Db, now = Date.now()) {
  if (menuCache && now - menuCache.at < 3000) return menuCache.data;
  const data = await cardMenu(db, new Date(now));
  menuCache = { at: now, data };
  return data;
}
export const clearCardMenu = () => { menuCache = null; };

/* ---------- 建立訂單 ---------- */

const orderBody = z.object({
  items: z.array(z.object({ kind: z.enum(['combo', 'zone']), id: z.number().int().positive(), qty: z.number().int().min(1).max(2000) })).min(1, '請選擇要購買的內容').max(10),
  name: z.string().trim().min(1, '請填寫姓名').max(40),
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字')),
  email: z.string().trim().email('Email 格式不正確').max(120),
  invType: z.string(), invCode: z.string().trim().max(20).default(''), invTitle: z.string().trim().max(60).default(''),
  agree: z.literal(true, { errorMap: () => ({ message: '請先閱讀並同意個資與退票規則' }) }),
});

const tradeStamp = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/[-: ]/g, '').slice(2, 14); // yyMMddHHmmss
const TRADE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gwDate = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, '/');

export async function createCardOrder(db: Db, raw: unknown, origin: string, now = new Date()) {
  const p = orderBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const v = p.data;
  const bad = invProblem(v.invType, v.invCode, v.invTitle);
  if (bad) throw new BookingError('INVALID', bad);
  const cfg = await getCardConfig(db);
  const state = saleStateOf(cfg.settings, now);
  if (state !== 'open') throw new BookingError('SALE_CLOSED', state === 'not_started' ? '尚未開賣。' : state === 'ended' ? '已截止。' : '目前未開放購票。');
  if (!origin) throw new BookingError('SERVER', '系統網址未設定，請聯繫主辦單位。');
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);

  const order = await db.transaction(async (tx) => {
    await tx.select({ id: t.event.id }).from(t.event).where(eq(t.event.id, ev.id)).for('update'); // 同一時間只算一筆，不會超賣
    // 同一支手機重新按付款：舊的付款中訂單先放掉名額（真的付成功了，綠界通知來時仍會補上）
    await tx.update(t.cardOrder).set({ reserveUntil: now }).where(and(eq(t.cardOrder.phone, v.phone), eq(t.cardOrder.status, 'pending')));
    const { combos, zones, comboZone, single } = await floor3Plans(tx as unknown as Db, ev.id);
    const stock = await floor3Stock(tx, ev.id, now);
    const items: t.PreorderItem[] = [];
    const seen = new Set<string>();
    for (const it of v.items) {
      const key = `${it.kind}:${it.id}`;
      if (seen.has(key)) throw new BookingError('INVALID', '購買內容重複');
      seen.add(key);
      if (it.kind === 'combo') {
        const c = combos.find((x) => x.id === it.id && !x.isSingle && x.active);
        if (!c) throw new BookingError('COMBO', '此方案目前未開放。');
        items.push({ kind: 'combo', id: c.id, name: c.name, price: c.price, qty: it.qty });
      } else {
        const z = zones.find((x) => x.id === it.id && x.open && !comboZone.has(x.id));
        if (!z || !single?.active) throw new BookingError('COMBO', '單張目前未開放。');
        items.push({ kind: 'zone', id: z.id, name: `${z.name} 單張`, price: z.price, qty: it.qty });
      }
      if ((stock.left[key] ?? 0) < it.qty) throw new BookingError('SEAT_TAKEN', `「${items.at(-1)!.name}」只剩 ${stock.left[key] ?? 0}${it.kind === 'combo' ? ' 組' : ' 席'}，請調整數量。`);
    }
    const amount = items.reduce((a, x) => a + x.price * x.qty, 0);
    if (amount <= 0) throw new BookingError('INVALID', '金額不正確');
    const tradeNo = `3F${tradeStamp(now)}${Array.from({ length: 5 }, () => TRADE_CHARS[randomInt(TRADE_CHARS.length)]).join('')}`;
    const [o] = await tx.insert(t.cardOrder).values({
      eventId: ev.id, tradeNo, token: randomBytes(18).toString('base64url'), env: cfg.mode, items, amount,
      name: v.name, phone: v.phone, email: v.email, invType: v.invType, invCode: v.invCode, invTitle: v.invTitle,
      reserveUntil: new Date(now.getTime() + RESERVE_MIN * 60_000), createdAt: now,
    }).returning();
    await tx.insert(t.auditLog).values({ actor: 'buyer', action: 'card_create', target: `card:${o.id}`, detail: JSON.stringify({ tradeNo, amount }) });
    return o;
  });
  menuCache = null;

  const base = origin.replace(/\/$/, '');
  const fields: Record<string, string> = {
    MerchantID: cfg.merchantId, MerchantTradeNo: order.tradeNo, MerchantTradeDate: gwDate(now), PaymentType: 'aio',
    TotalAmount: String(order.amount), TradeDesc: 'Admission ticket',
    ItemName: order.items.map((i) => `${i.name} x${i.qty}`).join('#').slice(0, 300),
    ReturnURL: `${base}/api/card/return`, OrderResultURL: `${base}/api/card/result`, ClientBackURL: `${base}/3f/r/${order.token}`,
    ChoosePayment: 'Credit', EncryptType: '1', NeedExtraPaidInfo: 'Y',
  };
  fields.CheckMacValue = checkMac(fields, cfg.hashKey, cfg.hashIV);
  return { action: `${BASE[cfg.mode]}/Cashier/AioCheckOut/V5`, fields, token: order.token };
}

/* ---------- 付款成功：冪等 ---------- */

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export interface PaidInfo { gwTradeNo: string; gwAuthNo?: string; amount: number; via: 'return' | 'result' | 'query' | 'admin'; simulate?: boolean }

/** 把訂單改成已付款並發權利。重複呼叫不會重複發票、重複寄信 */
export async function markPaid(db: Db, tradeNo: string, info: PaidInfo, now = new Date()) {
  const r = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.cardOrder).where(eq(t.cardOrder.tradeNo, tradeNo)).for('update');
    if (!o) return { kind: 'unknown' as const };
    if (['paid', 'refunding', 'refunded'].includes(o.status)) return { kind: 'already' as const, o };
    if (info.amount !== o.amount) {
      await tx.update(t.cardOrder).set({ flagged: true, note: `${o.note}綠界回報金額 ${info.amount} 與訂單 ${o.amount} 不符。`.slice(-500) }).where(eq(t.cardOrder.id, o.id));
      await tx.insert(t.auditLog).values({ actor: 'system', action: 'card_amount_mismatch', target: `card:${o.id}`, detail: JSON.stringify(info) });
      return { kind: 'mismatch' as const, o };
    }
    const [ev] = await tx.select().from(t.event).where(eq(t.event.id, o.eventId));
    const expiresAt = new Date(`${tpeDate(ev.showAt)}T23:59:59+08:00`);
    const code = Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const label = o.items.map((i) => `${i.name} × ${i.qty}`).join('、');
    const [link] = await tx.insert(t.inviteLink).values({
      eventId: o.eventId, code, name: o.name, phone: o.phone, quota: 0, expiresAt, floor: '3F', note: `刷卡 ${o.tradeNo}・${label}`.slice(0, 300),
    }).returning();
    const [po] = await tx.insert(t.preorder).values({
      eventId: o.eventId, no: o.tradeNo, items: o.items, amount: o.amount, name: o.name, phone: o.phone, email: o.email,
      paidAmount: o.amount, last5: '', status: 'confirmed', linkId: link.id, source: 'card', confirmedAt: now, confirmedBy: '綠界', seenAt: now,
      paidOkAt: now, paidOkBy: '綠界', invType: o.invType, invCode: o.invCode, invTitle: o.invTitle, createdAt: o.createdAt,
    }).returning();
    await tx.update(t.cardOrder).set({
      status: 'paid', paidAt: now, paidVia: info.via, preorderId: po.id, linkId: link.id, gwTradeNo: info.gwTradeNo, gwAuthNo: info.gwAuthNo ?? '',
    }).where(eq(t.cardOrder.id, o.id));
    const url = `${await siteOrigin(tx as unknown as Db)}/t/${code}`;
    await tx.insert(t.notification).values({
      linkId: link.id, channel: 'email', template: 'preorder_link', recipient: o.email,
      content: `【${ev.name}】${o.name} 您好，已收到您的付款（訂單 ${o.tradeNo}：${label}）。請立即點以下專屬連結選座位，座位依付款先後選取：${url}　連結有效至演出當天，請勿轉傳他人。`,
    });
    await tx.insert(t.auditLog).values({ actor: `card:${info.via}`, action: 'card_paid', target: `card:${o.id}`, detail: JSON.stringify({ tradeNo, gw: info.gwTradeNo }) });
    return { kind: 'fresh' as const, o, code, preorderId: po.id };
  });
  menuCache = null;
  if (r.kind === 'fresh') {
    await ensureInvoice(db, r.preorderId).catch((e) => console.error('三樓發票開立失敗', e)); // 開票失敗不影響付款，定時會再試
    const stock = await floor3Stock(db, r.o.eventId, now).catch(() => null);
    const short = stock && r.o.items.some((i) => (stock.left[`${i.kind}:${i.id}`] ?? 0) === 0 && now > r.o.reserveUntil);
    if (short) await db.update(t.cardOrder).set({ flagged: true, note: `${r.o.note}逾時後才付款，請確認座位是否足夠。`.slice(-500) }).where(eq(t.cardOrder.tradeNo, tradeNo));
  }
  return r;
}

/** 刷卡單的發票：不看「開立時機」設定，建立後直接開；電腦核對有異常的留給人工 */
async function ensureInvoice(db: Db, preorderId: number) {
  const inv = await createForPreorder(db, preorderId, '三樓刷卡');
  if (inv && inv.status === 'pending' && !inv.checks.length) await issueInvoice(db, inv.id, '三樓刷卡');
}

/* ---------- 第一、二道保險：綠界通知、買方回來 ---------- */

export type CardPost = (url: string, params: Record<string, string>) => Promise<string>;
export const realPost: CardPost = async (url, params) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000) });
  if (res.status === 403) throw new GatewayThrottled();
  if (!res.ok) throw new Error(`綠界回應 HTTP ${res.status}`);
  return res.text();
};
class GatewayThrottled extends Error { constructor() { super('綠界要求放慢查詢（HTTP 403）'); } }

/** 收到綠界的 POST（ReturnURL／OrderResultURL）。回傳處理結果 */
export async function handleGatewayResult(db: Db, form: Record<string, string>, via: 'return' | 'result', now = new Date()) {
  const cfg = await getCardConfig(db);
  const tradeNo = form.MerchantTradeNo ?? '';
  const [o] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.tradeNo, tradeNo));
  // 訂單是哪個環境建立的就用哪組金鑰驗（切到正式後，測試單的通知不算數）
  if (!o || o.env !== cfg.mode || !macOk(form, cfg.hashKey, cfg.hashIV)) {
    await db.insert(t.auditLog).values({ actor: `card:${via}`, action: 'card_bad_mac', target: tradeNo.slice(0, 40) || 'unknown' });
    return { ok: false as const, token: null, code: null };
  }
  if (form.SimulatePaid === '1') { // 綠界後台的「模擬付款」：沒有真的收錢，不能給票
    await db.insert(t.auditLog).values({ actor: `card:${via}`, action: 'card_simulate', target: `card:${o.id}` });
    return { ok: true as const, token: o.token, code: null };
  }
  if (form.RtnCode !== '1') {
    await db.update(t.cardOrder).set({ status: 'failed', note: `${o.note}${form.RtnMsg ?? ''}`.slice(-500), reserveUntil: now })
      .where(and(eq(t.cardOrder.id, o.id), eq(t.cardOrder.status, 'pending')));
    menuCache = null;
    return { ok: true as const, token: o.token, code: null };
  }
  const r = await markPaid(db, tradeNo, { gwTradeNo: form.TradeNo ?? '', gwAuthNo: form.gwsr ?? '', amount: Number(form.TradeAmt), via }, now);
  return { ok: true as const, token: o.token, code: await linkCodeOf(db, r) };
}

async function linkCodeOf(db: Db, r: Awaited<ReturnType<typeof markPaid>>) {
  if (r.kind === 'fresh') return r.code;
  if (r.kind !== 'already' || !r.o.linkId || r.o.status !== 'paid') return null;
  const [l] = await db.select({ code: t.inviteLink.code }).from(t.inviteLink).where(eq(t.inviteLink.id, r.o.linkId));
  return l?.code ?? null;
}

/* ---------- 第三道保險：向綠界查詢 ---------- */

const g = globalThis as unknown as { __ticcCardGate?: { next: number; pauseUntil: number }; __ticcCardPoll?: NodeJS.Timeout };
const gate = () => (g.__ticcCardGate ??= { next: 0, pauseUntil: 0 });
const QUERY_GAP_MS = 2000; // 綠界：查太快會回 403，要等 30 分鐘

/** 查一筆。回傳綠界的狀態；太頻繁時回傳 null，下次再查 */
export async function queryOne(db: Db, o: typeof t.cardOrder.$inferSelect, now = new Date(), post: CardPost = realPost) {
  const cfg = await getCardConfig(db);
  if (o.env !== cfg.mode) return null;
  const q = gate();
  const clock = Date.now();
  if (clock < q.pauseUntil || clock < q.next) return null;
  q.next = clock + QUERY_GAP_MS;
  await db.update(t.cardOrder).set({ lastQueryAt: now }).where(eq(t.cardOrder.id, o.id));
  const params: Record<string, string> = { MerchantID: cfg.merchantId, MerchantTradeNo: o.tradeNo, TimeStamp: String(Math.floor(now.getTime() / 1000)) };
  params.CheckMacValue = checkMac(params, cfg.hashKey, cfg.hashIV);
  let text: string;
  try { text = await post(`${BASE[cfg.mode]}/Cashier/QueryTradeInfo/V5`, params); } catch (e) {
    if (e instanceof GatewayThrottled) q.pauseUntil = clock + 30 * 60_000;
    throw e;
  }
  const res = Object.fromEntries(new URLSearchParams(text));
  if (res.CheckMacValue && !macOk(res, cfg.hashKey, cfg.hashIV)) throw new BookingError('EINVOICE', '綠界查詢結果檢查碼不符');
  return res;
}

/** 依查詢結果處理一筆 pending；回傳 true＝這次補上了付款 */
async function applyQuery(db: Db, o: typeof t.cardOrder.$inferSelect, res: Record<string, string>, now: Date, via: 'query' | 'admin') {
  if (res.TradeStatus === '1') {
    const r = await markPaid(db, o.tradeNo, { gwTradeNo: res.TradeNo ?? '', gwAuthNo: res.gwsr ?? '', amount: Number(res.TradeAmt), via }, now);
    return r.kind === 'fresh';
  }
  const age = now.getTime() - o.createdAt.getTime();
  if (res.TradeStatus === '10200095' || age > 2 * 3600_000) { // 綠界說沒成立，或超過兩小時都沒付
    await db.update(t.cardOrder).set({ status: res.TradeStatus === '10200095' ? 'failed' : 'expired', reserveUntil: now }).where(and(eq(t.cardOrder.id, o.id), eq(t.cardOrder.status, 'pending')));
    menuCache = null;
  }
  return false;
}

/** 定時：綠界建議信用卡付款後約 10 分鐘再查，查過的隔 10 分鐘再查 */
export async function pollPending(db: Db, now = new Date(), post: CardPost = realPost) {
  const before = new Date(now.getTime() - 10 * 60_000).toISOString();
  const rows = await db.select().from(t.cardOrder)
    .where(and(eq(t.cardOrder.status, 'pending'), lt(t.cardOrder.createdAt, new Date(before)), sql`(${t.cardOrder.lastQueryAt} is null or ${t.cardOrder.lastQueryAt} < ${before}::timestamptz)`))
    .orderBy(t.cardOrder.lastQueryAt, t.cardOrder.id).limit(10);
  let fixed = 0;
  for (const o of rows) {
    try {
      const res = await queryOne(db, o, now, post);
      if (res && await applyQuery(db, o, res, now, 'query')) fixed++;
    } catch (e) { console.error('向綠界查詢失敗', o.tradeNo, e); }
    if (post === realPost) await new Promise((r) => { setTimeout(r, QUERY_GAP_MS + 100); });
  }
  // 付款成功但發票還沒開好的，再試一次
  const open = await db.select({ id: t.invoice.id, p: t.invoice.preorderId }).from(t.invoice)
    .innerJoin(t.preorder, eq(t.preorder.id, t.invoice.preorderId))
    .where(and(eq(t.preorder.source, 'card'), eq(t.preorder.status, 'confirmed'), inArray(t.invoice.status, ['pending', 'failed']), sql`jsonb_array_length(${t.invoice.checks}) = 0`)).limit(5);
  for (const i of open) await issueInvoice(db, i.id, '三樓刷卡').catch((e) => console.error('三樓發票重試失敗', e));
  return { checked: rows.length, fixed };
}

export function startCardPoller(db: Db) {
  if (g.__ticcCardPoll || process.env.VITEST) return;
  g.__ticcCardPoll = setInterval(() => { pollPending(db).catch((e) => console.error('三樓定時查詢失敗', e)); }, 60_000);
}

/** 買方在結果頁等待時：還沒收到通知，就主動問一次（每筆至少隔 1 分鐘） */
export async function cardStatus(db: Db, token: string, now = new Date(), post: CardPost = realPost) {
  let [o] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.token, token));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這筆訂單');
  const stale = !o.lastQueryAt || now.getTime() - o.lastQueryAt.getTime() > 60_000;
  if (o.status === 'pending' && now.getTime() - o.createdAt.getTime() > 60_000 && stale) {
    try {
      const res = await queryOne(db, o, now, post);
      if (res) {
        await applyQuery(db, o, res, now, 'query');
        [o] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.id, o.id));
      }
    } catch (e) { console.error('向綠界查詢失敗', e); }
  }
  let code: string | null = null;
  if (o.linkId && o.status === 'paid') [{ code }] = await db.select({ code: t.inviteLink.code }).from(t.inviteLink).where(eq(t.inviteLink.id, o.linkId));
  return { status: o.status, code, orderNo: o.tradeNo };
}

/* ---------- 退票 ---------- */

type Close = '已授權' | '要關帳' | '已關帳' | '操作取消' | null;

/** 依關帳狀態決定要對綠界做哪些動作（綠界文件 2885）。回傳字串＝不能退的原因 */
export function refundActions(close: Close, full: boolean): ('R' | 'E' | 'N')[] | string {
  switch (close) {
    case '已關帳': return ['R'];
    case '要關帳': return full ? ['E', 'N'] : ['R'];
    case '已授權': case '操作取消': return full ? ['N'] : '這筆刷卡還沒關帳，只能全額退（手續費改 0），或明天再退。';
    default: return ['R'];
  }
}

async function closeStatus(cfg: CardConfig, o: typeof t.cardOrder.$inferSelect, post: CardPost): Promise<Close> {
  if (!cfg.checkCode || !o.gwAuthNo) return null; // 沒填商家檢查碼：直接試 R，綠界會回覆能不能退
  const params: Record<string, string> = { MerchantID: cfg.merchantId, CreditRefundId: o.gwAuthNo, CreditAmount: String(o.amount), CreditCheckCode: cfg.checkCode };
  params.CheckMacValue = checkMac(params, cfg.hashKey, cfg.hashIV);
  const text = await post(`${BASE.prod}/CreditDetail/QueryTrade/V2`, params);
  try {
    const v = JSON.parse(text).RtnValue as { status?: string; close_data?: { status: string; amount: number }[] } | '';
    if (!v) return null;
    const last = (v.close_data ?? []).filter((c) => Number(c.amount) > 0).at(-1);
    return (last?.status ?? v.status ?? null) as Close;
  } catch { return null; }
}

async function gatewayRefund(cfg: CardConfig, o: typeof t.cardOrder.$inferSelect, refund: number, post: CardPost) {
  const plan = refundActions(await closeStatus(cfg, o, post), refund === o.amount);
  if (typeof plan === 'string') throw new BookingError('INVALID', plan);
  for (const action of plan) {
    const params: Record<string, string> = { MerchantID: cfg.merchantId, MerchantTradeNo: o.tradeNo, TradeNo: o.gwTradeNo, Action: action, TotalAmount: String(action === 'R' ? refund : o.amount) };
    params.CheckMacValue = checkMac(params, cfg.hashKey, cfg.hashIV);
    const res = Object.fromEntries(new URLSearchParams(await post(`${BASE.prod}/CreditDetail/DoAction`, params)));
    if (res.RtnCode !== '1') throw new BookingError('EINVOICE', `綠界刷退失敗：${res.RtnMsg || `代碼 ${res.RtnCode ?? '不明'}`}（已刷退的動作：${action}）`);
  }
}

/**
 * 退票：綠界刷退 → 座位釋出、舊 QR 失效、連結停用 → 發票作廢。
 * fee 不給時依規則計算；後台可改（主辦方因素填 0）。
 * 綠界失敗時什麼都不動；綠界成功但作廢發票失敗時，訂單標紅請人工處理。
 */
export async function refundCardOrder(db: Db, actor: string, id: number, opt: { fee?: number; late?: boolean } = {}, now = new Date(), post: CardPost = realPost) {
  const cfg = await getCardConfig(db);
  const [o0] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.id, id));
  if (!o0) throw new BookingError('NOT_FOUND', '找不到這筆訂單');
  if (o0.status !== 'paid') throw new BookingError('INVALID', '只有已付款的訂單可以退票');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, o0.eventId));
  if (!refundOpen(cfg.settings, ev.showAt, now) && !opt.late) throw new BookingError('INVALID', `已超過退票期限（${refundLastDay(ev.showAt, cfg.settings.refundDays)}）。主辦方同意的話，請勾「超過期限仍要退」。`);
  const fee = opt.fee ?? refundFeeOf(o0.amount, cfg.settings.refundFeePct);
  if (!Number.isInteger(fee) || fee < 0 || fee >= o0.amount) throw new BookingError('INVALID', '手續費金額不正確');
  const refund = o0.amount - fee;
  const tpeHm = now.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 5);
  if (o0.env === 'prod' && tpeHm >= '20:15' && tpeHm < '20:30') throw new BookingError('INVALID', '綠界每天 20:15–20:30 關帳，這段時間不能刷退，請 20:30 後再按。');

  const orders = o0.linkId ? await db.select().from(t.orders).where(and(eq(t.orders.linkId, o0.linkId), inArray(t.orders.status, ACTIVE_ORDER))) : [];
  if (orders.length) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.checkin).where(inArray(t.checkin.orderId, orders.map((x) => x.id)));
    if (n > 0) throw new BookingError('INVALID', '這筆訂單已有人入場，不能退票。');
  }
  // 先搶狀態，連按兩下也只會刷退一次
  const [o] = await db.update(t.cardOrder).set({ status: 'refunding' }).where(and(eq(t.cardOrder.id, id), eq(t.cardOrder.status, 'paid'))).returning();
  if (!o) throw new BookingError('INVALID', '這筆訂單正在退票中');
  try {
    if (o.env === 'prod') await gatewayRefund(cfg, o, refund, post); // 綠界測試環境沒有刷退功能，只走系統流程
  } catch (e) {
    await db.update(t.cardOrder).set({ status: 'paid' }).where(eq(t.cardOrder.id, id));
    throw e;
  }

  await db.transaction(async (tx) => {
    const ids = orders.map((x) => x.id);
    if (ids.length) {
      await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'refund', holdUntil: null }).where(inArray(t.orders.id, ids));
      await freeSeatsOf(tx, ids);
    }
    if (o.linkId) await tx.update(t.inviteLink).set({ status: 'disabled' }).where(eq(t.inviteLink.id, o.linkId));
    if (o.preorderId) await tx.update(t.preorder).set({ status: 'cancelled' }).where(eq(t.preorder.id, o.preorderId));
    await tx.update(t.cardOrder).set({ status: 'refunded', refundedAt: now, refundAmount: refund, refundFee: fee, refundBy: actor }).where(eq(t.cardOrder.id, id));
    await tx.insert(t.notification).values({
      linkId: o.linkId, channel: 'email', template: 'order_cancelled', recipient: o.email,
      content: `【${ev.name}】${o.name} 您好，訂單 ${o.tradeNo} 已完成退票，退款 NT$${refund.toLocaleString('en-US')}${fee ? `（已扣手續費 NT$${fee.toLocaleString('en-US')}）` : ''} 將退回原信用卡，實際入帳時間依發卡銀行而定。原座位與入場 QR code 已失效。`,
    });
    await tx.insert(t.auditLog).values({ actor, action: 'card_refund', target: `card:${id}`, detail: JSON.stringify({ tradeNo: o.tradeNo, refund, fee, env: o.env }) });
  });
  menuCache = null;

  // 發票：已開的作廢，還沒開的取消
  const invs = o.preorderId ? await db.select().from(t.invoice).where(and(eq(t.invoice.preorderId, o.preorderId), sql`${t.invoice.status} <> 'void'`)) : [];
  const problems: string[] = [];
  for (const inv of invs) {
    if (inv.status === 'issued') {
      try { await voidInvoice(db, inv.id, actor, '退票'); } catch (e) { problems.push(`發票 ${inv.invoiceNo} 作廢失敗：${(e as Error).message}`); }
    } else await db.update(t.invoice).set({ status: 'void', voidedAt: now, voidReason: '退票' }).where(eq(t.invoice.id, inv.id));
  }
  if (problems.length) await db.update(t.cardOrder).set({ flagged: true, note: `${o.note}${problems.join('；')}`.slice(-500) }).where(eq(t.cardOrder.id, id));
  return { refund, fee, simulated: o.env !== 'prod', problems };
}

/** 後台：向綠界查一筆，查到已付款就補單 */
export async function adminQuery(db: Db, actor: string, id: number, now = new Date(), post: CardPost = realPost) {
  const [o] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.id, id));
  if (!o) throw new BookingError('NOT_FOUND', '找不到這筆訂單');
  const cfg = await getCardConfig(db);
  if (o.env !== cfg.mode) throw new BookingError('INVALID', `這筆是在「${CARD_MODE_NAME[o.env as CardMode]}」建立的，目前模式查不到。`);
  gate().next = 0; // 人工按的不排隊，但仍遵守綠界的暫停時間
  const res = await queryOne(db, o, now, post);
  if (!res) throw new BookingError('TOO_MANY', '綠界要求放慢查詢，請 30 分鐘後再試。');
  const fixed = o.status === 'pending' ? await applyQuery(db, o, res, now, 'admin') : false;
  await db.insert(t.auditLog).values({ actor, action: 'card_query', target: `card:${id}`, detail: JSON.stringify({ TradeStatus: res.TradeStatus, fixed }) });
  return { tradeStatus: res.TradeStatus ?? '', tradeNo: res.TradeNo ?? '', amount: Number(res.TradeAmt ?? 0), paymentDate: res.PaymentDate ?? '', fixed };
}

/* ---------- 後台 ---------- */

export async function floor3State(db: Db, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return null;
  const { combos, zones, comboZone } = await floor3Plans(db, ev.id);
  const seats = (await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, block: t.venueSeat.block, code: t.venueSeat.code,
    zoneId: t.eventSeat.zoneId, usageId: t.eventSeat.usageId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, bundle: t.eventSeat.bundle,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '3F'))))
    .map((s) => ({ id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, block: s.block, code: s.code, row: rowKey(s), label: seatLabel(s), zoneId: s.zoneId, usageId: s.usageId, status: s.status, orderId: s.orderId, bundle: s.bundle, installed: true }));
  const rows = await db.select().from(t.cardOrder).where(eq(t.cardOrder.eventId, ev.id)).orderBy(desc(t.cardOrder.id)).limit(500);
  const invs = rows.some((r) => r.preorderId) ? await db.select().from(t.invoice).where(inArray(t.invoice.preorderId, rows.map((r) => r.preorderId).filter((x): x is number => !!x))) : [];
  const links = rows.some((r) => r.linkId) ? await db.select({ id: t.inviteLink.id, code: t.inviteLink.code }).from(t.inviteLink).where(inArray(t.inviteLink.id, rows.map((r) => r.linkId).filter((x): x is number => !!x))) : [];
  const ords = links.length ? await db.select({ linkId: t.orders.linkId, id: t.orders.id, status: t.orders.status }).from(t.orders).where(inArray(t.orders.linkId, links.map((l) => l.id))) : [];
  const oseats = ords.length ? await db.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId }).from(t.orderSeat).where(inArray(t.orderSeat.orderId, ords.filter((x) => x.status === 'paid' || x.status === 'pending').map((x) => x.id))) : [];
  const cfg = await getCardConfig(db);
  const paid = rows.filter((r) => ['paid', 'refunding'].includes(r.status));
  const stock = await floor3Stock(db, ev.id, now);
  return {
    config: await publicCardConfig(db),
    state: saleStateOf(cfg.settings, now), refundText: refundText(cfg.settings, ev.showAt), refundLastDay: refundLastDay(ev.showAt, cfg.settings.refundDays),
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, price: z.price, open: z.open, combo: comboZone.has(z.id), seatCount: seats.filter((s) => s.zoneId === z.id).length })),
    combos: combos.map((c) => ({ id: c.id, name: c.name, isSingle: c.isSingle, price: c.price, active: c.active, seats: c.items.reduce((a, i) => a + i.qty, 0) })),
    seats, stock,
    stats: { total: seats.length, sold: seats.filter((s) => s.status === 'sold').length, picking: seats.filter((s) => s.status === 'held' || s.status === 'pending').length, free: stock.freeSeats, orders: paid.length, revenue: paid.reduce((a, r) => a + r.amount, 0), refunded: rows.filter((r) => r.status === 'refunded').length, flagged: rows.filter((r) => r.flagged).length, pending: rows.filter((r) => r.status === 'pending').length },
    orders: rows.map((r) => ({
      id: r.id, tradeNo: r.tradeNo, gwTradeNo: r.gwTradeNo, env: r.env, status: r.status, items: r.items.map((i) => `${i.name} × ${i.qty}`).join('、'), amount: r.amount,
      name: r.name, phone: r.phone, email: r.email, invoice: invDesc(r.invType, r.invCode, r.invTitle, r.email), paidVia: r.paidVia, note: r.note, flagged: r.flagged,
      createdAt: r.createdAt.toISOString(), paidAt: r.paidAt?.toISOString() ?? null, refundedAt: r.refundedAt?.toISOString() ?? null, refundAmount: r.refundAmount, refundFee: r.refundFee,
      invoiceNo: invs.filter((i) => i.preorderId === r.preorderId).at(-1)?.invoiceNo ?? '', invoiceStatus: invs.filter((i) => i.preorderId === r.preorderId).at(-1)?.status ?? '',
      linkCode: links.find((l) => l.id === r.linkId)?.code ?? '',
      seats: oseats.filter((s) => ords.some((x) => x.id === s.orderId && x.linkId === r.linkId)).length,
    })),
  };
}
