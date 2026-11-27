import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, originOf } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { dispatchQueued } from '@/lib/notify';
import { sendVipOtp, verifyVipOtp, vipCardPage, vipCardSend } from '@/lib/vipCard';

export const dynamic = 'force-dynamic';

const tok = (req: Request) => req.headers.get('x-vc-token') ?? '';

/** VIP 票卡頁：驗證過的手機才看得到 */
export async function GET(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => vipCardPage(await getDb(), params.code, tok(req)));
}

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('otp'), email: z.string().max(120) }),
  z.object({ action: z.literal('verify'), otp: z.string().max(10) }),
  z.object({ action: z.literal('send'), orderId: z.number().int().positive(), email: z.string().max(120).optional() }),
]);
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = body.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    const db = await getDb();
    const a = p.data;
    if (a.action === 'verify') return verifyVipOtp(db, params.code, a.otp);
    const r = a.action === 'otp' ? await sendVipOtp(db, params.code, a.email) : await vipCardSend(db, params.code, tok(req), a, originOf(req));
    dispatchQueued(db).catch(() => undefined);
    return r;
  });
}
