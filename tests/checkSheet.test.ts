import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { createInviteLink } from '@/lib/admin';
import { ensureFloor3 } from '@/lib/floor';
import { checkSheets } from '@/lib/checkSheet';

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
});

describe('驗票打勾圖', () => {
  it('8 張（1–3 排、4–12 排五區、三樓極左、極右）；只有已付款訂單的座位有 ☐，已入場 ✓；同一買方相鄰座位同一組', async () => {
    const [ev] = await db.select().from(t.event);
    await createInviteLink(db, 't', { name: 'x', phone: '0912000000', quota: 9, expiresAt: new Date('2026-12-31') });
    const [link] = await db.select().from(t.inviteLink);
    const [combo] = await db.select().from(t.combo);
    const row = (await db.select().from(t.venueSeat).where(and(eq(t.venueSeat.block, 'L1'), eq(t.venueSeat.rowNo, 5)))).sort((a, b) => a.x - b.x).slice(0, 10);
    const [o] = await db.insert(t.orders).values({ orderNo: 'A0001', eventId: ev.id, linkId: link.id, comboId: combo.id, status: 'paid', amount: 0, buyerName: '王大明' }).returning();
    const [o2] = await db.insert(t.orders).values({ orderNo: 'A0002', eventId: ev.id, linkId: link.id, comboId: combo.id, status: 'pending', amount: 0, buyerName: '未付款' }).returning();
    for (const s of row) await db.insert(t.orderSeat).values({ orderId: o.id, seatId: s.id, unitPrice: 0 });
    const other = (await db.select().from(t.venueSeat).where(and(eq(t.venueSeat.block, 'L1'), eq(t.venueSeat.rowNo, 6))))[0];
    await db.insert(t.orderSeat).values({ orderId: o2.id, seatId: other.id, unitPrice: 0 });
    await db.insert(t.checkin).values({ eventId: ev.id, serial: 'A0001-01', orderId: o.id, seatId: row[0].id });
    const { sheets } = await checkSheets(db);
    expect(sheets.map((s) => s.key)).toEqual(['2m-1', '2m-L2', '2m-L1', '2m-C0', '2m-R1', '2m-R2', '3f-L2', '3f-R2']);
    const l1 = sheets.find((s) => s.key === '2m-L1')!;
    expect(l1.qr).toBe(10);
    expect(l1.entered).toBe(1);
    const mine = l1.seats.filter((s) => s.kind === 'qr');
    expect(new Set(mine.map((s) => s.key)).size).toBe(1);
    expect(mine[0].name).toBe('王大明');
    expect(l1.seats.find((s) => s.id === other.id)!.kind).toBe('none'); // 未付款不算
    for (const k of ['3f-L2', '3f-R2']) expect(sheets.find((s) => s.key === k)!.seats.every((s) => s.kind === 'none')).toBe(true);
    const f = sheets.find((s) => s.key === '2m-1')!;
    expect(f.orient).toBe('port');
    expect(new Set(f.seats.map((s) => s.block))).toEqual(new Set(['L1', 'C0', 'R1']));
    expect(sheets.find((s) => s.key === '3f-L2')!.seats.every((s) => s.block === 'L2')).toBe(true);
    expect(sheets.find((s) => s.key === '2m-L1')!.orient).toBe('land');
  });
});
