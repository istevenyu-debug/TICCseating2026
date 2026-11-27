/**
 * VIP 排兩端的輪椅席 H15、H16 改成 VIP 23（左端）、VIP 22（右端）（使用者 11/27）。
 * 啟動時、還原備份後各跑一次；已經改過的不再動（可重複執行）。
 * - 原地改：座位內部編號（W-H15／W-H16）不變，訂單、QR、入場紀錄、用途都還連著。
 * - 還沒有訂單的：票種、用途改成跟旁邊 VIP 座位（21 號／20 號）一樣，可以直接排人。
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';

const CHANGES = [
  { id: 'W-H15', seatNo: '23', section: 'VL', block: 'L1', code: 'V-23-L1', near: 'V-21' },
  { id: 'W-H16', seatNo: '22', section: 'VR', block: 'R1', code: 'V-22-R1', near: 'V-20' },
] as const;

export async function ensureVipRow(db: Db) {
  const done: string[] = [];
  for (const c of CHANGES) {
    const upd = await db.update(t.venueSeat)
      .set({ seatType: 'vip', rowNo: 0, seatNo: c.seatNo, section: c.section, block: c.block, code: c.code })
      .where(and(eq(t.venueSeat.id, c.id), eq(t.venueSeat.seatType, 'wheelchair')))
      .returning({ id: t.venueSeat.id });
    if (!upd.length) continue;
    const events = await db.select({ id: t.event.id }).from(t.event);
    for (const ev of events) {
      const [near] = await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, c.near)));
      if (!near) continue;
      // 只改還是空位的；已有訂單、暫存的不動
      await db.update(t.eventSeat).set({ zoneId: near.zoneId, usageId: near.usageId })
        .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, c.id), eq(t.eventSeat.status, 'free')));
    }
    done.push(`${c.id}→VIP ${c.seatNo}`);
  }
  if (done.length) await db.insert(t.auditLog).values({ actor: '系統', action: 'vip_row_22_23', target: 'venue_seat', detail: done.join('、') });
  return done;
}
