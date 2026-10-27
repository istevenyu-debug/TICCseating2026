import type { Metadata } from 'next';
import BookingApp from '@/components/BookingApp';

export const dynamic = 'force-dynamic';

export function generateMetadata({ params }: { params: { code: string } }): Metadata {
  return {
    manifest: `/t/${encodeURIComponent(params.code)}/manifest.webmanifest`,
    appleWebApp: { capable: true, title: '大會堂劃位', statusBarStyle: 'default' },
    icons: { apple: '/app-icon.png' },
  };
}

export default function TicketPage({ params }: { params: { code: string } }) {
  return <BookingApp code={params.code} />;
}
