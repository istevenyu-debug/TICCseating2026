import CardResult from '@/components/CardResult';

export const dynamic = 'force-dynamic';
export const metadata = { title: '付款結果', robots: { index: false } };

export default function CardResultPage({ params }: { params: { token: string } }) {
  return <CardResult token={params.token} />;
}
