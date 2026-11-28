import { z } from 'zod';
import { getDb } from '@/db/client';
import { handle, originOf } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { leadAction, leadState } from '@/lib/crew';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const baseOf = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 驗票負責人管理頁資料 */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  return handle(async () => leadState(await getDb(), params.token, baseOf(req)));
}

const id = z.number().int().positive();
const body = z.discriminatedUnion('action', [
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
    const r = await leadAction(db, params.token, p.data, baseOf(req));
    if (p.data.action === 'mail.send' || p.data.action === 'mail.one') dispatchQueued(db).catch(() => undefined);
    return r;
  });
}
