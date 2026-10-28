import type { Metadata, Viewport } from 'next';
import ScanApp from '@/components/ScanApp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '驗票', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, themeColor: '#111827' };

export default function ScanPage({ params }: { params: { token: string } }) {
  return <ScanApp token={params.token} />;
}
