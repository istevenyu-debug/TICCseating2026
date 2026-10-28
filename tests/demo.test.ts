import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@/db/client';
import { createEvent, createLink, PLACEHOLDER_EVENT_NAME, removeDemoData, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { holdSeats, submitOrder } from '@/lib/booking';

const T0 = new Date('2026-11-15T10:00:00+08:00');
const EXP = new Date('2026-12-10T23:59:59+08:00');

describe('移除舊版示範資料', () => {
  it('只刪 DEMO26、DEMO27 與其訂單通知；使用者的連結、訂單、票價都保留', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    // 舊版示範資料
    const ev = await createEvent(db, { name: '2026 冬季音樂會（示範）', showAt: new Date('2026-12-20T19:30:00+08:00'),
      bankName: '範例銀行（代碼 000）', bankAccount: '000-00-0000000', accountName: '範例主辦單位' });
    await createLink(db, { eventId: ev.id, code: 'DEMO26', name: '測試購票人', phone: '0900000000', quota: 6, expiresAt: EXP });
    await createLink(db, { eventId: ev.id, code: 'DEMO27', name: '第二位測試者', phone: '0900000001', quota: 4, expiresAt: EXP });
    // 使用者自己的資料
    const mine = await A.createInviteLink(db, 'admin', { name: '77777', phone: '0912345678', quota: 21, expiresAt: EXP });
    const [zB] = await db.select().from(t.priceZone).where(eq(t.priceZone.name, 'B區'));
    await A.updateZone(db, 'admin', zB.id, { price: 999 });
    const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
    const body = (orderId: number, seat: string, amount: number) => ({ orderId, buyer: { name: '王', phone: '0912345678', email: 'a@b.co' },
      holders: [{ seatId: seat, name: '王', id4: 'A123' }], agree: true });
    const hd = await holdSeats(db, 'DEMO26', ['3-1'], single, T0); await submitOrder(db, 'DEMO26', body(hd.orderId, '3-1', hd.amount), T0);
    const hm = await holdSeats(db, mine.code, ['3-2'], single, T0); await submitOrder(db, mine.code, body(hm.orderId, '3-2', hm.amount), T0);
    // 一個同代碼但不是示範內容的連結不能刪（例如使用者自己取名 DEMO27 以外的狀況）
    const r = await removeDemoData(db);
    expect(r).toEqual({ links: ['DEMO26', 'DEMO27'], orders: 1, renamed: true, bankCleared: true });

    const links = (await db.select().from(t.inviteLink)).map((l) => l.name);
    expect(links).toEqual(['77777']);
    const orders = await db.select().from(t.orders);
    expect(orders.map((o) => o.id)).toEqual([hm.orderId]);
    const seats = Object.fromEntries((await db.select().from(t.eventSeat)).map((s) => [s.seatId, s.status]));
    expect(seats['3-1']).toBe('free');
    expect(seats['3-2']).toBe('pending');
    expect((await db.select().from(t.notification)).every((n) => n.orderId === hm.orderId || n.linkId === mine.id)).toBe(true);
    expect((await db.select().from(t.priceZone).where(eq(t.priceZone.id, zB.id)))[0].price).toBe(999);
    const [e2] = await db.select().from(t.event);
    expect(e2).toMatchObject({ name: PLACEHOLDER_EVENT_NAME, bankName: '', bankAccount: '', accountName: '' });

    // 再跑一次不會再動任何東西
    expect(await removeDemoData(db)).toEqual({ links: [], orders: 0, renamed: false, bankCleared: false });
  });

  it('使用者已改過場次名稱與帳戶：不會被清掉', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '77777 祈福法會', showAt: new Date(), bankName: '台灣銀行（004）', bankAccount: '123-456', accountName: '主辦單位' });
    expect(await removeDemoData(db)).toEqual({ links: [], orders: 0, renamed: false, bankCleared: false });
    const [e] = await db.select().from(t.event);
    expect(e).toMatchObject({ name: '77777 祈福法會', bankAccount: '123-456' });
  });
});
