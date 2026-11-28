import type { Metadata, Viewport } from 'next';
import CrewLeadApp from '@/components/CrewLeadApp';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { token: string } }): Metadata {
  return {
    title: '驗票管理', robots: { index: false, follow: false },
    manifest: `/api/crew/manifest/${encodeURIComponent(params.token)}`,
    appleWebApp: { capable: true, title: '驗票管理', statusBarStyle: 'default' },
    icons: { apple: '/crew-icon-180.png', icon: '/crew-icon-192.png' },
  };
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, themeColor: '#1f2a44' };

export default function CrewLeadPage({ params }: { params: { token: string } }) {
  return <CrewLeadApp token={params.token} />;
}
