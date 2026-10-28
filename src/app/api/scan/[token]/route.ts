import { z } from 'zod';
import { getDb } from '@/db/client';
import { BookingError } from '@/lib/booking';
import { handle, readJson } from '@/lib/api';
import { gateInfo, scan, searchTickets } from '@/lib/ticket';

export const dynamic = 'force-dynamic';

/** 驗票頁：門口資訊與人數；?q= 搜尋 */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const db = await getDb();
    const q = new URL(req.url).searchParams.get('q');
    return q !== null ? { results: await searchTickets(db, params.token, q) } : gateInfo(db, params.token);
  });
}

const body = z.object({ qr: z.string().max(200).optional(), serial: z.string().max(40).optional() });

/** 掃描（qr）或手動輸入序號（serial）入場 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => {
    const p = body.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', '資料格式不正確');
    return scan(await getDb(), params.token, p.data);
  });
}
