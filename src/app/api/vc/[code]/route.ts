import { cookies } from 'next/headers';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, originOf } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import type { Db } from '@/db/client';
import { dispatchQueued } from '@/lib/notify';
import { type VcAuth, sendVipOtp, verifyVipOtp, vipCardBook, vipCardCancel, vipCardName, vipCardPage, vipCardSeatMap, vipCardSend, vipCardSendAll } from '@/lib/vipCard';

export const dynamic = 'force-dynamic';

/** 已登入後台的系統管理員直接進（看後台登入 cookie，前端送不進來）；否則用負責人手機的通行碼 */
async function who(db: Db, req: Request): Promise<VcAuth> {
  const u = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value).catch(() => null);
  if (u?.role === 'admin') return { admin: u.displayName };
  return req.headers.get('x-vc-token') ?? '';
}

/** VIP 票卡頁：驗證過的手機才看得到 */
export async function GET(req: Request, { params }: { params: { code: string } }) {
  const seats = new URL(req.url).searchParams.get('seats') === '1';
  return handle(async () => { const db = await getDb(); return (seats ? vipCardSeatMap : vipCardPage)(db, params.code, await who(db, req)); });
}

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('otp'), email: z.string().max(120) }),
  z.object({ action: z.literal('verify'), otp: z.string().max(10) }),
  z.object({ action: z.literal('send'), orderId: z.number().int().positive(), email: z.string().max(120).optional() }),
  z.object({ action: z.literal('name'), orderId: z.number().int().positive(), seatId: z.string().max(40), name: z.string().max(80) }),
  z.object({ action: z.literal('book'), seats: z.array(z.object({ seatId: z.string().max(40), name: z.string().max(80), email: z.string().max(120).optional() })).min(1).max(20), org: z.string().max(80).optional() }),
  z.object({ action: z.literal('cancel'), orderId: z.number().int().positive(), seatId: z.string().max(40) }),
  z.object({ action: z.literal('sendAll'), dry: z.boolean(), pick: z.array(z.object({ orderId: z.number().int().positive(), email: z.string().max(120) })).max(300).optional() }),
]);
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const p = body.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    const db = await getDb();
    const a = p.data;
    if (a.action === 'verify') return verifyVipOtp(db, params.code, a.otp);
    if (a.action === 'name') return vipCardName(db, params.code, await who(db, req), a);
    if (a.action === 'book') return vipCardBook(db, params.code, await who(db, req), a);
    if (a.action === 'cancel') return vipCardCancel(db, params.code, await who(db, req), a);
    const base = process.env.PUBLIC_BASE_URL || originOf(req);
    const r = a.action === 'otp' ? await sendVipOtp(db, params.code, a.email, new Date(), base)
      : a.action === 'sendAll' ? await vipCardSendAll(db, params.code, await who(db, req), a, base)
        : await vipCardSend(db, params.code, await who(db, req), a, base);
    dispatchQueued(db).catch(() => undefined);
    return r;
  });
}
