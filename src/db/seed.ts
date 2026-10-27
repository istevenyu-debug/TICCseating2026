import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import * as t from './schema';
import { buildSeats, defaultZoneCode } from '@/lib/layout';

/** 寫入場館座位模板（已存在則略過） */
export async function seedVenue(db: Db) {
  const rows = buildSeats().map((s) => ({
    id: s.id, section: s.section, rowNo: s.rowNo, seatNo: s.seatNo, seatType: s.seatType,
    block: s.block, code: s.code, x: s.x, y: s.y,
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

/**
 * 建立場次，並依預設值建立票種、用途、購票方式與整份座位庫存，最後發布一次。
 * 預設內容只是起點，主辦方可在後台修改。
 */
export async function createEvent(db: Db, input: CreateEventInput) {
  return db.transaction(async (tx) => {
    const [ev] = await tx.insert(t.event).values({
      name: input.name,
      showAt: input.showAt,
      vipInstalled: input.vipInstalled ?? true,
      saleOpen: input.saleOpen ?? true,
      maxPerOrder: input.maxPerOrder ?? 21,
      holdMinutes: input.holdMinutes ?? 20,
      payHours: input.payHours ?? 48,
      bankName: input.bankName ?? '',
      bankAccount: input.bankAccount ?? '',
      accountName: input.accountName ?? '',
    }).returning();

    const defs = [
      { key: 'A', name: 'A區', color: '#b8ccf3', price: 3200 },
      { key: 'B', name: 'B區', color: '#c4e5cf', price: 2600 },
      { key: 'C', name: 'C區（側區）', color: '#f0dbb1', price: 1800 },
      { key: 'V', name: 'VIP', color: '#e6c3e5', price: 5000 },
      { key: 'W', name: '輪椅席', color: '#bde2ea', price: 1800 },
    ] as const;
    const zones = await tx.insert(t.priceZone)
      .values(defs.map((d, i) => ({ eventId: ev.id, name: d.name, color: d.color, price: d.price, sort: i })))
      .returning();
    const zoneId: Record<string, number> = Object.fromEntries(defs.map((d, i) => [d.key, zones[i].id]));

    const usages = await tx.insert(t.seatUsage).values([
      { eventId: ev.id, code: 'sale', name: '可售', sellable: true },
      { eventId: ev.id, code: 'hold-pr', name: '保留：公關', sellable: false },
      { eventId: ev.id, code: 'hold-sponsor', name: '保留：贊助商', sellable: false },
      { eventId: ev.id, code: 'closed', name: '不開放（設備/視線）', sellable: false },
    ]).returning();

    const combos = await tx.insert(t.combo).values([
      { eventId: ev.id, name: '單張購票', isSingle: true, sort: 0 },
      { eventId: ev.id, name: '雙人套票', price: 6080, limitSets: 40, sort: 1 },
      { eventId: ev.id, name: '買一A送二B', price: 3200, limitSets: 20, sort: 2 },
      { eventId: ev.id, name: '親子四人套票', price: 11520, limitSets: 20, sort: 3 },
    ]).returning();
    await tx.insert(t.comboItem).values([
      { comboId: combos[1].id, zoneId: zoneId.A, qty: 2 },
      { comboId: combos[2].id, zoneId: zoneId.A, qty: 1 },
      { comboId: combos[2].id, zoneId: zoneId.B, qty: 2 },
      { comboId: combos[3].id, zoneId: zoneId.A, qty: 4 },
    ]);

    const saleId = usages.find((u) => u.code === 'sale')!.id;
    await tx.insert(t.eventSeat).values(buildSeats().map((s) => ({
      eventId: ev.id, seatId: s.id, zoneId: zoneId[defaultZoneCode(s)], usageId: saleId,
    })));

    const published: t.Published = {
      open: ev.saleOpen, zoneIds: zones.map((z) => z.id), comboIds: combos.map((c) => c.id), at: new Date().toISOString(),
    };
    const [done] = await tx.update(t.event).set({ published }).where(eq(t.event.id, ev.id)).returning();
    return done;
  });
}

export async function createLink(db: Db, v: {
  eventId: number; code: string; name: string; phone: string; quota: number; expiresAt: Date;
}) {
  const [row] = await db.insert(t.inviteLink).values(v).returning();
  return row;
}

/** 設定某些座位的用途（例如保留席）；已有訂單的座位不變 */
export async function setUsage(db: Db, eventId: number, usageCode: string, seatIds: string[]) {
  const [u] = await db.select().from(t.seatUsage)
    .where(and(eq(t.seatUsage.eventId, eventId), eq(t.seatUsage.code, usageCode)));
  if (!u) throw new Error(`找不到用途 ${usageCode}`);
  await db.update(t.eventSeat).set({ usageId: u.id }).where(and(
    eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free'),
  ));
}
