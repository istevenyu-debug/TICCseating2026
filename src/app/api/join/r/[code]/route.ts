import { getDb } from '@/db/client';
import { clientIp, handle, originOf, readJson } from '@/lib/api';
import { deleteOwnReport, reportPage, submitReport } from '@/lib/joinQueue';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const base = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 志工回報頁：團練場、合計、已回報的訂單 */
export async function GET(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => reportPage(await getDb(), params.code));
}

/** 送出一批訂單編號＋張數；或刪除自己團練場的一筆（打錯時） */
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const body = await readJson(req) as { action?: string; orderNo?: string; reporter?: string };
    if (body?.action === 'delete') return deleteOwnReport(db, params.code, String(body.orderNo ?? ''), String(body.reporter ?? ''));
    const r = await submitReport(db, params.code, body, clientIp(req), new Date(), base(req));
    dispatchQueued(db).catch(() => undefined); // 回饋信給負責人，不讓志工等
    return r;
  });
}
