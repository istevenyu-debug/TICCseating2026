import { getDb } from '@/db/client';
import { submitOrder } from '@/lib/booking';
import { handle, visitor, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => submitOrder(await getDb(), params.code, await readJson(req), new Date(), visitor(req)));
}
