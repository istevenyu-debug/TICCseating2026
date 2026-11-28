import type { Metadata, Viewport } from 'next';
import QRCode from 'qrcode';
import { PRACTICE_QR, PRACTICE_SEAT, PRACTICE_SERIAL } from '@/lib/practice';

export const dynamic = 'force-static';
export const metadata: Metadata = { title: '驗票練習單', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

type Item = { no: number; title: string; qr?: string; small?: boolean; see: string; todo: string; tone: 'ok' | 'bad' | 'paper' };

const ITEMS: Item[] = [
  { no: 1, title: '我們的票', qr: PRACTICE_QR.ok, see: '綠色：2 樓 第 5 排 12 號', todo: '核對姓名、指路', tone: 'ok' },
  { no: 2, title: '同一張再掃一次', qr: PRACTICE_QR.ok, see: '紅色：已入場過', todo: '請對方到服務台', tone: 'bad' },
  { no: 3, title: '已入場過的票', qr: PRACTICE_QR.used, see: '紅色：已入場過（時間、門口）', todo: '請對方到服務台', tone: 'bad' },
  { no: 4, title: '已取消的票', qr: PRACTICE_QR.cancel, see: '紅色：此訂單已取消', todo: '婉拒入場、請到服務台', tone: 'bad' },
  { no: 5, title: 'VIP', qr: PRACTICE_QR.vip, see: '綠色：VIP 排 8 號', todo: '請帶位', tone: 'ok' },
  { no: 6, title: '年代電子票', qr: PRACTICE_QR.era, see: '綠色：年代票', todo: '看對方手機上的座位', tone: 'ok' },
  { no: 7, title: '年代紙本票（自己買的）', qr: PRACTICE_QR.eraPaper, see: '綠色：年代紙本票', todo: '看票上印的座位', tone: 'ok' },
  { no: 8, title: '年代「轉贈待接收」', qr: PRACTICE_QR.pending, see: '紅色：轉贈尚未接收', todo: '請對方在年代 App 按「接收」再掃', tone: 'bad' },
  { no: 9, title: '印得太小、掃不到', qr: PRACTICE_QR.ok, small: true, see: '掃不到', todo: `改用「手動輸入序號」：${PRACTICE_SERIAL}`, tone: 'ok' },
  { no: 10, title: '不是我們的 QR', qr: PRACTICE_QR.invalid, see: '紅色：不是本活動的入場 QR', todo: '請對方到服務台', tone: 'bad' },
  { no: 11, title: '貴賓券（揪團贈席紙本）', see: '不要掃！', todo: `搜尋框打「${PRACTICE_SEAT.row}-${PRACTICE_SEAT.seat}」→ 按「紙本入場」`, tone: 'paper' },
];

/** 驗票練習單：正式驗票時間前掃這些練習票會照劇本顯示；正式時間後一律「練習票，不可入場」 */
export default async function PracticePage() {
  const svgs = await Promise.all(ITEMS.map((x) => (x.qr ? QRCode.toString(x.qr, { type: 'svg', margin: 1, width: x.small ? 40 : 120 }) : Promise.resolve(''))));
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, fontFamily: "'PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif", color: '#1f2a44' }}>
      <style>{`
        .pg h1{font-size:22px;margin:0 0 4px}
        .pg .lead{font-size:14px;color:#6b7488;margin:0 0 12px;line-height:1.6}
        .pg .warn{background:#fdd835;color:#3d2c00;border-radius:8px;padding:8px 12px;font-size:14px;margin-bottom:12px}
        .pg .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .pg .it{border:1px solid #d7dce6;border-radius:10px;padding:10px;display:flex;gap:10px;align-items:center;break-inside:avoid}
        .pg .q{width:120px;height:120px;flex:none;display:flex;align-items:center;justify-content:center}
        .pg .q svg{width:100%;height:100%}
        .pg .q.small svg{width:40px;height:40px}
        .pg .no{font-size:12px;color:#6b7488}
        .pg .t{font-weight:700;font-size:15px}
        .pg .see{font-size:13px;margin-top:4px}
        .pg .todo{font-size:13px;margin-top:2px;color:#3b4560}
        .pg .ok{color:#0f6e56}.pg .bad{color:#a32d2d}
        .pg .ticket{width:120px;height:120px;flex:none;border:2px dashed #b08a3a;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:13px;color:#7a5a1e;text-align:center;line-height:1.5}
        @media (max-width:560px){.pg .grid{grid-template-columns:1fr}}
        @media print{.pg .warn{border:1px solid #999}.pg{padding:0}@page{size:A4;margin:10mm}}
      `}</style>
      <div className="pg">
        <h1>驗票練習單</h1>
        <p className="lead">用自己的驗票連結開啟驗票頁，按「開始掃描」，依序掃下面的練習票。也可以掃自己或旁邊夥伴手上的真票。</p>
        <div className="warn">正式驗票時間以前，所有掃描都只算練習，不會讓真的票變成「已入場」。正式時間後，這張單上的票一律顯示「練習票，不可入場」。</div>
        <div className="grid">
          {ITEMS.map((x, i) => (
            <div key={x.no} className="it">
              {x.qr ? <div className={`q${x.small ? ' small' : ''}`} dangerouslySetInnerHTML={{ __html: svgs[i] }} />
                : <div className="ticket"><b>貴賓券</b>3樓<br />{PRACTICE_SEAT.row} 排 {PRACTICE_SEAT.seat} 號<br />（練習）</div>}
              <div>
                <div className="no">練習 {x.no}</div>
                <div className="t">{x.title}</div>
                <div className={`see ${x.tone === 'bad' ? 'bad' : x.tone === 'ok' ? 'ok' : ''}`}>會看到：{x.see}</div>
                <div className="todo">要做：{x.todo}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
