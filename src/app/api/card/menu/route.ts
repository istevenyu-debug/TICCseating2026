import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { cardMenuShared } from '@/lib/card';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => cardMenuShared(await getDb()));
}
