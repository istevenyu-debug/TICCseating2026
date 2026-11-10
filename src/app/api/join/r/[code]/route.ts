import { getDb } from '@/db/client';
import { clientIp, handle, originOf, readJson } from '@/lib/api';
import { reportPage, submitReport } from '@/lib/joinQueue';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const base = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 志工回報頁：團練場、合計、已回報的訂單 */
export async function GET(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => reportPage(await getDb(), params.code));
}

/** 送出一批訂單編號＋張數 */
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const r = await submitReport(db, params.code, await readJson(req), clientIp(req), new Date(), base(req));
    dispatchQueued(db).catch(() => undefined); // 回饋信給負責人，不讓志工等
    return r;
  });
}
