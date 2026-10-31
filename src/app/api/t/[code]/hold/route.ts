import { getDb } from '@/db/client';
import { BookingError, holdSeats } from '@/lib/booking';
import { handle, visitor, readJson } from '@/lib/api';
import { holdInput } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = holdInput.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '請先勾選座位與票種');
    const { amount: _a, ...r } = await holdSeats(await getDb(), params.code, p.data.seatIds, p.data.comboId, new Date(), visitor(req));
    void _a; return r; // 買方看不到金額
  });
}
