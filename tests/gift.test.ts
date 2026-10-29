import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as A from '@/lib/admin';
import * as t from '@/db/schema';
import { getBookingState, holdSeats } from '@/lib/booking';
it('贈票區沒勾開放：發布時自動一起開放；舊的發布資料也能劃', async () => {
  const db = await createPgliteDb(); await seedVenue(db);
  await createEvent(db, { name: 'x', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  const zB = (await db.select().from(t.priceZone)).find((z) => z.name === 'B區')!;
  await db.update(t.priceZone).set({ price: 0, open: false }).where(eq(t.priceZone.id, zB.id)); // B 區當贈票、沒勾開放
  const combo = (await db.select().from(t.combo)).find((c) => c.name === '買一A送二B')!;
  const pub = await A.publish(db, 'admin');
  expect(pub.zoneIds).toContain(zB.id);
  // 模擬舊版發布（贈票區不在 zoneIds）
  await db.update(t.event).set({ published: { ...pub, zoneIds: pub.zoneIds.filter((z) => z !== zB.id) } });
  const l = await A.createInviteLink(db, 'admin', { name: '甲', phone: '', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
  const now = new Date('2026-11-15T10:00:00+08:00');
  const st = await getBookingState(db, l.code, now);
  const free = (zid: number) => st.seats.filter((s) => s.zoneId === zid && s.status === 'free' && !s.bundle).map((s) => s.id);
  const zA = st.zones.find((z) => z.name === 'A區')!.id;
  expect(free(zB.id).length).toBeGreaterThan(2);
  await expect(holdSeats(db, l.code, [free(zA)[0], ...free(zB.id).slice(0, 2)], combo.id, now)).resolves.toBeTruthy();
}, 60000);
