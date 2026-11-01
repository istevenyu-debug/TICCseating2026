import { getDb } from '@/db/client';
import { clientIp, handle, readJson } from '@/lib/api';
import { dispatchQueued } from '@/lib/notify';
import { clearMenuCache, preorderMenuShared, submitPreorder } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 公開訂購頁：可選項目（人多時共用同一份、壓縮後送出） */
export async function GET(req: Request) {
  try {
    const m = await preorderMenuShared(await getDb());
    const gz = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '');
    return new Response(gz ? new Uint8Array(m.gz) : m.json, { headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}),
    } });
  } catch (e) {
    return handle(async () => { throw e; });
  }
}

/** 送出訂單 */
export async function POST(req: Request) {
  return handle(async () => {
    const db = await getDb();
    const ip = clientIp(req);
    const r = await submitPreorder(db, await readJson(req), ip);
    clearMenuCache(); // 名額可能變了：下一位立刻看到最新狀態
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    return r;
  });
}
