import VipCardApp from '@/components/VipCardApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '票卡', robots: { index: false } };

export default function VipCardPage({ params }: { params: { code: string } }) {
  return <VipCardApp code={params.code} />;
}
