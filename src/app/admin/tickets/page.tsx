import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import QRCode from 'qrcode';
import { getDb } from '@/db/client';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import { ticketData } from '@/lib/admin';
import PrintButton from '@/components/admin/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '入場券列印' };

const mask = (n: string) => (n.length <= 1 ? n : n.length === 2 ? `${n[0]}○` : `${n[0]}${'○'.repeat(n.length - 2)}${n[n.length - 1]}`);

export default async function TicketsPage({ searchParams }: { searchParams: { ids?: string } }) {
  const db = await getDb();
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) return <main className="wrap"><div className="card">請先登入後台。<a href="/admin">前往登入</a></div></main>;
  const ids = (searchParams.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const { event, tickets } = await ticketData(db, ids);
  const when = event.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const qrs = await Promise.all(tickets.map((t) => QRCode.toString(`TICC|${t.serial}`, { type: 'svg', margin: 0, width: 84 })));
  return (
    <main className="print-wrap">
      <div className="no-print row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <span>共 {tickets.length} 張。A4 直印，每頁 4 張。</span>
        <PrintButton />
      </div>
      <div className="tk-grid">
        {tickets.map((t, i) => (
          <div key={t.serial} className="tk">
            <div className="tk-main">
              <div className="tk-ev">{event.name}</div>
              <div className="tk-sub">{when}・台北國際會議中心 大會堂</div>
              <div className="tk-seat">{t.label}</div>
              <div className="tk-code">座位編號 {t.code}</div>
              <div className="tk-sub">{t.zoneName}・{t.comboName}</div>
              <div className="tk-sub">持票人 <b>{mask(t.holderName)}</b>（{t.holderId4.length > 4 ? '證號' : '證末4碼'} {t.holderId4}）</div>
              <div className="tk-note">入口：{t.entrance}。入場時請出示身分證件核對實名，本券遺失不補發。</div>
            </div>
            <div className="tk-stub">
              <div className="tk-qr" dangerouslySetInnerHTML={{ __html: qrs[i] }} />
              <div className="tk-serial">{t.serial}</div>
            </div>
          </div>
        ))}
      </div>
      {!tickets.length && <p>沒有可列印的入場券（只有已確認到帳的訂單會產生入場券）。</p>}
    </main>
  );
}
