import { NextResponse } from 'next/server';
import { BookingError } from './booking';

const STATUS: Record<string, number> = {
  LINK_NOT_FOUND: 404, LINK_DISABLED: 403, LINK_EXPIRED: 410, SALE_CLOSED: 409,
  SEAT_TAKEN: 409, SEAT_UNAVAILABLE: 409, QUOTA: 409, COMBO: 422, INVALID: 422,
  HOLD_GONE: 409, BUNDLE: 409, HOLD_EXPIRED: 410, UNAUTHORIZED: 401, NOT_FOUND: 404, BUSY: 409, NO_EVENT: 409, TOO_MANY: 429,
};

export async function handle<T>(fn: () => Promise<T>) {
  try {
    return NextResponse.json({ ok: true, data: await fn() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof BookingError) {
      return NextResponse.json({ ok: false, code: e.code, message: e.message, detail: e.detail ?? null }, { status: STATUS[e.code] ?? 400 });
    }
    console.error(e);
    return NextResponse.json({ ok: false, code: 'SERVER', message: '系統忙碌中，請稍後再試。' }, { status: 500 });
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { throw new BookingError('INVALID', '資料格式不正確'); }
}

/** 這次請求的網站網址（經 Cloudflare 通道時為通道網址），用於簡訊裡的連結 */
export function originOf(req: Request): string {
  const h = req.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return host ? `${proto.split(',')[0]}://${host.split(',')[0]}` : '';
}

/** 訪客的真實 IP：經過 Cloudflare 轉發（Worker）時由 x-ticc-client-ip 帶來，否則用 Cloudflare／代理的標頭 */
export function clientIp(req: Request): string {
  const h = req.headers;
  return h.get('x-ticc-client-ip') ?? h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
}

/** 公開連結的訪客代碼（由瀏覽器產生，放在 x-visitor 標頭） */
export function visitor(req: Request): string | undefined {
  return req.headers.get('x-visitor') ?? undefined;
}
