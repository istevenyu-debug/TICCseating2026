import { getDb } from '@/db/client';
import { BookingError, holdSeats } from '@/lib/booking';
import { handle, readJson } from '@/lib/api';
import { holdInput } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = holdInput.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '請先勾選座位與票種');
    return holdSeats(await getDb(), params.code, p.data.seatIds, p.data.comboId);
  });
}
