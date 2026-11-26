import CharityApp from '@/components/CharityApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '公益席・劃位', robots: { index: false } };

export default function CharityPage({ params }: { params: { code: string } }) {
  return <CharityApp code={params.code} />;
}
