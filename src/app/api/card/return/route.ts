import { getDb } from '@/db/client';
import { handleGatewayResult } from '@/lib/card';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const text = (s: string, status = 200) => new Response(s, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/** 綠界主動通知（ReturnURL）：處理成功才回 1|OK；出錯時不回，綠界會在 5–15 分鐘後重送 */
export async function POST(req: Request) {
  try {
    const db = await getDb();
    const form = Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)]));
    const r = await handleGatewayResult(db, form, 'return');
    if (!r.ok) return text('0|CheckMacValue Error');
    dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
    return text('1|OK');
  } catch (e) {
    console.error('綠界通知處理失敗', e);
    return text('0|Error', 500);
  }
}
