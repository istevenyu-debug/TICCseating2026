import { z } from 'zod';
import { getDb } from '@/db/client';
import { BookingError, linkForPush } from '@/lib/booking';
import { handle, readJson, visitor } from '@/lib/api';
import { getVapid, saveSubscription } from '@/lib/push';

export const dynamic = 'force-dynamic';

/** 取得推播公鑰 */
export async function GET(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    await linkForPush(db, params.code, visitor(req));
    return { publicKey: (await getVapid(db)).publicKey };
  });
}

const body = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

/** 儲存這支手機的推播訂閱 */
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const { link, visitorId } = await linkForPush(db, params.code, visitor(req));
    const p = body.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '推播訂閱資料不正確');
    await saveSubscription(db, link.id, visitorId, p.data);
    return true;
  });
}
