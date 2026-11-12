import JoinApp from '@/components/JoinApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';

/** 連結貼到 LINE 時顯示的標題與說明 */
export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  const title = ev ? `【${ev.name}】揪團回報（買六送一）` : '揪團回報';
  const description = '志工：點選您的群，填訂單編號後 4 碼與張數。負責人：清單沒有本群請先建立新群。';
  return { title, description, openGraph: { title, description, type: 'website', locale: 'zh_TW' } };
}

export default function JoinPage() {
  return <JoinApp />;
}
