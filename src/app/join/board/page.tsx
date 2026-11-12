import JoinBoardApp from '@/components/JoinBoardApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';

/** 連結貼到 LINE 時顯示的標題與說明 */
export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  const title = ev ? `【${ev.name}】揪團即時看板` : '揪團即時看板';
  const description = '回報動態、劃位排序、劃位現況，即時更新。';
  return { title, description, openGraph: { title, description, type: 'website', locale: 'zh_TW' } };
}

export default function JoinBoardPage() {
  return <JoinBoardApp />;
}
