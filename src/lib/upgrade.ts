/**
 * 免費升等（換座位）：後台選一筆劃位成功的訂單、要換的座位、可以換到的票種與區塊 → 產生升等連結 →
 * 買方自己在座位圖選新座位 → 立即換好。
 * - 持票人、票號（序號）不變：換之前先把這筆訂單每張票的票號固定下來（order_seat.ticket_no），原本的 QR 照樣能用。
 * - 舊座位改成「保留：攝影」（不能賣）；新座位若在連座組裡，整組拆成單人。
 * - 不收錢、不動發票、不寄信（後台可按「重寄 QR code」）。
 * 2026-11-26：感恩席贈席 11 排 35、36、38、40 因攝影器材要用，升等到感恩席中三區（買方自己選，分三筆）。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError, type ViewSeatStatus } from './booking';
import { seatLabel } from './layout';
import { ticketData } from './admin';
import { ticketNumbers } from './ticketNo';

const KEY = 'upgrade.';
export const UPGRADE_BLOCKS = ['L2', 'L1', 'C0', 'R1', 'R2'] as const;
export type Upgrade = {
  token: string; orderId: number; orderNo: string; buyerName: string;
  seatIds: string[]; zoneIds: number[]; blocks: string[];
  status: 'open' | 'done' | 'cancelled'; createdAt: string; by: string;
  doneAt?: string; moves?: { from: string; to: string; fromLabel: string; toLabel: string }[];
};

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
async function save(db: Db, u: Upgrade) {
  const value = JSON.stringify(u);
  await db.insert(t.appSetting).values({ key: KEY + u.token, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
}
export async function listUpgrades(db: Db): Promise<Upgrade[]> {
  const rows = await db.select().from(t.appSetting).where(like(t.appSetting.key, `${KEY}%`));
  return rows.map((r) => { try { return JSON.parse(r.value) as Upgrade; } catch { return null; } })
    .filter((x): x is Upgrade => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function getUpgrade(db: Db, token: string) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY + token));
  if (!r) throw new BookingError('LINK_NOT_FOUND', '升等連結不存在，請向主辦方確認。');
  return JSON.parse(r.value) as Upgrade;
}

async function usageId(db: Db, eventId: number) {
  const [u] = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.eventId, eventId), eq(t.seatUsage.code, 'hold-photo')));
  if (u) return u.id;
  const [n] = await db.insert(t.seatUsage).values({ eventId, code: 'hold-photo', name: '保留：攝影', sellable: false }).returning();
  return n.id;
}

/** 已入場的座位不能換 */
async function enteredSeats(db: Db, eventId: number, orderId: number, seatIds: string[]) {
  const { tickets } = await ticketData(db, [orderId]);
  const serials = tickets.filter((x) => seatIds.includes(x.seatId)).map((x) => x.serial);
  if (!serials.length) return [];
  const ck = await db.select({ serial: t.checkin.serial }).from(t.checkin).where(and(eq(t.checkin.eventId, eventId), inArray(t.checkin.serial, serials)));
  return ck.map((c) => c.serial);
}

/** 後台：建立升等連結 */
export async function createUpgrade(db: Db, actor: string, v: { orderId: number; seatIds: string[]; zoneIds: number[]; blocks: string[] }, now = new Date()) {
  const ev = await ev0(db);
  const [o] = await db.select().from(t.orders).where(and(eq(t.orders.id, v.orderId), eq(t.orders.eventId, ev.id)));
  if (!o || o.status !== 'paid') throw new BookingError('INVALID', '只有劃位成功的訂單可以升等');
  const seatIds = [...new Set(v.seatIds)];
  if (!seatIds.length) throw new BookingError('INVALID', '請勾選要換的座位');
  const mine = await db.select({ seatId: t.orderSeat.seatId }).from(t.orderSeat).where(eq(t.orderSeat.orderId, o.id));
  if (seatIds.some((s) => !mine.find((m) => m.seatId === s))) throw new BookingError('INVALID', '有座位不屬於這筆訂單');
  if (!v.zoneIds.length) throw new BookingError('INVALID', '請選可以換到的票種');
  const blocks = v.blocks.filter((b) => (UPGRADE_BLOCKS as readonly string[]).includes(b));
  if (!blocks.length) throw new BookingError('INVALID', '請選可以換到的區');
  const zs = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), inArray(t.priceZone.id, v.zoneIds)));
  if (zs.length !== new Set(v.zoneIds).size) throw new BookingError('INVALID', '票種不存在');
  if ((await enteredSeats(db, ev.id, o.id, seatIds)).length) throw new BookingError('INVALID', '有座位已經入場，不能換');
  const open = (await listUpgrades(db)).filter((u) => u.status === 'open' && u.orderId === o.id && u.seatIds.some((s) => seatIds.includes(s)));
  if (open.length) throw new BookingError('INVALID', '這幾席已經有升等連結了（還沒選）。要重做請先取消那條。');
  const u: Upgrade = {
    token: randomBytes(12).toString('base64url'), orderId: o.id, orderNo: o.orderNo ?? "", buyerName: o.buyerName ?? '',
    seatIds, zoneIds: [...new Set(v.zoneIds)], blocks, status: 'open', createdAt: now.toISOString(), by: actor,
  };
  await save(db, u);
  await db.insert(t.auditLog).values({ actor, action: 'upgrade_create', target: `order:${o.id}`, detail: JSON.stringify({ token: u.token, seatIds, zoneIds: u.zoneIds, blocks }) });
  return u;
}

export async function cancelUpgrade(db: Db, actor: string, token: string) {
  const u = await getUpgrade(db, token);
  if (u.status !== 'open') throw new BookingError('INVALID', u.status === 'done' ? '買方已經換好了，不能取消' : '已經取消了');
  await save(db, { ...u, status: 'cancelled' });
  await db.insert(t.auditLog).values({ actor, action: 'upgrade_cancel', target: `order:${u.orderId}`, detail: JSON.stringify({ token }) });
  return { ok: true };
}

/** 買方頁：座位圖（可選的＝指定票種＋指定區＋空位＋可賣）與原座位 */
export async function upgradeView(db: Db, token: string) {
  const u = await getUpgrade(db, token);
  const ev = await ev0(db);
  const zones = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), eq(t.priceZone.floor, '2M')));
  const rows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, code: t.venueSeat.code, block: t.venueSeat.block,
    seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, sellable: t.seatUsage.sellable, usage: t.seatUsage.code,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '2M')));
  const ok = (s: (typeof rows)[number]) => s.status === 'free' && s.sellable && u.zoneIds.includes(s.zoneId) && u.blocks.includes(s.block)
    && s.seatType !== 'wheelchair' && !['join-gift', 'era-sold'].includes(s.usage);
  const seats = rows.filter((s) => s.seatType !== 'vip' || ev.vipInstalled).map((s) => ({
    id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), zoneId: s.zoneId, bundle: null as string | null,
    status: (u.seatIds.includes(s.id) && s.orderId === u.orderId ? 'mine' : ok(s) ? 'free' : s.status !== 'free' ? 'sold' : 'blocked') as ViewSeatStatus,
  }));
  const label = (id: string) => { const s = rows.find((r) => r.id === id); return s ? seatLabel(s) : id; };
  return {
    event: ev.name, showAt: ev.showAt.toISOString(), vipInstalled: ev.vipInstalled, status: u.status, buyerName: u.buyerName, orderNo: u.orderNo,
    n: u.seatIds.length, old: u.seatIds.map(label), moves: u.moves ?? [],
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, gift: z.price === 0 })),
    allowedZones: u.zoneIds, allowedNames: zones.filter((z) => u.zoneIds.includes(z.id)).map((z) => z.name),
    seats,
  };
}

/** 買方確認：換到選的新座位（全部一起換，任何一席不行就都不換） */
export async function applyUpgrade(db: Db, token: string, newSeatIds: string[], now = new Date()) {
  const u = await getUpgrade(db, token);
  if (u.status === 'done') throw new BookingError('INVALID', '已經換好了');
  if (u.status !== 'open') throw new BookingError('INVALID', '這條升等連結已取消，請向主辦方確認。');
  const ids = [...new Set(newSeatIds)];
  if (ids.length !== u.seatIds.length) throw new BookingError('INVALID', `請選 ${u.seatIds.length} 席`);
  const ev = await ev0(db);
  if ((await enteredSeats(db, ev.id, u.orderId, u.seatIds)).length) throw new BookingError('INVALID', '有座位已經入場，不能換');
  const photo = await usageId(db, ev.id);
  const moves = await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(eq(t.orders.id, u.orderId)).for('update');
    if (!o || o.status !== 'paid') throw new BookingError('INVALID', '這筆訂單已不是劃位成功，不能換，請向主辦方確認。');
    // 這筆訂單現在的座位（照位置排），先固定票號
    const os = await tx.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId, ticketNo: t.orderSeat.ticketNo, y: t.venueSeat.y, x: t.venueSeat.x })
      .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(eq(t.orderSeat.orderId, o.id));
    os.sort((a, b) => a.y - b.y || a.x - b.x);
    if (u.seatIds.some((s) => !os.find((r) => r.seatId === s))) throw new BookingError('INVALID', '原座位已經變動了，請向主辦方確認。');
    if (ids.some((s) => os.find((r) => r.seatId === s))) throw new BookingError('INVALID', '不能選自己原本的座位');
    const nos = ticketNumbers(os);
    for (const r of os) if (r.ticketNo == null) {
      await tx.update(t.orderSeat).set({ ticketNo: nos.get(`${r.orderId}|${r.seatId}`)! }).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, r.seatId)));
    }
    // 新座位檢查
    const ns = await tx.select({
      seatId: t.eventSeat.seatId, status: t.eventSeat.status, zoneId: t.eventSeat.zoneId, bundle: t.eventSeat.bundle,
      sellable: t.seatUsage.sellable, usage: t.seatUsage.code, block: t.venueSeat.block, floor: t.venueSeat.floor, type: t.venueSeat.seatType,
      rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, y: t.venueSeat.y, x: t.venueSeat.x,
    }).from(t.eventSeat).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId)).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids))).for('update', { of: t.eventSeat });
    if (ns.length !== ids.length) throw new BookingError('INVALID', '有座位不存在');
    const bad = ns.filter((s) => s.floor !== '2M' || s.type === 'wheelchair' || !u.zoneIds.includes(s.zoneId) || !u.blocks.includes(s.block) || !s.sellable || ['join-gift', 'era-sold'].includes(s.usage));
    if (bad.length) throw new BookingError('INVALID', '有座位不在可以換的範圍，請重新選。');
    const taken = ns.filter((s) => s.status !== 'free');
    if (taken.length) throw new BookingError('SEAT_TAKEN', `${taken.length} 席剛被訂走，請重新選。`, taken.map((s) => s.seatId));
    // 舊→新：舊座位照票號、新座位照位置一一對應
    const olds = os.filter((r) => u.seatIds.includes(r.seatId)).sort((a, b) => nos.get(`${a.orderId}|${a.seatId}`)! - nos.get(`${b.orderId}|${b.seatId}`)!);
    const news = [...ns].sort((a, b) => a.y - b.y || a.x - b.x);
    const bundles = [...new Set(news.map((s) => s.bundle).filter((b): b is string => !!b))];
    if (bundles.length) await tx.update(t.eventSeat).set({ bundle: null }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.bundle, bundles)));
    const got = await tx.update(t.eventSeat).set({ status: 'sold', orderId: o.id, holdUntil: null, bundle: null, version: sql`${t.eventSeat.version} + 1` })
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids), eq(t.eventSeat.status, 'free'))).returning({ id: t.eventSeat.seatId });
    if (got.length !== ids.length) throw new BookingError('SEAT_TAKEN', '有座位剛被訂走，請重新選。');
    const oldInfo = await tx.select({ id: t.venueSeat.id, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType })
      .from(t.venueSeat).where(inArray(t.venueSeat.id, olds.map((r) => r.seatId)));
    const out: NonNullable<Upgrade['moves']> = [];
    for (let i = 0; i < olds.length; i++) {
      const from = olds[i].seatId, to = news[i].seatId;
      await tx.update(t.orderSeat).set({ seatId: to }).where(and(eq(t.orderSeat.orderId, o.id), eq(t.orderSeat.seatId, from)));
      const fi = oldInfo.find((x) => x.id === from)!;
      out.push({ from, to, fromLabel: seatLabel(fi), toLabel: seatLabel({ rowNo: news[i].rowNo, seatNo: news[i].seatNo, seatType: news[i].type }) });
    }
    // 舊座位：空出來、改成「保留：攝影」（不能賣）
    await tx.update(t.eventSeat).set({ status: 'free', orderId: null, holdUntil: null, bundle: null, usageId: photo, version: sql`${t.eventSeat.version} + 1` })
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, olds.map((r) => r.seatId))));
    await tx.insert(t.auditLog).values({ actor: `buyer:${o.orderNo}`, action: 'upgrade_done', target: `order:${o.id}`, detail: JSON.stringify({ token, moves: out.map((m) => `${m.fromLabel}→${m.toLabel}`), brokeBundles: bundles.length }) });
    return out;
  });
  await save(db, { ...u, status: 'done', doneAt: now.toISOString(), moves });
  return { moves };
}
