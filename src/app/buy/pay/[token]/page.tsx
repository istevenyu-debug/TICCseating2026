import PayApp from '@/components/PayApp';

export const dynamic = 'force-dynamic';
export const metadata = { title: '填寫匯款帳號後五碼', robots: { index: false } };

export default function PayPage({ params }: { params: { token: string } }) {
  return <PayApp token={params.token} />;
}
