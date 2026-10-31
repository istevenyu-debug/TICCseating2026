import PreorderApp from '@/components/PreorderApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';
/** 連結貼到 LINE、Facebook 時顯示的標題與說明（取自後台「預購單開頭文字」的第一段） */
export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  const { getPreorderSettings } = await import('@/lib/preorder');
  const intro = (await getPreorderSettings(db)).intro;
  const first = intro.split(/\n\s*\n/)[0].split('\n').filter((x) => x.trim() && !x.startsWith('##')).join(' ');
  const title = ev ? `【${ev.name}】贊助登記` : '贊助登記';
  const description = (first || '感謝您的護持，請點此選擇贊助方案並完成登記。').slice(0, 150);
  return { title, description, openGraph: { title, description, type: 'website', locale: 'zh_TW', siteName: ev?.name ?? '贊助登記' } };
}

/** 預購單關閉時不轉到別處：留在本頁，顯示活動說明與「目前尚未開放贊助登記」 */
export default function BuyPage() {
  return <PreorderApp />;
}
