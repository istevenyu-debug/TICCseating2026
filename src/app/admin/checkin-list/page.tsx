import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import { checkinList } from '@/lib/ticket';
import PrintButton from '@/components/admin/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '入場名單（斷線備用）' };

const tw = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, ...o });

/** 斷線備案：A4 列印的入場名單，工作人員人工核對打勾 */
export default async function CheckinListPage({ searchParams }: { searchParams: { sort?: string } }) {
  const db = await getDb();
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) return <main className="wrap"><div className="card">請先登入後台。<a href="/admin">前往登入</a></div></main>;
  if (user.role === 'finance') return <main className="wrap"><div className="card">財務帳號只能處理電子發票。</div></main>;
  const sort = searchParams.sort === 'seat' ? 'seat' : 'name';
  const { event, rows, entered } = await checkinList(db, sort);
  const now = new Date().toISOString();
  return (
    <main className="print-wrap cl">
      <div className="no-print row" style={{ justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <span>
          排序：{sort === 'name' ? <b>持票人姓名</b> : <a href="?sort=name">持票人姓名</a>}　
          {sort === 'seat' ? <b>座位</b> : <a href="?sort=seat">座位</a>}
        </span>
        <PrintButton />
      </div>
      <h1 className="cl-h">{event.name}・入場名單（斷線備用）</h1>
      <div className="cl-sub">
        列印時間 {tw(now, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}・共 {rows.length} 張・列印時已入場 {entered} 張・依{sort === 'name' ? '持票人姓名筆畫' : '座位'}排序
      </div>
      <div className="cl-sub">只在網站無法驗票時使用：核對持票人姓名與證件後 4 碼，在 ☐ 打勾並寫門口。<b>含個資，活動後收回銷毀，請勿拍照外傳。</b></div>
      <table className="cl-t">
        <thead><tr><th>入場</th><th>持票人</th><th>證後4碼</th><th>座位</th><th>序號</th><th>購票人</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.serial} className={r.entered ? 'cl-done' : ''}>
              <td className="cl-box">{r.entered ? `✓ ${tw(r.entered.at, { hour: '2-digit', minute: '2-digit' })} ${r.entered.gate}` : '☐'}</td>
              <td><b>{r.holderName}</b></td>
              <td className="mono">{r.holderId4}</td>
              <td>{r.label}<div className="cl-zone">{r.zoneName}</div></td>
              <td className="mono">{r.serial}</td>
              <td>{r.buyerName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p>目前沒有已確認的票券。</p>}
    </main>
  );
}
