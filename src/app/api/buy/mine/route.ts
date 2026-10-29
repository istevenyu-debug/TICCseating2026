import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { preorderStatus } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 訂購人裝置查自己的訂單進度（用送出時拿到的隨機碼；確認收款後會帶劃位連結） */
export async function POST(req: Request) {
  return handle(async () => {
    const p = z.object({ tokens: z.array(z.string().max(60)).max(20) }).safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    return preorderStatus(await getDb(), p.data.tokens);
  });
}
