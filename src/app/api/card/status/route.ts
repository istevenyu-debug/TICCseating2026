import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { cardStatus } from '@/lib/card';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(async () => {
    const db = await getDb();
    const r = await cardStatus(db, new URL(req.url).searchParams.get('token') ?? '');
    if (r.status === 'paid') dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    return r;
  });
}
