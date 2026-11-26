/**
 * 公益劃位專屬連結（2026-11-27）：一個單位一條 /g/<code>。
 * - 後台（十一）建立：單位、負責人姓名、Email、席數 N、類別（預設公益）、截止時間。
 * - 座位池：「一、席位用途」塗成「保留：公益」（hold-charity）的空位；所有連結共用，先選先得。
 * - 負責人選 N 席、每席填姓名職稱 → 建立一筆 VIP／公益（單位、持票人＝姓名職稱），QR 立即寄到後台填的 Email。
 * - 截止前同一條連結可以改姓名（不重寄；QR 不變）；換座位請主辦在清單裡「改座位」。
 */
import { randomInt } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError, type ViewSeatStatus } from './booking';
import { seatLabel } from './layout';
import { createVip } from './vip';
import { seatText } from './vipImport';

const KEY = 'charity.';
export const CHARITY_USAGE = 'hold-charity';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export type Charity = {
  code: string; org: string; name: string; email: string; n: number; cat: string; deadline: string;
  status: 'open' | 'done' | 'cancelled'; createdAt: string; by: string; orderId?: number; orderNo?: string; doneAt?: string;
};

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
/** 確保有「保留：公益」用途（後台塗座位用） */
export async function charityUsage(db: Db, eventId: number) {
  const [u] = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.eventId, eventId), eq(t.seatUsage.code, CHARITY_USAGE)));
  if (u) return u.id;
  const [n] = await db.insert(t.seatUsage).values({ eventId, code: CHARITY_USAGE, name: '保留：公益', sellable: false }).returning();
  return n.id;
}
async function save(db: Db, c: Charity) {
  const value = JSON.stringify(c);
  await db.insert(t.appSetting).values({ key: KEY + c.code, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
}
async function get(db: Db, code: string) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY + code.toUpperCase()));
  if (!r) throw new BookingError('LINK_NOT_FOUND', '連結不存在，請向主辦方確認。');
  return JSON.parse(r.value) as Charity;
}

/** 後台清單（含池子剩幾席） */
export async function listCharity(db: Db) {
  const ev = await ev0(db);
  const uid = await charityUsage(db, ev.id);
  const rows = await db.select().from(t.appSetting).where(like(t.appSetting.key, `${KEY}%`));
  const links = rows.map((r) => { try { return JSON.parse(r.value) as Charity; } catch { return null; } }).filter((x): x is Charity => !!x)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pool = await db.select({ id: t.eventSeat.seatId }).from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.usageId, uid), eq(t.eventSeat.status, 'free')));
  const owed = links.filter((l) => l.status === 'open').reduce((a, l) => a + l.n, 0);
  return { links, pool: pool.length, owed };
}

export async function createCharity(db: Db, actor: string, v: { org: string; name: string; email: string; n: number; cat?: string; deadline: string }, now = new Date()) {
  const ev = await ev0(db);
  await charityUsage(db, ev.id);
  const org = v.org.trim(), name = v.name.trim(), email = v.email.trim(), cat = (v.cat ?? '').trim() || '公益';
  if (!org) throw new BookingError('INVALID', '請填單位');
  if (!name) throw new BookingError('INVALID', '請填負責人姓名');
  if (!EMAIL.test(email)) throw new BookingError('INVALID', 'Email 格式不正確（QR 會寄到這裡）');
  if (!Number.isInteger(v.n) || v.n < 1 || v.n > 60) throw new BookingError('INVALID', '席數請填 1–60');
  if (cat === 'VIP') throw new BookingError('INVALID', 'VIP 不寄 QR，不適用劃位連結，請在座位圖直接安排。');
  const deadline = new Date(/T/.test(v.deadline) ? v.deadline : `${v.deadline}T23:59:59+08:00`);
  if (Number.isNaN(deadline.getTime())) throw new BookingError('INVALID', '截止日期格式不正確');
  if (deadline <= now) throw new BookingError('INVALID', '截止時間已經過了');
  let code = '';
  for (let i = 0; i < 8 && !code; i++) {
    const c = Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const [ex] = await db.select({ k: t.appSetting.key }).from(t.appSetting).where(eq(t.appSetting.key, KEY + c));
    if (!ex) code = c;
  }
  const c: Charity = { code, org, name, email, n: v.n, cat, deadline: deadline.toISOString(), status: 'open', createdAt: now.toISOString(), by: actor };
  await save(db, c);
  await db.insert(t.auditLog).values({ actor, action: 'charity_create', target: `charity:${code}`, detail: JSON.stringify({ org, name, email, n: v.n, cat, deadline: c.deadline }) });
  return c;
}

export async function cancelCharity(db: Db, actor: string, code: string) {
  const c = await get(db, code);
  if (c.status !== 'open') throw new BookingError('INVALID', c.status === 'done' ? '負責人已選好座位；要取消請在清單裡取消那一筆。' : '已經取消了');
  await save(db, { ...c, status: 'cancelled' });
  await db.insert(t.auditLog).values({ actor, action: 'charity_cancel', target: `charity:${code}`, detail: c.org });
  return { ok: true };
}

/** 負責人頁：座位圖（可選＝保留：公益的空位）、已選的座位與姓名 */
export async function charityView(db: Db, code: string, now = new Date()) {
  const c = await get(db, code);
  if (c.status === 'cancelled') throw new BookingError('LINK_NOT_FOUND', '這條連結已停用，請向主辦方確認。');
  const ev = await ev0(db);
  const uid = await charityUsage(db, ev.id);
  const zones = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), eq(t.priceZone.floor, '2M')));
  const rows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, code: t.venueSeat.code, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    zoneId: t.eventSeat.zoneId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, usageId: t.eventSeat.usageId,
  }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '2M')));
  let mine: { seatId: string; label: string; name: string }[] = [];
  if (c.orderId) {
    const [o] = await db.select({ status: t.orders.status }).from(t.orders).where(eq(t.orders.id, c.orderId));
    if (o?.status === 'paid') {
      const hs = await db.select({ seatId: t.orderSeat.seatId, name: t.orderSeat.holderName, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, y: t.venueSeat.y, x: t.venueSeat.x })
        .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(eq(t.orderSeat.orderId, c.orderId));
      mine = hs.sort((a, b) => a.y - b.y || a.x - b.x).map((h) => ({ seatId: h.seatId, label: seatText(h), name: h.name ?? '' }));
    }
  }
  const mineIds = new Set(mine.map((m) => m.seatId));
  const seats = rows.filter((s) => s.seatType !== 'vip' || ev.vipInstalled).map((s) => ({
    id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, code: s.code, label: seatLabel(s), zoneId: s.zoneId, bundle: null as string | null,
    status: (mineIds.has(s.id) ? 'mine' : s.status === 'free' && s.usageId === uid ? 'free' : s.status !== 'free' ? 'sold' : 'blocked') as ViewSeatStatus,
  }));
  const [user, dom] = c.email.split('@');
  return {
    event: ev.name, showAt: ev.showAt.toISOString(), vipInstalled: ev.vipInstalled, org: c.org, name: c.name, n: c.n, cat: c.cat,
    email: `${user.slice(0, 2)}***@${dom}`, deadline: c.deadline, closed: new Date(c.deadline) <= now, done: c.status === 'done' && mine.length > 0, orderNo: c.orderNo ?? '',
    mine, free: seats.filter((s) => s.status === 'free').length,
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, gift: z.price === 0 })), seats,
  };
}

/** 負責人送出：選的座位要都在「保留：公益」池、席數剛好 N、每席都有姓名職稱 */
export async function submitCharity(db: Db, code: string, v: { seatIds: string[]; names: string[] }, base?: string, now = new Date()) {
  const c = await get(db, code);
  if (c.status === 'cancelled') throw new BookingError('LINK_NOT_FOUND', '這條連結已停用，請向主辦方確認。');
  if (c.status === 'done') throw new BookingError('INVALID', '已經送出過了。要改姓名請在下方修改；要換座位請聯絡主辦方。');
  if (new Date(c.deadline) <= now) throw new BookingError('INVALID', '已過截止時間，請聯絡主辦方。');
  const ids = [...new Set(v.seatIds)];
  if (ids.length !== c.n || v.names.length !== v.seatIds.length) throw new BookingError('INVALID', `請選 ${c.n} 席`);
  const names = v.names.map((x) => x.trim().replace(/\s+/g, ' ').slice(0, 60));
  if (names.some((x) => !x)) throw new BookingError('INVALID', '每一席都要填姓名職稱');
  const ev = await ev0(db);
  const uid = await charityUsage(db, ev.id);
  const es = await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
  if (es.length !== ids.length || es.some((s) => s.usageId !== uid)) throw new BookingError('INVALID', '有座位不在可選的範圍，請重新選。');
  const taken = es.filter((s) => s.status !== 'free');
  if (taken.length) throw new BookingError('SEAT_TAKEN', `${taken.length} 席剛被選走，請重新選。`, taken.map((s) => s.seatId));
  const r = await createVip(db, `公益連結:${c.code}`, {
    name: c.name, phone: '', email: c.email, seatIds: v.seatIds, holders: names, mode: 'now', cat: c.cat, org: c.org, referrer: '', note: `公益連結 ${c.code}`,
  }, base);
  await save(db, { ...c, status: 'done', orderId: r.orderId, orderNo: r.orderNo ?? '', doneAt: now.toISOString() });
  return { orderNo: r.orderNo };
}

/** 截止前改姓名（不重寄；QR 不變，入場時顯示新名字） */
export async function renameCharity(db: Db, code: string, names: { seatId: string; name: string }[], now = new Date()) {
  const c = await get(db, code);
  if (c.status !== 'done' || !c.orderId) throw new BookingError('INVALID', '還沒選座位');
  if (new Date(c.deadline) <= now) throw new BookingError('INVALID', '已過截止時間，要改姓名請聯絡主辦方。');
  const [o] = await db.select().from(t.orders).where(eq(t.orders.id, c.orderId));
  if (!o || o.status !== 'paid') throw new BookingError('INVALID', '這筆已取消，請聯絡主辦方。');
  const hs = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, c.orderId));
  const changed: string[] = [];
  for (const x of names) {
    const h = hs.find((y) => y.seatId === x.seatId);
    const name = x.name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!h) throw new BookingError('INVALID', '座位不屬於這個單位');
    if (!name) throw new BookingError('INVALID', '姓名職稱不能空白');
    if (name !== h.holderName) {
      await db.update(t.orderSeat).set({ holderName: name }).where(and(eq(t.orderSeat.orderId, c.orderId), eq(t.orderSeat.seatId, x.seatId)));
      changed.push(`${x.seatId}:${h.holderName}→${name}`);
    }
  }
  if (changed.length) await db.insert(t.auditLog).values({ actor: `公益連結:${c.code}`, action: 'charity_rename', target: `order:${c.orderId}`, detail: JSON.stringify(changed) });
  return { changed: changed.length };
}
