import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { preorderExists, savePreorderPush } from '@/lib/preorder';
import { getVapid } from '@/lib/push';

export const dynamic = 'force-dynamic';
const tokenOf = (req: Request) => new URL(req.url).searchParams.get('t') ?? '';

/** 取得推播公鑰 */
export async function GET(req: Request) {
  return handle(async () => {
    const db = await getDb();
    await preorderExists(db, tokenOf(req));
    return { publicKey: (await getVapid(db)).publicKey };
  });
}

const body = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
});

/** 儲存這支手機的推播訂閱：主辦方確認收款時，劃位連結直接推到這支手機 */
export async function POST(req: Request) {
  return handle(async () => {
    const p = body.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '推播訂閱資料不正確');
    await savePreorderPush(await getDb(), tokenOf(req), p.data);
    return true;
  });
}
