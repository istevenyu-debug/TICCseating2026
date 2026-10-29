import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { holdSeats, submitOrder } from '@/lib/booking';
import { confirmPreorder, listPreorders, submitPreorder } from '@/lib/preorder';
import { createGates, listGates, qrSecret, qrValue, scan } from '@/lib/ticket';
import { resetPreview, resetSales } from '@/lib/reset';

let db: Db;
const T0 = new Date('2026-11-15T10:00:00+08:00');
async function book(code: string, seats: string[]) {
  const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
  const h = await holdSeats(db, code, seats, single, T0);
  await submitOrder(db, code, { orderId: h.orderId, buyer: { name: '甲', phone: '0912345678', email: 'a@b.co' },
    holders: seats.map((s) => ({ seatId: s, name: '甲', id4: 'A123' })), agree: true }, T0);
  await A.confirmPayment(db, 'admin', h.orderId, {}, T0);
  return h.orderId;
}

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await A.publish(db, 'admin');
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
});

describe('清除測試資料', () => {
  it('刪除連結、訂單、劃位、入場紀錄並釋放座位；志工席（席位用途）、票價、分組保留；舊 QR 失效；關閉開賣', async () => {
    // 志工席：用席位用途保留
    const vol = (await db.select().from(t.seatUsage)).find((u) => u.code === 'hold-pr')!;
    await A.setSeatUsage(db, 'admin', vol.id, ['1-1', '1-2']);
    await A.bundleAuto(db, 'admin', { rows: [2], blocks: ['C0'], size: 2, shape: 'row', crossAisle: false, skip: [] });
    // 測試資料：預購單→訂單→連結→劃位→入場
    await submitPreorder(db, { items: [{ kind: 'zone', id: (await db.select().from(t.priceZone))[0].id, qty: 2 }], name: '林', phone: '0912345678', email: 'l@x.co', paidAmount: 6400, last5: '12345', agree: true });
    const [p] = await listPreorders(db);
    const { code } = await confirmPreorder(db, 'admin', p.id);
    await book(code, ['5-1', '5-2']);
    await createGates(db, 'admin', ['左1']);
    const gate = (await listGates(db))[0].token;
    const oldQr = qrValue(await qrSecret(db), 'T1-00001-01');
    expect((await scan(db, gate, { qr: oldQr })).result).toBe('ok');

    const pv = await resetPreview(db);
    expect(pv).toMatchObject({ orders: 1, preorders: 1, checkins: 1, occupied: 2 });
    expect(pv.reserved).toEqual([{ name: '保留：公關', seats: 2 }]);

    const r = await resetSales(db, 'admin', { close: true });
    expect(r).toMatchObject({ links: 1, orders: 1, seats: 2, preorders: 1, kept: 0, closed: true });
    expect(await db.select().from(t.inviteLink)).toHaveLength(0);
    expect(await db.select().from(t.orders)).toHaveLength(0);
    expect(await db.select().from(t.checkin)).toHaveLength(0);
    expect(await db.select().from(t.notification)).toHaveLength(0);
    const seats = await db.select().from(t.eventSeat);
    expect(seats.every((s) => s.status === 'free' && !s.orderId)).toBe(true);
    expect(seats.filter((s) => s.usageId === vol.id).map((s) => s.seatId).sort()).toEqual(['1-1', '1-2']); // 志工席保留
    expect(seats.filter((s) => s.bundle)).toHaveLength(10); // 連座保留
    expect((await listGates(db))).toHaveLength(1); // 驗票門口保留
    const [ev] = await db.select().from(t.event);
    expect(ev).toMatchObject({ preorderOpen: false, saleOpen: false });
    expect(ev.published!.open).toBe(false);
    expect((await scan(db, gate, { qr: oldQr })).result).toBe('invalid'); // 舊 QR 失效
  });

  it('可保留指定連結（例：志工用連結訂的座位）', async () => {
    const vol = await A.createInviteLink(db, 'admin', { name: '志工組', phone: '', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    const test = await A.createInviteLink(db, 'admin', { name: '測試', phone: '', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    await book(vol.code, ['6-1', '6-2', '6-3']);
    await book(test.code, ['7-1']);
    const r = await resetSales(db, 'admin', { keepLinkIds: [vol.id], close: false });
    expect(r).toMatchObject({ links: 1, orders: 1, seats: 1, kept: 1 });
    expect((await db.select().from(t.inviteLink)).map((l) => l.name)).toEqual(['志工組']);
    const sold = (await db.select().from(t.eventSeat)).filter((s) => s.status !== 'free').map((s) => s.seatId).sort();
    expect(sold).toEqual(['6-1', '6-2', '6-3']);
    expect((await db.select().from(t.event))[0].preorderOpen).toBe(true);
  });
});
