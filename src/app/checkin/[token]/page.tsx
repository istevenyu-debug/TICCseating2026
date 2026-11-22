import type { Metadata, Viewport } from 'next';
import CheckinBoardApp from '@/components/CheckinBoardApp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '驗票即時看板', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#111827' };

export default function CheckinBoardPage({ params }: { params: { token: string } }) {
  return <CheckinBoardApp token={params.token} />;
}
