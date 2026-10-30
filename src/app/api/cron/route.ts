import { getDb } from '@/db/client';
import { mailDaily } from '@/lib/backup';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/**
 * 雲端排程（Cloud Scheduler 每 5 分鐘呼叫一次）：補寄通知（含招待排程寄出）、每天寄一份備份到寄件信箱。
 * 網址要帶 ?key=（環境變數 CRON_KEY），避免外人觸發。
 */
export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!process.env.CRON_KEY || key !== process.env.CRON_KEY) return new Response('forbidden', { status: 403 });
  const db = await getDb();
  await dispatchQueued(db);
  let mailed = 'skip';
  try { await mailDaily(db, new Date()); mailed = 'ok'; } catch (e) { mailed = String((e as Error).message ?? e).slice(0, 120); }
  return Response.json({ ok: true, mailed });
}
