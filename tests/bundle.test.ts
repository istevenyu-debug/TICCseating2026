import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { BookingError, getBookingState, holdSeats } from '@/lib/booking';

const T0 = new Date('2026-11-15T10:00:00+08:00');
const EXP = new Date('2026-12-10T23:59:59+08:00');
let db: Db;
let gift: number; let paid: number; let merit: number;

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), vipInstalled: false });
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: EXP });
  // 贈票區＝第 2、3 排；付費票＝A區
  const z = await A.createZone(db, 'admin');
  await A.updateZone(db, 'admin', z.id, { name: '贈票區', price: 0, open: true });
  await A.assignZoneByRule(db, 'admin', z.id, [2, 3], []);
  gift = z.id;
  paid = (await db.select().from(t.priceZone)).find((x) => x.name === 'A區')!.id;
  const c = await A.createCombo(db, 'admin');
  await A.updateCombo(db, 'admin', c.id, { name: '功德組', price: 3200, items: [{ zoneId: paid, qty: 1 }, { zoneId: gift, qty: 2 }], autoHolders: true });
  merit = c.id;
  await A.publish(db, 'admin', T0);
});

const code = (e: unknown) => (e instanceof BookingError ? e.code : String(e));

describe('連座', () => {
  it('第 2、3 排兩位一組：每排 17 組，不跨走道', async () => {
    const r = await A.bundleByRule(db, 'admin', [2, 3], [], 2);
    expect(r).toEqual({ groups: 34, perRow: { 2: 17, 3: 17 }, leftovers: [] });
    const s = await getBookingState(db, 'AAA111', T0);
    const row2 = s.seats.filter((x) => x.label.startsWith('第2排'));
    const groups = new Map<string, string[]>();
    row2.forEach((x) => groups.set(x.bundle!, [...(groups.get(x.bundle!) ?? []), x.code]));
    expect(groups.size).toBe(17);
    for (const g of groups.values()) {
      expect(g).toHaveLength(2);
      expect(new Set(g.map((c) => c.split('-')[2])).size).toBe(1); // 同一區塊
    }
  });

  it('只選連座的其中一位不能暫存；整組可以；功德組＝付費 1 張＋贈票 1 組', async () => {
    await A.bundleByRule(db, 'admin', [2, 3], [], 2);
    const s = await getBookingState(db, 'AAA111', T0);
    const g = s.seats.find((x) => x.bundle && x.label.startsWith('第2排'))!;
    const pair = s.seats.filter((x) => x.bundle === g.bundle).map((x) => x.id);
    const a = s.seats.find((x) => x.zoneId === paid && x.status === 'free')!.id;
    await expect(holdSeats(db, 'AAA111', [a, pair[0]], merit, T0).catch((e) => { throw new Error(code(e)); })).rejects.toThrow('BUNDLE');
    const h = await holdSeats(db, 'AAA111', [a, ...pair], merit, T0);
    expect(h.amount).toBe(3200);
  });

  it('取消連座後回到單人選位；有訂單的排不能改連座', async () => {
    await A.bundleByRule(db, 'admin', [2, 3], [], 2);
    expect(await A.unbundleByRule(db, 'admin', [3], [])).toEqual({ cleared: 17 });
    const s = await getBookingState(db, 'AAA111', T0);
    expect(s.seats.filter((x) => x.label.startsWith('第3排') && x.bundle)).toHaveLength(0);
    expect(s.seats.filter((x) => x.label.startsWith('第2排') && x.bundle)).toHaveLength(34);
    const pair = s.seats.filter((x) => x.label.startsWith('第2排') && x.bundle).slice(0, 2).map((x) => x.id);
    const a = s.seats.find((x) => x.zoneId === paid && x.status === 'free')!.id;
    await holdSeats(db, 'AAA111', [a, ...pair], merit, T0);
    await expect(A.bundleByRule(db, 'admin', [2], [], 2)).rejects.toThrow('已有訂單');
  });

  it('三位一組：12 席的區塊剛好 4 組，10 席的中區 3 組剩 1 席', async () => {
    const r = await A.bundleByRule(db, 'admin', [2], [], 3);
    expect(r.groups).toBe(4 + 3 + 4);
    expect(r.leftovers).toHaveLength(1);
    const [e] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, r.leftovers.length ? (await db.select().from(t.venueSeat)).find((v) => `第2排 ${v.seatNo}號` === r.leftovers[0])!.id : ''));
    expect(e.bundle).toBeNull();
  });
});

describe('贈票（票價 0）', () => {
  it('贈票區座位不能用單張購票訂；功德組可以', async () => {
    const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
    const s = await getBookingState(db, 'AAA111', T0);
    const g = s.seats.find((x) => x.zoneId === gift && x.status === 'free')!.id;
    await expect(holdSeats(db, 'AAA111', [g], single, T0)).rejects.toThrow('只能以組合票');
  });
  it('票價 0 的票種若沒有開放的組合票包含它，不能發布', async () => {
    await A.updateCombo(db, 'admin', merit, { active: false });
    await expect(A.publish(db, 'admin', T0)).rejects.toThrow('沒有開放的組合票包含它');
  });
});
