import type { Metadata } from 'next';
import { getDb } from '@/db/client';
import { setupInfo } from '@/lib/accounts';
import SetupForm from '@/components/admin/SetupForm';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '設定後台密碼', robots: { index: false } };

/** 後台帳號設定連結：本人自己設密碼（1 小時有效、用過即失效） */
export default async function SetupPage({ params }: { params: { token: string } }) {
  const info = await setupInfo(await getDb(), params.token);
  if (!info) return <main className="wrap" style={{ maxWidth: 420 }}><div className="card"><h1>連結已失效</h1><p>這個設定連結超過 1 小時或已經用過了。請找系統管理員在後台按「重寄設定連結」。</p><a className="btn" href="/admin">前往登入</a></div></main>;
  return <SetupForm token={params.token} username={info.username} displayName={info.displayName} />;
}
