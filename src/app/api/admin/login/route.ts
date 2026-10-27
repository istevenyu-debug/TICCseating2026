import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { login, loginBlocked, loginFailed, loginOk, makeSession, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const body = z.object({ username: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  const key = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (loginBlocked(key)) {
    return NextResponse.json({ ok: false, message: '登入失敗次數過多，請 10 分鐘後再試。' }, { status: 429 });
  }
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, message: '請輸入帳號與密碼。' }, { status: 422 });
  const u = await login(await getDb(), p.data.username, p.data.password);
  if (!u) {
    loginFailed(key);
    return NextResponse.json({ ok: false, message: '帳號或密碼不正確。' }, { status: 401 });
  }
  loginOk(key);
  const s = makeSession(u.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.value, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: s.maxAge,
  });
  return res;
}
