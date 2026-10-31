import { redirect } from 'next/navigation';
import PreorderApp from '@/components/PreorderApp';
import { getDb } from '@/db/client';
import * as t from '@/db/schema';

export const dynamic = 'force-dynamic';
export async function generateMetadata() {
  const db = await getDb();
  const [ev] = await db.select({ name: t.event.name }).from(t.event).orderBy(t.event.id).limit(1);
  return { title: ev ? `${ev.name}｜預購單` : '預購單', description: '預購單' };
}

/** 報名改用老闆的 Google 表單：本站預購單關閉時，/buy 直接轉到表單 */
const FORM_URL = 'https://forms.gle/irEzAvs9YyCv19Ga7';

export default async function BuyPage() {
  const db = await getDb();
  const [ev] = await db.select({ open: t.event.preorderOpen }).from(t.event).orderBy(t.event.id).limit(1);
  if (!ev?.open) redirect(FORM_URL);
  return <PreorderApp />;
}
