import { getDb } from '@/db/client';
import { originOf } from '@/lib/api';
import { handleGatewayResult } from '@/lib/card';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/** 買方付完款，綠界把瀏覽器送回來（OrderResultURL）：付款成功直接進劃位頁，其他情況到結果頁 */
export async function POST(req: Request) {
  const base = (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');
  const go = (path: string) => new Response(null, { status: 303, headers: { Location: `${base}${path}`, 'Cache-Control': 'no-store' } });
  try {
    const db = await getDb();
    const form = Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]));
    const r = await handleGatewayResult(db, form, 'result');
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    if (r.code) return go(`/t/${r.code}`);
    return go(r.token ? `/3f/r/${r.token}` : '/3f');
  } catch (e) {
    console.error('付款結果處理失敗', e);
    return go('/3f');
  }
}
