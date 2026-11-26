import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { applyUpgrade, upgradeView } from '@/lib/upgrade';
import { BookingError } from '@/lib/booking';

export const dynamic = 'force-dynamic';

/** 免費升等：買方看座位圖 */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  return handle(async () => upgradeView(await getDb(), params.token));
}

const body = z.object({ seatIds: z.array(z.string().max(40)).min(1).max(40) });
/** 免費升等：買方確認新座位 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const p = body.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '請選座位');
    return applyUpgrade(await getDb(), params.token, p.data.seatIds);
  });
}
