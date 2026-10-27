import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import * as t from './schema';
import { buildSeats, defaultZoneCode } from '@/lib/layout';

/** 寫入場館座位模板（已存在則略過） */
export async function seedVenue(db: Db) {
  const rows = buildSeats().map((s) => ({
    id: s.id, section: s.section, rowNo: s.rowNo, seatNo: s.seatNo, seatType: s.seatType, x: s.x, y: s.y,
  }));
  await db.insert(t.venueSeat).values(rows).onConflictDoNothing();
}

export interface CreateEventInput {
  name: string;
  showAt: Date;
  vipInstalled?: boolean;
  saleOpen?: boolean;
  maxPerOrder?: number;
  holdMinutes?: number;
  payHours?: number;
  bankName?: string;
  bankAccount?: string;
  accountName?: string;
}

/** 建立場次，並依預設值建立票區、用途、組合票與整份座位庫存 */
export async function createEvent(db: Db, input: CreateEventInput) {
  return db.transaction(async (tx) => {
    const [ev] = await tx.insert(t.event).values({
      name: input.name,
      showAt: input.showAt,
      vipInstalled: input.vipInstalled ?? false,
      saleOpen: input.saleOpen ?? true,
      maxPerOrder: input.maxPerOrder ?? 6,
      holdMinutes: input.holdMinutes ?? 20,
      payHours: input.payHours ?? 48,
      bankName: input.bankName ?? '',
      bankAccount: input.bankAccount ?? '',
      accountName: input.accountName ?? '',
    }).returning();

    const zones = await tx.insert(t.priceZone).values([
      { eventId: ev.id, code: 'A', name: 'A區', color: '#b8ccf3', price: 3200 },
      { eventId: ev.id, code: 'B', name: 'B區', color: '#c4e5cf', price: 2600 },
      { eventId: ev.id, code: 'C', name: 'C區（側區）', color: '#f0dbb1', price: 1800 },
      { eventId: ev.id, code: 'V', name: 'VIP', color: '#e6c3e5', price: 5000 },
      { eventId: ev.id, code: 'W', name: '輪椅席', color: '#bde2ea', price: 1800 },
    ]).returning();
    const usages = await tx.insert(t.seatUsage).values([
      { eventId: ev.id, code: 'sale', name: '可售', sellable: true },
      { eventId: ev.id, code: 'hold-pr', name: '保留：公關', sellable: false },
      { eventId: ev.id, code: 'hold-sponsor', name: '保留：贊助商', sellable: false },
      { eventId: ev.id, code: 'closed', name: '不開放', sellable: false },
    ]).returning();
    await tx.insert(t.combo).values([
      { eventId: ev.id, code: 'single', name: '單張購票', qty: 0, discountPct: 100, sort: 0 },
      { eventId: ev.id, code: 'pair', name: '雙人套票', qty: 2, discountPct: 95, sameZone: true, limitSets: 40, sort: 1 },
      { eventId: ev.id, code: 'family', name: '親子四人套票', qty: 4, discountPct: 90, sameZone: true, limitSets: 20, sort: 2 },
    ]);

    const zoneId = Object.fromEntries(zones.map((z) => [z.code, z.id]));
    const saleId = usages.find((u) => u.code === 'sale')!.id;
    const seatRows = buildSeats().map((s) => ({
      eventId: ev.id, seatId: s.id, zoneId: zoneId[defaultZoneCode(s)], usageId: saleId,
    }));
    await tx.insert(t.eventSeat).values(seatRows);
    return ev;
  });
}

export async function createLink(db: Db, v: {
  eventId: number; code: string; name: string; phone: string; quota: number; expiresAt: Date;
}) {
  const [row] = await db.insert(t.inviteLink).values(v).returning();
  return row;
}

/** 設定某些座位的用途（例如保留席） */
export async function setUsage(db: Db, eventId: number, usageCode: string, seatIds: string[]) {
  const [u] = await db.select().from(t.seatUsage)
    .where(and(eq(t.seatUsage.eventId, eventId), eq(t.seatUsage.code, usageCode)));
  if (!u) throw new Error(`找不到用途 ${usageCode}`);
  await db.update(t.eventSeat).set({ usageId: u.id }).where(and(
    eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free'),
  ));
}
