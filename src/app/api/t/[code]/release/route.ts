import { getDb } from '@/db/client';
import { releaseHold } from '@/lib/booking';
import { handle } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => { await releaseHold(await getDb(), params.code); return null; });
}
