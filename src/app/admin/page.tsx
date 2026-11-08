import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { ensureBootstrapAdmin, SESSION_COOKIE, sessionUser } from '@/lib/auth';
import AdminApp from '@/components/admin/AdminApp';
import LoginForm from '@/components/admin/LoginForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '劃位後台',
  manifest: '/admin/manifest.webmanifest',
  icons: { apple: '/admin-icon.png', icon: '/admin-icon.png' },
  appleWebApp: { capable: false, title: '劃位後台' }, // iPhone 從桌面開仍用 Safari，下載與分享才穩定
};

export default async function AdminPage() {
  const db = await getDb();
  await ensureBootstrapAdmin(db);
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) return <LoginForm devHint={process.env.NODE_ENV !== 'production' && !process.env.ADMIN_PASSWORD} />;
  return <AdminApp />;
}
