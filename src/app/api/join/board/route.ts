import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { boardData } from '@/lib/joinBoard';

export const dynamic = 'force-dynamic';

/** 揪團即時看板（公開）：?tab=feed|order|live、?q=群名、?before=時間（看更多） */
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  return handle(async () => boardData(await getDb(), { q: u.get('q') ?? '', before: u.get('before') ?? '', tab: u.get('tab') ?? 'feed' }));
}
