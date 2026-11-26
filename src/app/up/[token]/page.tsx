import UpgradeApp from '@/components/UpgradeApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '免費升等・選新座位', robots: { index: false } };

export default function UpgradePage({ params }: { params: { token: string } }) {
  return <UpgradeApp token={params.token} />;
}
