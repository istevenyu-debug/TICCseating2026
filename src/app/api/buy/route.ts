import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { dispatchQueued } from '@/lib/notify';
import { preorderMenu, submitPreorder } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 公開訂購頁：可選項目與匯款帳戶 */
export async function GET() {
  return handle(async () => preorderMenu(await getDb()));
}

/** 送出訂單 */
export async function POST(req: Request) {
  return handle(async () => {
    const db = await getDb();
    const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? '';
    const r = await submitPreorder(db, await readJson(req), ip);
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    return r;
  });
}
