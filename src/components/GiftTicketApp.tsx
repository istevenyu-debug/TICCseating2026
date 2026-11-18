'use client';

import { useEffect, useState } from 'react';
import TicketQR from './TicketQR';
import { fmtDate } from './JoinApp';

type T = { event: { name: string; showAt: string }; group: string; name: string; seat: string; entrance: string; serial: string; value: string; entered: string | null; contact: string };

/** 揪團贈席電子票：入座者打開這頁，入場時出示 QR */
export default function GiftTicketApp({ code }: { code: string }) {
  const [tk, setTk] = useState<T | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`/api/join/q/${encodeURIComponent(code)}`, { cache: 'no-store' }).then((r) => r.json())
      .then((r) => (r.ok ? setTk(r.data) : setErr(r.message))).catch(() => setErr('網路連線異常，請重新整理。'));
  }, [code]);
  if (err) return <main className="wrap join" style={{ maxWidth: 480 }}><div className="card"><p className="note err" style={{ margin: 0 }}>{err}</p></div></main>;
  if (!tk) return <main className="wrap join" style={{ maxWidth: 480 }}><div className="card muted">載入中…</div></main>;
  return (
    <main className="wrap join" style={{ maxWidth: 480 }}>
      <div className="card" style={{ border: '3px solid #d9467a', textAlign: 'center' }}>
        <div style={{ display: 'inline-block', background: '#d9467a', color: '#fff', borderRadius: 999, padding: '3px 14px', fontWeight: 700, fontSize: 14 }}>揪團贈席入場 QR（非年代票）</div>
        <h1 style={{ margin: '10px 0 2px', fontSize: 30 }}>三樓 {tk.seat}</h1>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{tk.name}</div>
        <div className="muted small">{tk.group}</div>
        <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0 6px' }}><TicketQR serial={tk.serial} value={tk.value} size={240} /></div>
        <div className="mono small muted">序號 {tk.serial}</div>
        {tk.entered && <p className="note" style={{ marginTop: 10 }}>已於 {new Date(tk.entered).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })} 入場</p>}
      </div>
      <div className="card small">
        <div><b>{tk.event.name}</b></div>
        <div>{fmtDate(tk.event.showAt)}・台北國際會議中心 大會堂{tk.entrance ? `・${tk.entrance}` : ''}</div>
        <p className="muted" style={{ margin: '8px 0 0' }}>入場時出示這個 QR code 即可（可截圖保存）。每個 QR 只能入場一次，請勿轉給別人。如入座的人更換，請負責人在劃位頁改姓名，舊的 QR 會失效。有疑問請洽{tk.contact}。</p>
      </div>
    </main>
  );
}
