import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { payInfo, payUpdate } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 買方用確認信裡的連結：查看（get）或補填／更正（save）匯款帳號後五碼 */
export async function POST(req: Request) {
  return handle(async () => {
    const p = z.object({ token: z.string().max(60), remits: z.array(z.unknown()).max(5).optional() }).safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    const db = await getDb();
    if (p.data.remits) await payUpdate(db, p.data.token, p.data.remits);
    return payInfo(db, p.data.token);
  });
}
