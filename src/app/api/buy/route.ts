import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import type { Db } from '@/db/client';
import { clientIp, handle, readJson } from '@/lib/api';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import { dispatchQueued } from '@/lib/notify';
import { clearMenuCache, preorderMenu, preorderMenuShared, submitPreorder } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 已登入後台的人員（代填認購單用）；一般買方回傳 null，不查資料庫 */
const staffOf = (db: Db) => sessionUser(db, cookies().get(SESSION_COOKIE)?.value);

/** 公開訂購頁：可選項目（人多時共用同一份、壓縮後送出） */
export async function GET(req: Request) {
  try {
    const db = await getDb();
    if (await staffOf(db)) { // 人員看得到隱藏方案：不走共用快取
      return new Response(JSON.stringify({ ok: true, data: await preorderMenu(db, { staff: true }) }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const m = await preorderMenuShared(db);
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
    const staff = await staffOf(db);
    const r = await submitPreorder(db, await readJson(req), ip, new Date(), undefined, staff?.displayName ?? '');
    clearMenuCache(); // 名額可能變了：下一位立刻看到最新狀態
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    return r;
  });
}
