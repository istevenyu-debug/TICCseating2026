import { getDb } from '@/db/client';
import { clientIp, handle, originOf, readJson } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { createCardOrder } from '@/lib/card';
import { rememberOrigin } from '@/lib/push';

export const dynamic = 'force-dynamic';

/** 同一個 IP 10 分鐘最多建立 30 筆（擋惡意佔名額；公司或社區共用 IP 也夠用） */
const hits = new Map<string, number[]>();
function limit(ip: string, now: number) {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
  if (list.length >= 30) throw new BookingError('TOO_MANY', '操作太頻繁，請稍候幾分鐘再試。');
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
}

export async function POST(req: Request) {
  return handle(async () => {
    limit(clientIp(req) || 'unknown', Date.now());
    const db = await getDb();
    const origin = process.env.PUBLIC_BASE_URL || originOf(req);
    await rememberOrigin(db, origin);
    return createCardOrder(db, await readJson(req), origin);
  });
}
