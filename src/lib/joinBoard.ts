/**
 * 揪團即時看板（公開，只顯示群名）：
 *  - 回報動態：每次送出一行，最新置頂；張數、待核對／已核對、取得的劃位序
 *  - 劃位排序：預計（回報期間會變）或已鎖定的號碼
 *  - 劃位現況：正在選位的群、接下來、最近選好的座位、三樓贈席座位圖
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ev0, getJoinSettings } from './join';
import { GIFT_ZONE, deadlineOf, inHours, isLocked, pickSeats, provisionalSlots } from './joinQueue';

const BAD = new Set(['mismatch', 'refunded', 'ambiguous']);

async function names(db: Db, eventId: number) {
  const regs = await db.select({ id: t.joinReg.id, venueId: t.joinReg.venueId, venueText: t.joinReg.venueText }).from(t.joinReg).where(eq(t.joinReg.eventId, eventId));
  const vs = new Map((await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, eventId))).map((v) => [v.id, v.name]));
  return new Map(regs.map((r) => [r.id, r.venueId ? vs.get(r.venueId) ?? r.venueText : r.venueText]));
}

export type FeedLine = { k: string; at: string; group: string; qty: number; orders: number; ok: number; pending: number; bad: number; total: number; nos: number[] };

export async function boardData(db: Db, o: { q?: string; before?: string; tab?: string } = {}, now = new Date()) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  const locked = await isLocked(db, ev.id);
  const nm = await names(db, ev.id);
  const approved = new Set((await db.select({ id: t.joinReg.id }).from(t.joinReg).where(and(eq(t.joinReg.eventId, ev.id), eq(t.joinReg.status, 'approved')))).map((r) => r.id));

  // 劃位序：鎖定後用正式的，之前用預計的
  const slots = locked
    ? (await db.select().from(t.joinSlot).where(and(eq(t.joinSlot.eventId, ev.id), ne(t.joinSlot.status, 'void'))).orderBy(asc(t.joinSlot.no)))
    : [];
  const prov = locked ? [] : await provisionalSlots(db, ev.id, s.perSeat);
  const earned = new Map<string, number[]>();
  for (const x of locked ? slots.map((y) => ({ regId: y.regId, at: y.earnedAt, no: y.no })) : prov) {
    const k = `${x.regId}-${x.at.getTime()}`;
    earned.set(k, [...(earned.get(k) ?? []), x.no]);
  }

  // 回報動態：同一群同一次送出＝一行
  const reps = await db.select().from(t.joinReport).where(eq(t.joinReport.eventId, ev.id)).orderBy(asc(t.joinReport.createdAt), asc(t.joinReport.id));
  const lines: FeedLine[] = [];
  const byKey = new Map<string, FeedLine>();
  const cum = new Map<number, number>();
  for (const r of reps) {
    if (!approved.has(r.regId)) continue;
    const k = `${r.regId}-${r.createdAt.getTime()}`;
    let L = byKey.get(k);
    if (!L) {
      L = { k, at: r.createdAt.toISOString(), group: nm.get(r.regId) ?? '', qty: 0, orders: 0, ok: 0, pending: 0, bad: 0, total: 0, nos: earned.get(k) ?? [] };
      byKey.set(k, L); lines.push(L);
    }
    L.orders++; L.qty += r.qty;
    if (r.status === 'ok') L.ok += r.qty; else if (BAD.has(r.status)) L.bad += r.qty; else L.pending += r.qty;
    if (!BAD.has(r.status)) cum.set(r.regId, (cum.get(r.regId) ?? 0) + r.qty);
    L.total = cum.get(r.regId) ?? 0;
  }
  const q = (o.q ?? '').replace(/\s/g, '').toLowerCase();
  let feed = lines.slice().reverse();
  if (q) feed = feed.filter((x) => x.group.replace(/\s/g, '').toLowerCase().includes(q));
  if (o.before) feed = feed.filter((x) => x.at < o.before!);
  const more = feed.length > 50;
  feed = feed.slice(0, 50);

  const verified = reps.filter((r) => approved.has(r.regId) && r.status === 'ok').reduce((a, r) => a + r.qty, 0);
  const pending = reps.filter((r) => approved.has(r.regId) && r.status === 'pending').reduce((a, r) => a + r.qty, 0);
  const seats = await pickSeats(db, ev.id);
  const label = new Map(seats.map((x) => [x.id, x.label]));
  const gift = seats.filter((x) => x.zoneId === GIFT_ZONE.id);

  const order = locked
    ? slots.map((x) => ({ no: x.no, group: nm.get(x.regId) ?? '', status: x.status, seat: x.seatId ? label.get(x.seatId) ?? '' : '' }))
    : prov.map((x) => ({ no: x.no, group: nm.get(x.regId) ?? '', status: 'provisional', seat: '' }));

  const queue = slots.filter((x) => x.status === 'wait' || x.status === 'turn').sort((a, b) => a.pos - b.pos || a.no - b.no);
  const turn = queue.filter((x) => x.status === 'turn');
  const live = {
    pickOpen: s.pickOpen, paused: s.paused, inHours: inHours(s, now), hourFrom: s.hourFrom, hourTo: s.hourTo,
    current: turn.length ? { nos: turn.map((x) => x.no), group: nm.get(turn[0].regId) ?? '', deadline: deadlineOf(s, turn[0])?.toISOString() ?? null } : null,
    next: queue.filter((x) => x.status === 'wait').slice(0, 5).map((x) => ({ no: x.no, group: nm.get(x.regId) ?? '' })),
    recent: slots.filter((x) => x.status === 'done' && x.pickedAt).sort((a, b) => b.pickedAt!.getTime() - a.pickedAt!.getTime()).slice(0, 10)
      .map((x) => ({ no: x.no, group: nm.get(x.regId) ?? '', seat: x.seatId ? label.get(x.seatId) ?? '' : '', at: x.pickedAt!.toISOString() })),
    done: slots.filter((x) => x.status === 'done').length,
  };

  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, now: now.toISOString(),
    reportOpen: s.reportOpen && !locked, locked, perSeat: s.perSeat, contact: s.contact,
    stats: { groups: approved.size, verified, pending, slots: locked ? slots.length : prov.length, giftSeats: gift.length, giftFree: gift.filter((x) => x.status === 'free').length },
    feed, more, order, live,
    ...(o.tab === 'live' ? { seats, zones: [GIFT_ZONE] } : {}),
  };
}
