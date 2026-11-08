import { beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { cancelPreorder, listPreorders, submitPreorder } from '@/lib/preorder';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb(); await seedVenue(db);
  await createEvent(db, { name: '祈福音樂會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await A.publish(db, 'admin');
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
});

it('取消認購：沒填原因擋下、不寄信；有原因才取消並寫進信與備註', async () => {
  const combo = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
  await submitPreorder(db, { items: [{ kind: 'combo', id: combo, qty: 1 }], name: '林大同', phone: '0912345678', email: 'lin@example.com', paidAmount: 6080, last5: '12345', agree: true, confirmDup: true, confirmMismatch: true });
  const p = (await listPreorders(db))[0];
  const before = (await db.select().from(t.notification)).length;
  await expect(cancelPreorder(db, 'admin', p.id)).rejects.toThrow('請填寫取消原因');
  await expect(cancelPreorder(db, 'admin', p.id, ' 一 ')).rejects.toThrow('請填寫取消原因');
  expect((await db.select().from(t.notification)).length).toBe(before);
  expect((await listPreorders(db))[0].status).toBe('submitted');
  await cancelPreorder(db, 'admin', p.id, '買方要求取消');
  const n = (await db.select().from(t.notification)).filter((x) => x.template === 'preorder_cancelled');
  expect(n[0].content).toContain('（買方要求取消）');
  expect((await listPreorders(db))[0].note).toContain('取消：買方要求取消');
});

it('取消劃位：沒填原因擋下；待確認的通知寫上原因，操作紀錄留原因', async () => {
  const l = await A.createInviteLink(db, 'admin', { name: '王', phone: '0922222222', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
  const st = await getBookingState(db, l.code);
  const combo = st.combos.find((c) => c.name === '雙人套票')!;
  const zone = combo.items[0].zoneId;
  const seats = st.seats.filter((s) => s.zoneId === zone && s.status === 'free' && !s.bundle).slice(0, 2).map((s) => s.id);
  const h = await holdSeats(db, l.code, seats, combo.id);
  await expect(A.cancelOrder(db, 'admin', h.orderId)).rejects.toThrow('請填寫取消原因');
  await submitOrder(db, l.code, { orderId: h.orderId, buyer: { name: '王', phone: '0922-222-222', email: 'w@example.com' }, holders: seats.map((s, i) => ({ seatId: s, name: `持票人${i}`, id4: '12a4' })), agree: true });
  const [o] = await db.select().from(t.orders).where(eq(t.orders.id, h.orderId));
  expect(o.status).toBe('pending');
  await A.cancelOrder(db, 'admin', h.orderId, '座位需調整');
  const log = (await db.select().from(t.auditLog)).filter((x) => x.action === 'cancel_order');
  expect(log[0].detail).toContain('座位需調整');
  const n = (await db.select().from(t.notification)).filter((x) => x.template === 'order_cancelled');
  expect(n.length).toBeGreaterThan(0);
  expect(n.every((x) => x.content.includes('（座位需調整）'))).toBe(true);
});
