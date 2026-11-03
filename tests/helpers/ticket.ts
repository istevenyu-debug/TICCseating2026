import type { Db } from '@/db/client';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { ticketData } from '@/lib/admin';

/** 用序號找票：只有有效的票找得到（與驗票同一規則：訂單必須是 paid） */
export async function findBySerial(db: Db, serial: string) {
  const no = serial.replace(/-\d{2,3}$/, '');
  const [o] = await db.select().from(t.orders).where(eq(t.orders.orderNo, no));
  if (!o || o.status !== 'paid') return null;
  const { tickets } = await ticketData(db, [o.id]);
  return tickets.find((x) => x.serial === serial) ?? null;
}
