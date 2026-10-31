import { describe, expect, it } from 'vitest';
import { createPgliteDb } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';

describe('操作紀錄', () => {
  it('改票種會記下是哪幾個座位，首頁看得到', async () => {
    const db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '測試', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '', bankAccount: '', accountName: '' });
    const z = (await db.select().from(t.priceZone))[0];
    await A.assignZoneSeats(db, 'admin', z.id, ['9-8', '10-1']);
    const a = (await A.recentAudit(db))[0];
    expect(a).toMatchObject({ actor: 'admin', action: '改票種' });
    expect(a.what).toContain('第9排');
    expect(a.what).toContain(z.name);
  });
});
