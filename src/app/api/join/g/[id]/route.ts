import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { groupDelete, groupFix, groupPage } from '@/lib/joinGroup';

export const dynamic = 'force-dynamic';

/** 某一群的合計與回報紀錄（?d=手機代碼：自己送的才顯示完整、可刪除） */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const d = new URL(req.url).searchParams.get('d') ?? '';
  return handle(async () => groupPage(await getDb(), Number(params.id), d));
}

/** 刪除自己手機送的一筆、補上完整訂單編號 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  return handle(async () => {
    const db = await getDb();
    const b = await readJson(req) as { action?: string; reportId?: number; device?: string; orderNo?: string; reporter?: string };
    if (b?.action === 'delete') return groupDelete(db, Number(params.id), Number(b.reportId), String(b.device ?? ''), String(b.reporter ?? ''));
    if (b?.action === 'fix') return groupFix(db, Number(params.id), Number(b.reportId), String(b.device ?? ''), String(b.orderNo ?? ''), String(b.reporter ?? ''));
    throw new Error('unknown action');
  });
}
