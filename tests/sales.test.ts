import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { ensureFloor3 } from '@/lib/floor';
import { presetFloor3 } from '@/lib/join';
import { uploadEra } from '@/lib/joinQueue';
import { hallKey, salesOverview, setCaps } from '@/lib/sales';
import * as A from '@/lib/admin';
import { createVip } from '@/lib/vip';
import { and, sql } from 'drizzle-orm';

describe('全場銷售總覽（依 TICC 座位圖）', () => {
  it('年代樓層寫法都對得到；6 樓、B 排＝包廂', () => {
    expect(['4F', '4樓', '４樓', '四樓', '5F'].map((f) => hallKey(f, '30'))).toEqual(['4F', '4F', '4F', '4F', '5F']);
    expect([hallKey('6F', 'B31'), hallKey('5F', 'B22'), hallKey('包廂', '1'), hallKey('3樓', '13')]).toEqual(['包廂', '包廂', '包廂', '3F']);
  });
  it('名單沒有包廂票就不列包廂', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00'), vipInstalled: false, holdMinutes: 60 });
    await ensureFloor3(db);
    expect((await salesOverview(db))!.hall.map((h) => h.key)).toEqual(['2M', '3F', '3F側', '4F', '5F']);
  });
  it('2M、3F 中間／兩側、4F、5F、包廂；總席數預設、可改', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00'), vipInstalled: false, holdMinutes: 60 });
    await ensureFloor3(db);
    await presetFloor3(db, '網管', 'side');
    await presetFloor3(db, '網管', 'middle');
    const mid = (await db.select({ id: t.venueSeat.id, block: t.venueSeat.block }).from(t.venueSeat).where(eq(t.venueSeat.floor, '3F'))).filter((s) => !['L2', 'R2'].includes(s.block));
    const tk = (i: number, floor: string, row: string, seat: string, price: number, status: 'sold' | 'refunded' = 'sold') => ({ ticketNo: `T${i}`, orderNo: `O${i}`, floor, row, seat, price, status, soldAt: null });
    const [r0, s0] = mid[0].id.split('-');
    await uploadEra(db, '網管', [{ orderNo: 'O1', qty: 1, status: 'sold' }], new Date(), '', [
      tk(1, '3F', r0, s0, 3000), tk(2, '4樓', '30', '1', 2000), tk(3, '4樓', '30', '2', 1500), tk(4, '5F', '45', '1', 1200, 'refunded'), tk(5, '6F', 'B31', '1', 800),
    ]);
    const s = (await salesOverview(db))!;
    const row = (k: string) => s.hall.find((h) => h.key === k)!;
    expect([row('3F').total, row('3F').sold, row('3F').left]).toEqual([510, 1, 509]);
    expect([row('3F側').total, row('3F側').left]).toEqual([214, 214]);
    expect([row('4F').total, row('4F').sold, row('4F').left, row('4F').prices]).toEqual([748, 2, 746, [{ price: 2000, n: 1 }, { price: 1500, n: 1 }]]);
    expect([row('5F').sold, row('5F').refunded, row('5F').left]).toEqual([0, 1, 686]);
    expect([row('包廂').total, row('包廂').sold]).toEqual([480, 1]);
    expect(s.hallSum.total).toBe(row('2M').total + 510 + 214 + 748 + 686 + 480); // 名單有包廂票才列包廂
    await setCaps(db, '網管', { '4F': 700 });
    expect((await salesOverview(db))!.hall.find((h) => h.key === '4F')!.left).toBe(698);
  });
  it('2M 依組合方案：招待佔掉一組看得出來（34→33 這種）', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    const ev = await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00'), vipInstalled: false, holdMinutes: 60 });
    const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
    const zA = zones.find((z) => z.name === 'A區')!.id, zB = zones.find((z) => z.name === 'B區')!.id;
    const c = await A.createCombo(db, 'admin');
    await A.updateCombo(db, 'admin', c.id, { name: '尊榮席', price: 9000, items: [{ zoneId: zA, qty: 1 }, { zoneId: zB, qty: 2 }] });
    const seatsOf = async (z: number, k: number) => (await db.select({ id: t.eventSeat.seatId }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.zoneId, z), eq(t.eventSeat.status, 'free'), eq(t.venueSeat.seatType, 'normal'), sql`coalesce(${t.eventSeat.bundle}, '') = ''`))).slice(0, k).map((x) => x.id);
    const before = (await salesOverview(db))!.twoM.plans.find((p) => p.name === '尊榮席')!;
    await createVip(db, 'admin', { name: '貴賓', phone: '0912345678', email: 'v@example.com', seatIds: [...await seatsOf(zA, 1), ...await seatsOf(zB, 2)], mode: 'none' as never });
    const after = (await salesOverview(db))!;
    const p = after.twoM.plans.find((x) => x.name === '尊榮席')!;
    expect(p.size).toBe(3);
    expect(p.vip).toBe(1);
    expect(p.left).toBe(before.left - 1);
    expect(after.twoM.vipSeats).toBe(3);
  });
});
