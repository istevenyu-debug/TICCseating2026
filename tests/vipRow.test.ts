import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { ensureVipRow } from '@/lib/vipRow';
import { seatLabel } from '@/lib/layout';

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
});
const seat = async (id: string) => (await db.select().from(t.venueSeat).where(eq(t.venueSeat.id, id)))[0];
const es = async (id: string) => (await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, id)))[0];

describe('VIP 排 23 席（原輪椅席 H15、H16 → VIP 23、22）', () => {
  it('新建的座位圖：VIP 排 23 席，左端 23、右端 22，票種跟其他 VIP 一樣', async () => {
    const vip = await db.select().from(t.venueSeat).where(and(eq(t.venueSeat.floor, '2M'), eq(t.venueSeat.rowNo, 0)));
    expect(vip).toHaveLength(23);
    expect(await seat('W-H15')).toMatchObject({ seatType: 'vip', rowNo: 0, seatNo: '23', block: 'L1', code: 'V-23-L1', x: 13, y: 1 });
    expect(await seat('W-H16')).toMatchObject({ seatType: 'vip', seatNo: '22', block: 'R1', code: 'V-22-R1', x: 40 });
    expect((await es('W-H15')).zoneId).toBe((await es('V-21')).zoneId);
    expect(seatLabel(await seat('W-H15'))).not.toContain('輪椅');
    expect(await ensureVipRow(db)).toEqual([]); // 已經是新版，不動
  });

  it('舊資料（輪椅席）：啟動時原地改成 VIP；空位跟著旁邊 VIP 的票種與用途；已有訂單的座位只改名稱；再跑一次不動', async () => {
    const [ev] = await db.select().from(t.event);
    const zones = await db.select().from(t.priceZone);
    const wz = zones.find((z) => z.name === '輪椅席')!;
    const closed = (await db.select().from(t.seatUsage).where(eq(t.seatUsage.code, 'closed')))[0];
    // 模擬舊版資料
    await db.update(t.venueSeat).set({ seatType: 'wheelchair', rowNo: null, seatNo: 'H15', section: 'W', code: 'WC-H15-L1' }).where(eq(t.venueSeat.id, 'W-H15'));
    await db.update(t.venueSeat).set({ seatType: 'wheelchair', rowNo: null, seatNo: 'H16', section: 'W', code: 'WC-H16-R1' }).where(eq(t.venueSeat.id, 'W-H16'));
    await db.update(t.eventSeat).set({ zoneId: wz.id, usageId: closed.id }).where(eq(t.eventSeat.seatId, 'W-H15'));
    await db.update(t.eventSeat).set({ zoneId: wz.id, status: 'sold' }).where(eq(t.eventSeat.seatId, 'W-H16'));
    const done = await ensureVipRow(db);
    expect(done).toEqual(['W-H15→VIP 23', 'W-H16→VIP 22']);
    expect(await seat('W-H15')).toMatchObject({ seatType: 'vip', rowNo: 0, seatNo: '23', code: 'V-23-L1' });
    const h15 = await es('W-H15'); const v21 = await es('V-21');
    expect(h15.zoneId).toBe(v21.zoneId);
    expect(h15.usageId).toBe(v21.usageId);
    const h16 = await es('W-H16');
    expect(h16.zoneId).toBe(wz.id); // 已售出的不動票種
    expect(h16.eventId).toBe(ev.id);
    expect(await ensureVipRow(db)).toEqual([]);
    const log = await db.select().from(t.auditLog).where(eq(t.auditLog.action, 'vip_row_22_23'));
    expect(log).toHaveLength(1);
  });
});
