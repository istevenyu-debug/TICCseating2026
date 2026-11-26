import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, originOf } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { charityView, renameCharity, submitCharity } from '@/lib/charity';

export const dynamic = 'force-dynamic';

/** 公益劃位：負責人看座位圖與已選的座位 */
export async function GET(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => charityView(await getDb(), params.code));
}

const submit = z.object({ seatIds: z.array(z.string().max(16)).min(1).max(60), names: z.array(z.string().max(80)).min(1).max(60) });
/** 送出選位＋姓名職稱 */
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = submit.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '請選座位並填姓名職稱');
    return submitCharity(await getDb(), params.code, p.data, originOf(req));
  });
}

const rename = z.object({ names: z.array(z.object({ seatId: z.string().max(16), name: z.string().max(80) })).min(1).max(60) });
/** 截止前改姓名 */
export async function PUT(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = rename.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    return renameCharity(await getDb(), params.code, p.data.names);
  });
}
