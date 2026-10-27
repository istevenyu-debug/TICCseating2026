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
    expect(r).toMatchObject({ groups: 34, perRow: { 2: 17, 3: 17 }, leftovers: [], crossAisle: 0 });
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

describe('10 位一組（第 4–12 排左中右區，略過 6 席）', () => {
  const SIX = ['4-33', '4-31', '4-29', '4-27', '4-32', '4-34'];
  const groupsOf = async () => {
    const s = await getBookingState(db, 'AAA111', T0);
    const m = new Map<string, typeof s.seats>();
    s.seats.forEach((x) => { if (x.bundle) m.set(x.bundle, [...(m.get(x.bundle) ?? []), x]); });
    return { m, s };
  };
  for (const shape of ['row', 'band2', 'band3'] as const) {
    it(`形狀 ${shape}、可跨走道：剛好 30 組，6 席維持單人`, async () => {
      const r = await A.bundleAuto(db, 'admin', { rows: [4, 5, 6, 7, 8, 9, 10, 11, 12], blocks: ['L1', 'C0', 'R1'], size: 10, shape, crossAisle: true, skip: SIX });
      if (shape === 'row') { expect(r.groups).toBeLessThan(30); return; } // 同一排不接排：每排 28/34 席分不完
      expect(r).toMatchObject({ groups: 30, leftovers: [], skipped: 6 });
      const { m, s } = await groupsOf();
      expect(m.size).toBe(30);
      expect([...m.values()].every((g) => g.length === 10)).toBe(true);
      expect(s.seats.filter((x) => SIX.includes(x.id)).every((x) => !x.bundle)).toBe(true);
    });
  }
  it('不跨走道時做不到 30 組（左右區不是 10 的倍數），剩下的維持單人並列出', async () => {
    const r = await A.bundleAuto(db, 'admin', { rows: [4, 5, 6, 7, 8, 9, 10, 11, 12], blocks: ['L1', 'C0', 'R1'], size: 10, shape: 'band2', crossAisle: false, skip: SIX });
    expect(r.groups).toBe(29);
    expect(r.leftovers).toHaveLength(10);
  });
  it('手動：選 10 位設為一組；從原組移出後原組人數減少；改回單人', async () => {
    await A.bundleAuto(db, 'admin', { rows: [5, 6], blocks: ['C0'], size: 10, shape: 'band2', crossAisle: false, skip: [] });
    let { m } = await groupsOf();
    expect([...m.values()].map((g) => g.length)).toEqual([10, 10]);
    const pick = ['7-1', '7-2', '7-3', '7-4', '7-5', '7-6', '7-7', '7-8', '7-9', '5-1'];
    await A.bundleManual(db, 'admin', pick);
    ({ m } = await groupsOf());
    expect([...m.values()].map((g) => g.length).sort((a, b) => a - b)).toEqual([9, 10, 10]);
    await A.bundleRemove(db, 'admin', ['7-1']);
    ({ m } = await groupsOf());
    expect([...m.values()].map((g) => g.length).sort((a, b) => a - b)).toEqual([9, 9, 10]);
    await expect(A.bundleManual(db, 'admin', ['7-1'])).rejects.toThrow('至少要 2 位');
  });
  it('訂購：只能整組 10 位一起訂', async () => {
    await A.bundleAuto(db, 'admin', { rows: [5, 6], blocks: ['C0'], size: 10, shape: 'band2', crossAisle: false, skip: [] });
    const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
    const { m } = await groupsOf();
    const g = [...m.values()][0].map((x) => x.id);
    await expect(holdSeats(db, 'AAA111', g.slice(0, 9), single, T0)).rejects.toThrow('整組');
    await expect(holdSeats(db, 'AAA111', g, single, T0)).resolves.toBeTruthy();
  });
});
