import JoinPickApp from '@/components/JoinPickApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '揪團劃位', description: '依劃位序選三樓贈席', robots: { index: false } };

export default function JoinPickPage({ params }: { params: { code: string } }) {
  return <JoinPickApp code={params.code} />;
}
