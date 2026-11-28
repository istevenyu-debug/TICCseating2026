import { cookies } from 'next/headers';
import { z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { handle, originOf } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import { type CrewAuth, leadAction, leadGate, leadState, sendLeadOtp, verifyLeadOtp } from '@/lib/crew';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const baseOf = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 已登入後台的系統管理員直接進（看後台登入 cookie，前端送不進來）；否則用負責人手機的通行碼 */
async function who(db: Db, req: Request): Promise<CrewAuth> {
  const u = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value).catch(() => null);
  if (u?.role === 'admin') return { admin: u.displayName };
  return req.headers.get('x-crew-token') ?? '';
}

/** 驗票負責人管理頁資料；?gate=1 只回驗證頁要的（負責人稱呼、遮住的 Email） */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const db = await getDb();
    if (new URL(req.url).searchParams.get('gate') === '1') return leadGate(db, params.token);
    return leadState(db, params.token, await who(db, req), baseOf(req));
  });
}

const id = z.number().int().positive();
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('otp'), email: z.string().max(120) }),
  z.object({ action: z.literal('verify'), otp: z.string().max(10) }),
  z.object({ action: z.literal('pos.add'), names: z.array(z.string().max(20)).min(1).max(20) }),
  z.object({ action: z.literal('pos.renew'), gateId: id }),
  z.object({ action: z.literal('assign'), gateId: id, crewId: id.nullable() }),
  z.object({ action: z.literal('mail.preview') }),
  z.object({ action: z.literal('mail.send'), ids: z.array(id).max(300) }),
  z.object({ action: z.literal('mail.one'), crewId: id }),
  z.object({ action: z.literal('line'), crewId: id }),
  z.object({ action: z.literal('crew.remove'), crewId: id }),
  z.object({ action: z.literal('crew.edit'), crewId: id, name: z.string().max(40), email: z.string().max(120), phone: z.string().max(30) }),
]);

export async function POST(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const p = body.safeParse(await req.json().catch(() => null));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    const db = await getDb();
    const a = p.data;
    if (a.action === 'otp') { const r = await sendLeadOtp(db, params.token, a.email, new Date(), baseOf(req)); dispatchQueued(db).catch(() => undefined); return r; }
    if (a.action === 'verify') return verifyLeadOtp(db, params.token, a.otp);
    const r = await leadAction(db, params.token, await who(db, req), a, baseOf(req));
    if (a.action === 'mail.send' || a.action === 'mail.one') dispatchQueued(db).catch(() => undefined);
    return r;
  });
}
