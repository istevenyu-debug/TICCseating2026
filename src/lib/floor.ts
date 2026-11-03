/**
 * 三樓（第 13–27 排）的座位與組合票設定。
 * 啟動時自動補齊（已存在就不動），第 1–12 排的任何資料都不會被碰到。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError, loadCombos } from './booking';
import { buildSeats3F } from './layout';

const FLOOR3 = '3F';
const ZONE_SINGLE = { name: '三樓席', color: '#b9e2f5', price: 3000 };
const ZONE_COMBO = { name: '三樓組合席', color: '#ffd29d', price: 3000 };
const COMBO_SINGLE = '三樓單張';
const COMBO_SET = { name: '三樓買 10 送 1', price: 30000, qty: 11 };

/** 補齊三樓座位、票種、購票方式。已存在的一律不改（後台改過的價格、框好的組合都會留著） */
export async function ensureFloor3(db: Db) {
  const events = await db.select({ id: t.event.id }).from(t.event);
  const seats = buildSeats3F();
  await db.insert(t.venueSeat).values(seats.map((s) => ({
    id: s.id, section: s.section, rowNo: s.rowNo, seatNo: s.seatNo, seatType: s.seatType, block: s.block, code: s.code,
    x: s.x, y: s.y, floor: FLOOR3, entrance: '3F 入口',
  }))).onConflictDoNothing();
  for (const ev of events) {
    await db.transaction(async (tx) => {
      const have = await tx.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), eq(t.priceZone.floor, FLOOR3)));
      let single = have.find((z) => z.name === ZONE_SINGLE.name) ?? have[0];
      if (!have.length) {
        const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${t.priceZone.sort}), 0)::int` }).from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
        const made = await tx.insert(t.priceZone).values([
          { eventId: ev.id, ...ZONE_SINGLE, open: true, sort: max + 1, floor: FLOOR3 },
          { eventId: ev.id, ...ZONE_COMBO, open: true, sort: max + 2, floor: FLOOR3 },
        ]).returning();
        single = made[0];
        const combos = await tx.insert(t.combo).values([
          { eventId: ev.id, name: COMBO_SINGLE, isSingle: true, active: true, sort: 0, floor: FLOOR3 },
          { eventId: ev.id, name: COMBO_SET.name, price: COMBO_SET.price, active: true, autoHolders: true, sort: 1, floor: FLOOR3 },
        ]).returning();
        await tx.insert(t.comboItem).values({ comboId: combos[1].id, zoneId: made[1].id, qty: COMBO_SET.qty });
      }
      const [usage] = await tx.select().from(t.seatUsage).where(and(eq(t.seatUsage.eventId, ev.id), eq(t.seatUsage.sellable, true))).orderBy(t.seatUsage.id).limit(1);
      if (!usage || !single) return;
      await tx.insert(t.eventSeat).values(seats.map((s) => ({ eventId: ev.id, seatId: s.id, zoneId: single.id, usageId: usage.id }))).onConflictDoNothing();
    });
  }
}

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 三樓的組合票與單張票種 */
export async function floor3Plans(db: Db, eventId: number) {
  const combos = (await loadCombos(db, eventId)).filter((c) => c.floor === FLOOR3);
  const zones = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, eventId), eq(t.priceZone.floor, FLOOR3))).orderBy(t.priceZone.sort, t.priceZone.id);
  const set = combos.find((c) => !c.isSingle) ?? null;
  const single = combos.find((c) => c.isSingle) ?? null;
  const comboZone = new Set((combos.filter((c) => !c.isSingle)).flatMap((c) => c.items.map((i) => i.zoneId)));
  return { combos, zones, set, single, comboZone };
}

/** 框一組組合票：選幾席要剛好是一組的人數（預設 11），座位改成組合席並綁在一起，之後買方點一下就選整組 */
export async function frameComboGroup(db: Db, actor: string, seatIds: string[]) {
  const ev = await ev0(db);
  const ids = [...new Set(seatIds)];
  const { set, zones, comboZone } = await floor3Plans(db, ev.id);
  if (!set) throw new BookingError('INVALID', '三樓還沒有組合票');
  const qty = set.items.reduce((a, i) => a + i.qty, 0);
  if (ids.length !== qty) throw new BookingError('INVALID', `一組要剛好 ${qty} 席，現在選了 ${ids.length} 席。`);
  const zoneId = set.items[0]?.zoneId;
  if (!zoneId || !zones.some((z) => z.id === zoneId && comboZone.has(z.id))) throw new BookingError('INVALID', '組合票還沒設定票種');
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: t.eventSeat.seatId, status: t.eventSeat.status, bundle: t.eventSeat.bundle, floor: t.venueSeat.floor, sellable: t.seatUsage.sellable })
      .from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
      .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids))).for('update', { of: t.eventSeat });
    if (rows.length !== ids.length || rows.some((r) => r.floor !== FLOOR3)) throw new BookingError('INVALID', '只能框三樓的座位。');
    if (rows.some((r) => r.status !== 'free')) throw new BookingError('BUSY', '其中有座位已被劃走，不能框進組合。');
    if (rows.some((r) => !r.sellable)) throw new BookingError('BUSY', '其中有保留座位，不能框進組合。');
    if (rows.some((r) => r.bundle)) throw new BookingError('BUSY', '其中有座位已經在別組，請先拆組。');
    const bundle = `c3-${Date.now().toString(36)}-${ids[0]}`;
    await tx.update(t.eventSeat).set({ zoneId, bundle }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
    await tx.insert(t.auditLog).values({ actor, action: 'floor3_frame', target: `event:${ev.id}`, detail: ids.join(',') });
    return { bundle, seats: ids.length };
  });
}

/** 拆組：整組改回單張票種。組內有座位已被劃走時不能拆 */
export async function unframeComboGroup(db: Db, actor: string, seatId: string) {
  const ev = await ev0(db);
  const { zones, comboZone } = await floor3Plans(db, ev.id);
  const singleZone = zones.find((z) => !comboZone.has(z.id));
  if (!singleZone) throw new BookingError('INVALID', '三樓沒有單張票種可以改回');
  return db.transaction(async (tx) => {
    const [me] = await tx.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, seatId)));
    if (!me?.bundle) throw new BookingError('INVALID', '這個座位不在任何一組裡。');
    const group = await tx.select({ id: t.eventSeat.seatId, status: t.eventSeat.status, floor: t.venueSeat.floor }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.bundle, me.bundle)));
    if (group.some((g) => g.floor !== FLOOR3)) throw new BookingError('INVALID', '這裡只能拆三樓的組合。');
    if (group.some((g) => g.status !== 'free')) throw new BookingError('BUSY', '這組已有座位被劃走，不能拆。');
    await tx.update(t.eventSeat).set({ bundle: null, zoneId: singleZone.id }).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.bundle, me.bundle)));
    await tx.insert(t.auditLog).values({ actor, action: 'floor3_unframe', target: `event:${ev.id}`, detail: group.map((g) => g.id).join(',') });
    return { seats: group.length };
  });
}
