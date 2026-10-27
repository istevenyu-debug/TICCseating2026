import { getDb } from '@/db/client';
import { submitOrder } from '@/lib/booking';
import { handle, visitor, readJson } from '@/lib/api';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const r = await submitOrder(db, params.code, await readJson(req), new Date(), visitor(req));
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e)); // 不讓消費者等寄信
    return r;
  });
}
