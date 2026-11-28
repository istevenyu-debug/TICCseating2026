import type { Metadata, Viewport } from 'next';
import CrewJoinApp from '@/components/CrewJoinApp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '驗票志工報名', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function CrewJoinPage({ params }: { params: { token: string } }) {
  return <CrewJoinApp token={params.token} />;
}
