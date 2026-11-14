import CardLinkApp from '@/components/CardLinkApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '專屬購票', robots: { index: false, follow: false } };

export default function CardLinkPage({ params }: { params: { code: string } }) {
  return <CardLinkApp code={params.code} />;
}
