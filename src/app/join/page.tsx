import JoinApp from '@/components/JoinApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';

/** 連結貼到 LINE 時顯示的標題與說明 */
export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  const title = ev ? `【${ev.name}】揪團登記` : '揪團登記';
  const description = '感謝護持！請登記團練場的揪團人，約 1 分鐘。';
  return { title, description, openGraph: { title, description, type: 'website', locale: 'zh_TW' } };
}

export default function JoinPage() {
  return <JoinApp />;
}
