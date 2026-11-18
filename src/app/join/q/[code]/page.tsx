import GiftTicketApp from '@/components/GiftTicketApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '揪團贈席電子票', description: '入場電子票 QR code', robots: { index: false } };

export default function GiftTicketPage({ params }: { params: { code: string } }) {
  return <GiftTicketApp code={params.code} />;
}
