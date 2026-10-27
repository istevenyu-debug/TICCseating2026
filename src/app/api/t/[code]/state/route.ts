import { getDb } from '@/db/client';
import { getBookingState } from '@/lib/booking';
import { handle } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => getBookingState(await getDb(), params.code));
}
