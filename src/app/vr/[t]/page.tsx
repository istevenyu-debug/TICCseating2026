import ReceiptApp from '@/components/ReceiptApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '確認收到', robots: { index: false } };

export default function ReceiptPage({ params }: { params: { t: string } }) {
  return <ReceiptApp token={params.t} />;
}
