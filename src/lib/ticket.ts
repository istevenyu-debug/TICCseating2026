/**
 * 入場 QR code 與驗票。
 * QR 內容：TICC|序號|簽章。簽章是用只存在資料庫的密鑰算出來的，偽造或改序號的 QR 會判為無效。
 * 每張票只能入場一次（資料庫唯一索引保證，多個門同時掃也只會成功一次）。
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { ticketData } from './admin';

import { qrSecret, readQr } from './qr';
export { qrSecret, qrValue, readQr } from './qr';

/** 入口建議：單號在左、雙號在右 */
export function sideOf(code: string) {
  const n = parseInt((code.split('-')[1] ?? '').replace(/\D/g, ''), 10);
  return Number.isNaN(n) ? '' : n % 2 ? '左側門' : '右側門';
}

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 依序號找票（只有劃位成功的訂單才有效） */
async function findTicket(db: Db, serial: string) {
  const m = serial.match(/^(.+)-(\d{2,3})$/);
  if (!m) return { ticket: null, order: null };
  const [order] = await db.select().from(t.orders).where(eq(t.orders.orderNo, m[1]));
  if (!order) return { ticket: null, order: null };
  if (order.status !== 'paid') return { ticket: null, order };
  const { tickets } = await ticketData(db, [order.id]);
  return { ticket: tickets.find((x) => x.serial === serial) ?? null, order };
}

/* ---------- 驗票門口 ---------- */

export const DEFAULT_GATES = ['左1', '左2', '左3', '左4', '右1', '右2', '右3', '右4'];

export async function listGates(db: Db) {
  const ev = await currentEvent(db);
  const gates = await db.select().from(t.gate).where(eq(t.gate.eventId, ev.id)).orderBy(t.gate.sort, t.gate.id);
  const counts = await db.select({ g: t.checkin.gateId, n: sql<number>`count(*)::int` }).from(t.checkin)
    .where(eq(t.checkin.eventId, ev.id)).groupBy(t.checkin.gateId);
  return gates.map((g) => ({ id: g.id, name: g.name, token: g.token, active: g.active, count: counts.find((c) => c.g === g.id)?.n ?? 0 }));
}

export async function createGates(db: Db, actor: string, names: string[]) {
  const ev = await currentEvent(db);
  const have = await db.select().from(t.gate).where(eq(t.gate.eventId, ev.id));
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].filter((n) => !have.some((g) => g.name === n));
  if (!clean.length) throw new BookingError('INVALID', '這些門口都已經建立過了');
  for (const [i, name] of clean.entries()) {
    await db.insert(t.gate).values({ eventId: ev.id, name, token: randomBytes(15).toString('base64url'), sort: have.length + i });
  }
  await db.insert(t.auditLog).values({ actor, action: 'gate_create', target: `event:${ev.id}`, detail: JSON.stringify(clean) });
  return { created: clean.length };
}

export async function updateGate(db: Db, actor: string, id: number, v: { active?: boolean; renewToken?: boolean; name?: string }) {
  const set: Partial<typeof t.gate.$inferInsert> = {};
  if (v.active !== undefined) set.active = v.active;
  if (v.name) set.name = v.name.trim();
  if (v.renewToken) set.token = randomBytes(15).toString('base64url');
  await db.update(t.gate).set(set).where(eq(t.gate.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'gate_update', target: `gate:${id}`, detail: JSON.stringify(v) });
}

async function gateByToken(db: Db, token: string) {
  const [g] = await db.select().from(t.gate).where(eq(t.gate.token, token));
  if (!g) throw new BookingError('LINK_NOT_FOUND', '驗票連結不存在，請向主辦方索取正確連結。');
  if (!g.active) throw new BookingError('LINK_DISABLED', '這條驗票連結已停用，請向主辦方索取新連結。');
  return g;
}

async function counts(db: Db, eventId: number, gateId: number) {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'paid')));
  const [{ entered }] = await db.select({ entered: sql<number>`count(*)::int` }).from(t.checkin).where(eq(t.checkin.eventId, eventId));
  const [{ here }] = await db.select({ here: sql<number>`count(*)::int` }).from(t.checkin).where(and(eq(t.checkin.eventId, eventId), eq(t.checkin.gateId, gateId)));
  return { total, entered, here };
}

export async function gateInfo(db: Db, token: string) {
  const g = await gateByToken(db, token);
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, g.eventId));
  return { gate: g.name, event: ev.name, showAt: ev.showAt.toISOString(), ...(await counts(db, ev.id, g.id)) };
}

export type ScanResult =
  | { result: 'ok'; serial: string; label: string; code: string; zoneName: string; side: string; holderName: string; holderId4: string; orderNo: string; manual: boolean }
  | { result: 'used'; serial: string; label: string; holderName: string; at: string; gate: string }
  | { result: 'invalid'; reason: string };

/** 掃描或手動輸入序號入場 */
export async function scan(db: Db, token: string, input: { qr?: string; serial?: string }, now = new Date()): Promise<ScanResult & { total: number; entered: number; here: number }> {
  const g = await gateByToken(db, token);
  const done = async (r: ScanResult) => ({ ...r, ...(await counts(db, g.eventId, g.id)) });
  let serial: string;
  const manual = !input.qr;
  if (input.qr) {
    const q = readQr(await qrSecret(db), input.qr);
    if (!q) return done({ result: 'invalid', reason: /^TICC\|/.test(input.qr.trim()) ? '偽造或已失效的 QR code' : '不是本活動的入場 QR code' });
    serial = q.serial;
  } else {
    serial = (input.serial ?? '').trim().toUpperCase();
    if (!serial) return done({ result: 'invalid', reason: '請輸入序號' });
  }
  const { ticket, order } = await findTicket(db, serial);
  if (!ticket) {
    return done({ result: 'invalid', reason: !order ? '查無此票' : order.status === 'pending' ? '尚未確認劃位，不能入場' : '此訂單已取消，票券無效' });
  }
  const ins = await db.insert(t.checkin).values({
    eventId: g.eventId, serial, orderId: ticket.orderId, seatId: ticket.seatId, gateId: g.id, manual, at: now,
  }).onConflictDoNothing().returning();
  if (!ins.length) {
    const [prev] = await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, g.eventId), eq(t.checkin.serial, serial)));
    const [pg] = prev?.gateId ? await db.select().from(t.gate).where(eq(t.gate.id, prev.gateId)) : [];
    return done({ result: 'used', serial, label: ticket.label, holderName: ticket.holderName, at: prev.at.toISOString(), gate: pg?.name ?? '後台' });
  }
  return done({
    result: 'ok', serial, label: ticket.label, code: ticket.code, zoneName: ticket.zoneName, side: sideOf(ticket.code),
    holderName: ticket.holderName, holderId4: ticket.holderId4, orderNo: ticket.orderNo ?? '', manual,
  });
}

/** 驗票頁搜尋：序號、持票人姓名、購票人姓名或手機 */
export async function searchTickets(db: Db, token: string, q: string) {
  const g = await gateByToken(db, token);
  const k = q.trim();
  if (k.length < 2) return [];
  const hit = await db.selectDistinct({ id: t.orders.id }).from(t.orders)
    .innerJoin(t.orderSeat, eq(t.orderSeat.orderId, t.orders.id))
    .where(and(eq(t.orders.eventId, g.eventId), eq(t.orders.status, 'paid'), or(
      ilike(t.orders.orderNo, `%${k}%`), ilike(t.orders.buyerName, `%${k}%`), ilike(t.orders.buyerPhone, `%${k.replace(/\D/g, '') || k}%`),
      ilike(t.orderSeat.holderName, `%${k}%`),
    ))).limit(10);
  if (!hit.length) return [];
  const { tickets } = await ticketData(db, hit.map((h) => h.id));
  const used = await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, g.eventId), inArray(t.checkin.serial, tickets.map((x) => x.serial))));
  return tickets.slice(0, 30).map((x) => ({ serial: x.serial, label: x.label, holderName: x.holderName, holderId4: x.holderId4, entered: used.find((u) => u.serial === x.serial)?.at.toISOString() ?? null }));
}

/* ---------- 後台 ---------- */

export async function checkinSummary(db: Db) {
  const ev = await currentEvent(db);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  const recent = await db.select({ id: t.checkin.id, serial: t.checkin.serial, at: t.checkin.at, manual: t.checkin.manual, gate: t.gate.name, seatId: t.checkin.seatId, holder: t.orderSeat.holderName })
    .from(t.checkin).leftJoin(t.gate, eq(t.gate.id, t.checkin.gateId))
    .leftJoin(t.orderSeat, and(eq(t.orderSeat.orderId, t.checkin.orderId), eq(t.orderSeat.seatId, t.checkin.seatId)))
    .where(eq(t.checkin.eventId, ev.id)).orderBy(desc(t.checkin.id)).limit(50);
  const [{ entered }] = await db.select({ entered: sql<number>`count(*)::int` }).from(t.checkin).where(eq(t.checkin.eventId, ev.id));
  return { total, entered, recent: recent.map((r) => ({ ...r, at: r.at.toISOString(), gate: r.gate ?? '後台' })) };
}

/** 撤銷入場（誤掃）：這張票可以再掃一次 */
export async function undoCheckin(db: Db, actor: string, id: number) {
  const [c] = await db.delete(t.checkin).where(eq(t.checkin.id, id)).returning();
  if (!c) throw new BookingError('NOT_FOUND', '找不到這筆入場紀錄');
  await db.insert(t.auditLog).values({ actor, action: 'checkin_undo', target: `ticket:${c.serial}`, detail: JSON.stringify(c) });
  return { serial: c.serial };
}
