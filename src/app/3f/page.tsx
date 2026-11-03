import CardApp from '@/components/CardApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  const title = ev ? `【${ev.name}】三樓購票` : '三樓購票';
  return { title, description: '線上刷卡購票，付款後立即劃位。', openGraph: { title, description: '線上刷卡購票，付款後立即劃位。', type: 'website', locale: 'zh_TW' } };
}

export default function Floor3Page() {
  return <CardApp />;
}
