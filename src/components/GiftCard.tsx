'use client';

import TicketQR from './TicketQR';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 揪團贈席票卡：一席一張，剛好一個手機畫面。
 * 負責人截圖這一張用 LINE 傳出去，座位、姓名、QR 都在同一張圖裡。
 */
export default function GiftCard({ seat, name, group, serial, value, eventName, showAt, entered }: {
  seat: string; name: string; group: string; serial: string; value: string; eventName: string; showAt: string; entered?: string | null;
}) {
  return (
    <div className="giftcard" style={{
      width: '100%', maxWidth: 340, margin: '0 auto', background: '#fff', border: '4px solid #d9467a', borderRadius: 18,
      padding: '18px 16px 14px', textAlign: 'center', boxSizing: 'border-box', color: '#1f2a44',
    }}>
      <div style={{ display: 'inline-block', background: '#d9467a', color: '#fff', borderRadius: 999, padding: '3px 14px', fontWeight: 700, fontSize: 14 }}>揪團贈席（非年代票）</div>
      <div style={{ fontSize: 15, marginTop: 10, color: '#6b7488' }}>三樓</div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.15 }}>{seat}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{name}</div>
      <div style={{ fontSize: 13, color: '#6b7488' }}>{group}</div>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0 4px' }}><TicketQR serial={serial} value={value} size={230} /></div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7488' }}>序號 {serial}</div>
      {entered && <div style={{ marginTop: 6, color: '#1a7f4b', fontWeight: 700 }}>已入場</div>}
      <div style={{ borderTop: '1px dashed #e3a5bd', marginTop: 10, paddingTop: 8, fontSize: 13, lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700 }}>{eventName}</div>
        <div>{when(showAt)}・台北國際會議中心 大會堂</div>
        <div style={{ color: '#6b7488', fontSize: 12 }}>入場出示此 QR・每個 QR 限用一次</div>
      </div>
    </div>
  );
}
