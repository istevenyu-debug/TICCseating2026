/**
 * 2M 刷卡專屬連結（不公開，只給特定買方）。
 *
 *   後台建立連結（可買哪些方案、最多幾組、退票規則）→ 買方打開 /c/<code>
 *   → 選方案與組數、填資料、勾選同意退票規則 → createLinkOrder 先佔名額 → 綠界刷卡
 *   → 付款成功：沿用 card.ts 的 markPaid（建立 2M 劃位連結 paidCard、寄信、開發票）
 *   → 買方用劃位連結選座位，送出就算劃位成功、馬上給 QR（booking.submitOrder）。
 *
 * 和現有流程分開：三樓公開購票、2M 匯款認購都不經過這裡；只有 card_order.floor = '2M' 的訂單會用到。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError, linkEntitle, loadCombos, usedComboSets, type Tx } from './booking';
import { RESERVE_MIN, gatewayForm, getCardConfig, refundLastDay, tradeNoOf } from './card';
import { INV_TYPES, invProblem } from './invoiceRules';
import { normalizePhone } from './validation';

type Exec = Db | Tx;
export type CardLinkRow = typeof t.cardLink.$inferSelect;

const md = (date: string) => { const [, m, d] = date.split('-').map(Number); return `${m}/${d}`; };

/** 付款前給買方看、並存進訂單的退票／轉讓規則 */
export function policyText(l: Pick<CardLinkRow, 'policy' | 'transferDays' | 'refundDays' | 'refundFeePct'>, showAt: Date) {
  const cancel = '如因主辦方因素取消或延期，全額退費、不收手續費。';
  if (l.policy === 'refund') {
    return `演出前 ${l.refundDays} 日（${md(refundLastDay(showAt, l.refundDays))}）以前可申請退票，酌收票面金額 ${l.refundFeePct}% 手續費；逾期恕不受理。${cancel}`;
  }
  return `本票券售出後恕不退票，但可轉讓：演出前 ${l.transferDays} 日（${md(refundLastDay(showAt, l.transferDays))}）以前，請聯繫主辦單位更改持票人姓名。${cancel}`;
}

async function ev0(db: Exec) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/* ---------- 庫存：2M 還能賣幾組 ---------- */

/**
 * 每個 2M 方案還能賣幾組＝各區空位扣掉「已付款還沒劃的」與「刷卡付款中先佔的」，再除以每組要幾席（取最小）。
 * 已付款還沒劃的：所有已收款的認購單（匯款、刷卡都算），已劃的扣掉；還沒發連結的整張算。
 * 方案有限量組數時，也扣掉已劃與已付款未劃的組數。
 */
export async function stock2M(db: Exec, eventId: number, now: Date) {
  const combos = (await loadCombos(db, eventId)).filter((c) => c.floor === '2M' && !c.isSingle);
  const all2M = new Map((await loadCombos(db, eventId)).filter((c) => c.floor === '2M').map((c) => [c.id, c]));
  const zones2M = new Set((await db.select({ id: t.priceZone.id }).from(t.priceZone).where(and(eq(t.priceZone.eventId, eventId), eq(t.priceZone.floor, '2M')))).map((z) => z.id));
  const free = new Map<number, number>();
  const rows = await db.select({ zoneId: t.eventSeat.zoneId, n: sql<number>`count(*)::int` }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.venueSeat.floor, '2M'), eq(t.eventSeat.status, 'free'), eq(t.seatUsage.sellable, true)))
    .groupBy(t.eventSeat.zoneId);
  for (const r of rows) free.set(r.zoneId, Number(r.n));

  const owedZone = new Map<number, number>();
  const owedSets = new Map<number, number>();
  const addItem = (kind: 'combo' | 'zone', id: number, left: number) => {
    if (left <= 0) return;
    if (kind === 'zone') { if (zones2M.has(id)) owedZone.set(id, (owedZone.get(id) ?? 0) + left); return; }
    const c = all2M.get(id);
    if (!c) return;
    owedSets.set(id, (owedSets.get(id) ?? 0) + left);
    for (const i of c.items) owedZone.set(i.zoneId, (owedZone.get(i.zoneId) ?? 0) + left * i.qty);
  };
  const pos = await db.select({ linkId: t.preorder.linkId, items: t.preorder.items }).from(t.preorder)
    .where(and(eq(t.preorder.eventId, eventId), eq(t.preorder.status, 'confirmed')));
  for (const p of pos) {
    if (!p.items.some((i) => (i.kind === 'combo' ? all2M.has(i.id) : zones2M.has(i.id)))) continue;
    if (!p.linkId) { for (const i of p.items) addItem(i.kind, i.id, i.qty); continue; }
    const ent = await linkEntitle(db, p.linkId, p.items);
    for (const r of ent?.rows ?? []) addItem(r.kind, r.id, r.left);
  }
  const pend = await db.select({ items: t.cardOrder.items }).from(t.cardOrder)
    .where(and(eq(t.cardOrder.eventId, eventId), eq(t.cardOrder.floor, '2M'), eq(t.cardOrder.status, 'pending'), sql`${t.cardOrder.reserveUntil} > ${now.toISOString()}::timestamptz`));
  for (const p of pend) for (const i of p.items) addItem(i.kind, i.id, i.qty);

  const used = await usedComboSets(db, eventId);
  const left: Record<number, number> = {};
  for (const c of combos) {
    let n = Math.min(...c.items.map((i) => Math.floor(Math.max(0, (free.get(i.zoneId) ?? 0) - (owedZone.get(i.zoneId) ?? 0)) / Math.max(1, i.qty))));
    if (c.limitSets > 0) n = Math.min(n, c.limitSets - (used[c.id] ?? 0) - (owedSets.get(c.id) ?? 0));
    left[c.id] = Math.max(0, Number.isFinite(n) ? n : 0);
  }
  return left;
}

/* ---------- 後台：建立、修改、列出 ---------- */

const linkInput = z.object({
  name: z.string().trim().max(60).default(''),
  comboIds: z.array(z.number().int().positive()).min(1, '請至少勾一個方案').max(20),
  maxSets: z.number().int().min(0).max(1000).default(0),
  policy: z.enum(['transfer', 'refund']).default('transfer'),
  transferDays: z.number().int().min(0).max(60).default(3),
  refundDays: z.number().int().min(0).max(60).default(10),
  refundFeePct: z.number().int().min(0).max(10).default(10), // 法規上限 10%
  note: z.string().trim().max(200).default(''),
});

async function check2MCombos(db: Exec, eventId: number, ids: number[]) {
  const ok = new Set((await loadCombos(db, eventId)).filter((c) => c.floor === '2M' && !c.isSingle && c.price > 0).map((c) => c.id));
  if (ids.some((id) => !ok.has(id))) throw new BookingError('INVALID', '只能選 2M 的組合方案（有價格的）。');
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export async function createCardLink(db: Db, actor: string, raw: unknown) {
  const p = linkInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const ev = await ev0(db);
  await check2MCombos(db, ev.id, p.data.comboIds);
  const code = Array.from({ length: 12 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  const [l] = await db.insert(t.cardLink).values({ eventId: ev.id, code, ...p.data, comboIds: [...new Set(p.data.comboIds)], createdBy: actor }).returning();
  await db.insert(t.auditLog).values({ actor, action: 'card_link_create', target: `card_link:${l.id}`, detail: JSON.stringify(p.data) });
  return { id: l.id, code };
}

export async function updateCardLink(db: Db, actor: string, id: number, raw: unknown) {
  const p = linkInput.partial().extend({ active: z.boolean().optional() }).safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const [l] = await db.select().from(t.cardLink).where(eq(t.cardLink.id, id));
  if (!l) throw new BookingError('NOT_FOUND', '找不到這條連結');
  if (p.data.comboIds) await check2MCombos(db, l.eventId, p.data.comboIds);
  await db.update(t.cardLink).set(p.data).where(eq(t.cardLink.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'card_link_update', target: `card_link:${id}`, detail: JSON.stringify(p.data) });
  return { ok: true };
}

export async function listCardLinks(db: Db, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return null;
  const links = await db.select().from(t.cardLink).where(eq(t.cardLink.eventId, ev.id)).orderBy(desc(t.cardLink.id));
  const ords = links.length ? await db.select({ cardLinkId: t.cardOrder.cardLinkId, status: t.cardOrder.status, amount: t.cardOrder.amount, items: t.cardOrder.items })
    .from(t.cardOrder).where(inArray(t.cardOrder.cardLinkId, links.map((l) => l.id))) : [];
  const combos = (await loadCombos(db, ev.id)).filter((c) => c.floor === '2M' && !c.isSingle && c.price > 0)
    .map((c) => ({ id: c.id, name: c.name, price: c.price, hidden: c.hidden, active: c.active, seats: c.items.reduce((a, i) => a + i.qty, 0) }));
  const left = await stock2M(db, ev.id, now);
  return {
    combos: combos.map((c) => ({ ...c, left: left[c.id] ?? 0 })),
    links: links.map((l) => {
      const mine = ords.filter((o) => o.cardLinkId === l.id && ['paid', 'refunding'].includes(o.status));
      return {
        id: l.id, code: l.code, name: l.name, comboIds: l.comboIds, maxSets: l.maxSets, policy: l.policy, transferDays: l.transferDays,
        refundDays: l.refundDays, refundFeePct: l.refundFeePct, active: l.active, note: l.note, createdAt: l.createdAt.toISOString(),
        terms: policyText(l, ev.showAt), paid: mine.length, sets: mine.reduce((a, o) => a + o.items.reduce((b, i) => b + i.qty, 0), 0), revenue: mine.reduce((a, o) => a + o.amount, 0),
        pending: ords.filter((o) => o.cardLinkId === l.id && o.status === 'pending').length,
      };
    }),
  };
}

/* ---------- 買方 ---------- */

async function activeLink(db: Exec, code: string) {
  const [l] = await db.select().from(t.cardLink).where(eq(t.cardLink.code, code));
  if (!l || !l.active) throw new BookingError('LINK_DISABLED', '這條購買連結無效或已停用，請聯繫主辦單位。');
  return l;
}

/** 這條連結已買（含付款中先佔）的組數 */
async function boughtSets(db: Exec, linkId: number, now: Date) {
  const os = await db.select({ status: t.cardOrder.status, reserveUntil: t.cardOrder.reserveUntil, items: t.cardOrder.items }).from(t.cardOrder).where(eq(t.cardOrder.cardLinkId, linkId));
  return os.filter((o) => ['paid', 'refunding'].includes(o.status) || (o.status === 'pending' && o.reserveUntil > now))
    .reduce((a, o) => a + o.items.reduce((b, i) => b + i.qty, 0), 0);
}

export async function linkMenu(db: Db, code: string, now = new Date()) {
  const l = await activeLink(db, code);
  const ev = await ev0(db);
  const cfg = await getCardConfig(db);
  const left = await stock2M(db, ev.id, now);
  const room = l.maxSets > 0 ? Math.max(0, l.maxSets - await boughtSets(db, l.id, now)) : null;
  const items = (await loadCombos(db, ev.id)).filter((c) => l.comboIds.includes(c.id) && c.floor === '2M' && c.active).map((c) => {
    const seats = c.items.reduce((a, i) => a + i.qty, 0);
    return { id: c.id, name: c.name, price: c.price, seats, desc: c.description.trim(), left: Math.min(left[c.id] ?? 0, room ?? Infinity) };
  });
  return {
    ready: !!cfg.merchantId && !!cfg.hashKey, test: cfg.mode !== 'prod', name: l.name,
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, items, maxSets: l.maxSets, room, terms: policyText(l, ev.showAt), invTypes: INV_TYPES,
  };
}

const orderBody = z.object({
  items: z.array(z.object({ id: z.number().int().positive(), qty: z.number().int().min(1).max(200) })).min(1, '請選擇要購買的方案').max(10),
  name: z.string().trim().min(1, '請填寫姓名').max(40),
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字')),
  email: z.string().trim().email('Email 格式不正確').max(120),
  invType: z.string(), invCode: z.string().trim().max(20).default(''), invTitle: z.string().trim().max(60).default(''),
  agree: z.literal(true, { errorMap: () => ({ message: '請先閱讀並勾選同意退票與轉讓規則、個資使用' }) }),
});

export async function createLinkOrder(db: Db, code: string, raw: unknown, origin: string, now = new Date()) {
  const p = orderBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const v = p.data;
  const bad = invProblem(v.invType, v.invCode, v.invTitle);
  if (bad) throw new BookingError('INVALID', bad);
  const cfg = await getCardConfig(db);
  if (!cfg.merchantId || !cfg.hashKey) throw new BookingError('SALE_CLOSED', '刷卡尚未設定完成，請聯繫主辦單位。');
  if (!origin) throw new BookingError('SERVER', '系統網址未設定，請聯繫主辦單位。');
  const ev = await ev0(db);

  const order = await db.transaction(async (tx) => {
    await tx.select({ id: t.event.id }).from(t.event).where(eq(t.event.id, ev.id)).for('update'); // 同一時間只算一筆，不會超賣
    const l = await activeLink(tx, code);
    // 同一條連結重新按付款：舊的付款中訂單先放掉名額（真的付成功了，綠界通知來時仍會補上）
    await tx.update(t.cardOrder).set({ reserveUntil: now }).where(and(eq(t.cardOrder.cardLinkId, l.id), eq(t.cardOrder.status, 'pending')));
    const combos = (await loadCombos(tx, ev.id)).filter((c) => l.comboIds.includes(c.id) && c.floor === '2M' && c.active && !c.isSingle);
    const left = await stock2M(tx, ev.id, now);
    const items: t.PreorderItem[] = [];
    const seen = new Set<number>();
    for (const it of v.items) {
      if (seen.has(it.id)) throw new BookingError('INVALID', '購買內容重複');
      seen.add(it.id);
      const c = combos.find((x) => x.id === it.id);
      if (!c) throw new BookingError('COMBO', '此方案目前未開放。');
      if ((left[c.id] ?? 0) < it.qty) throw new BookingError('SEAT_TAKEN', `「${c.name}」目前只剩 ${left[c.id] ?? 0} 組，請調整數量。`);
      items.push({ kind: 'combo', id: c.id, name: c.name, price: c.price, qty: it.qty });
    }
    const want = items.reduce((a, i) => a + i.qty, 0);
    if (l.maxSets > 0) {
      const room = l.maxSets - await boughtSets(tx, l.id, now);
      if (want > room) throw new BookingError('QUOTA', room > 0 ? `這條連結還可以買 ${room} 組。` : '這條連結可購買的組數已用完。');
    }
    const amount = items.reduce((a, x) => a + x.price * x.qty, 0);
    if (amount <= 0) throw new BookingError('INVALID', '金額不正確');
    const [o] = await tx.insert(t.cardOrder).values({
      eventId: ev.id, tradeNo: tradeNoOf('2M', now), token: randomBytes(18).toString('base64url'), env: cfg.mode, items, amount,
      name: v.name, phone: v.phone, email: v.email, invType: v.invType, invCode: v.invCode, invTitle: v.invTitle,
      reserveUntil: new Date(now.getTime() + RESERVE_MIN * 60_000), createdAt: now, floor: '2M', cardLinkId: l.id, terms: policyText(l, ev.showAt),
    }).returning();
    await tx.insert(t.auditLog).values({ actor: 'buyer', action: 'card_create', target: `card:${o.id}`, detail: JSON.stringify({ tradeNo: o.tradeNo, amount, link: l.id }) });
    return o;
  });
  return gatewayForm(cfg, order, origin, now);
}
