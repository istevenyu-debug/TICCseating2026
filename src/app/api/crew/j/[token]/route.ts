import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { crewFriend, crewSignup, joinInfo } from '@/lib/crew';

export const dynamic = 'force-dynamic';

/** 驗票志工報名頁 */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  return handle(async () => joinInfo(await getDb(), params.token));
}

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('signup'), name: z.string().max(40), email: z.string().max(120), phone: z.string().max(30) }),
  z.object({ action: z.literal('friend'), code: z.string().max(40) }),
]);

export async function POST(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const p = body.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    const db = await getDb();
    return p.data.action === 'signup' ? crewSignup(db, params.token, p.data) : crewFriend(db, params.token, p.data.code);
  });
}
