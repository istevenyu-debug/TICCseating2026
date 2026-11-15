import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { loginBlocked, loginFailed, loginOk, makeSession, SESSION_COOKIE } from '@/lib/auth';
import { clientIp } from '@/lib/api';
import { redeemSetup } from '@/lib/accounts';
import { BookingError } from '@/lib/booking';

export const dynamic = 'force-dynamic';

const body = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) });

/** 用設定連結設密碼，成功就直接登入 */
export async function POST(req: Request) {
  const key = `setup:${clientIp(req) || 'local'}`;
  if (loginBlocked(key)) return NextResponse.json({ ok: false, message: '嘗試次數過多，請 10 分鐘後再試。' }, { status: 429 });
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, message: '資料格式不正確' }, { status: 422 });
  try {
    const u = await redeemSetup(await getDb(), p.data.token, p.data.password);
    loginOk(key);
    const s = makeSession(u.id);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, s.value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: s.maxAge });
    return res;
  } catch (e) {
    if (e instanceof BookingError) { if (e.message.includes('失效')) loginFailed(key); return NextResponse.json({ ok: false, message: e.message }, { status: 400 }); }
    return NextResponse.json({ ok: false, message: '系統忙碌中，請稍後再試。' }, { status: 500 });
  }
}
