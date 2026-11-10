import JoinReportApp from '@/components/JoinReportApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '揪團回報', description: '輸入年代訂單編號與張數', robots: { index: false } };

export default function JoinReportPage({ params }: { params: { code: string } }) {
  return <JoinReportApp code={params.code} />;
}
