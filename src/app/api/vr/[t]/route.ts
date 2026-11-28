import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { receiptConfirm, receiptView } from '@/lib/vipCard';

export const dynamic = 'force-dynamic';

/** 收件確認頁：打開（GET）只顯示，不算確認；按「我收到了」（POST）才記 */
export async function GET(_req: Request, { params }: { params: { t: string } }) {
  return handle(async () => receiptView(await getDb(), params.t));
}
export async function POST(_req: Request, { params }: { params: { t: string } }) {
  return handle(async () => receiptConfirm(await getDb(), params.t));
}
