import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { checkPreorder, confirmPreorder, preorderMenu, submitPreorder } from '@/lib/preorder';

/** 2026-11-26：感恩席開放單買 12,000 一席（公開認購、送書、座位已拆成單人），流程同 10+2 */
let db: Db; let zoneA: number; let single: number;
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123-456', accountName: '主辦' });
  zoneA = (await db.select().from(t.priceZone)).find((z) => z.name === 'A區')!.id;
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
  const g = await A.createGift(db, 'admin'); await A.updateGift(db, 'admin', g.id, { name: '書', unit: '本' });
  const c = await A.createCombo(db, 'admin');
  await A.updateCombo(db, 'admin', c.id, { name: '感恩席單買', price: 12000, items: [{ zoneId: zoneA, qty: 1 }], gifts: [{ giftId: g.id, qty: 1 }] });
  await A.publish(db, 'admin');
  single = c.id;
  // 一組 10 位連座＋其餘已拆成單人
  const a = (await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.zoneId, zoneA), eq(t.eventSeat.status, 'free')))).map((s) => s.seatId);
  await db.update(t.eventSeat).set({ bundle: null }).where(eq(t.eventSeat.eventId, ev.id));
  await db.update(t.eventSeat).set({ bundle: 'G10' }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, a.slice(0, 10))));
});

describe('感恩席單買 12,000', () => {
  it('公開認購 → 入帳 → 劃位連結 → 選 1 席單人座位 → 劃位成功；10 位連座組裡的單席不能選', async () => {
    expect((await preorderMenu(db)).items.find((i) => i.id === single)).toMatchObject({ name: '感恩席單買', hidden: false, status: 'open' });
    await submitPreorder(db, { items: [{ kind: 'combo', id: single, qty: 1 }], name: '林大同', phone: '0912-345-678', email: 'a@example.com', paidAmount: 12000, last5: '54321', agree: true, confirmDup: true, confirmMismatch: true });
    const [po] = await db.select().from(t.preorder);
    expect(po.amount).toBe(12000);
    await checkPreorder(db, 'admin', po.id, { paid: true });
    const { code } = (await confirmPreorder(db, 'admin', po.id)) as { code: string };
    expect((await getBookingState(db, code)).combos.some((c) => c.id === single)).toBe(true);
    const seats = await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.zoneId, zoneA), eq(t.eventSeat.status, 'free')));
    const inGroup = seats.find((s) => s.bundle === 'G10')!.seatId;
    await expect(holdSeats(db, code, [inGroup], single)).rejects.toThrow('整組');
    const one = seats.find((s) => !s.bundle)!.seatId;
    const h = await holdSeats(db, code, [one], single);
    await submitOrder(db, code, { orderId: h.orderId, buyer: { name: '林大同', phone: '0912345678', email: 'a@example.com' }, holders: [{ seatId: one, name: '林大同', id4: 'A123' }], agree: true });
    const [o] = await db.select().from(t.orders).where(eq(t.orders.id, h.orderId));
    expect(o.status).toBe('pending');
    await expect(holdSeats(db, code, [seats.find((s) => !s.bundle && s.seatId !== one)!.seatId], single)).rejects.toThrow();
  });
});
