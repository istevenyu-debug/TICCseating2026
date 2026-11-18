'use client';

import { useEffect, useState } from 'react';
import GiftCard from './GiftCard';
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
      <div style={{ padding: '8px 0 16px' }}>
        <GiftCard seat={tk.seat} name={tk.name} group={tk.group} serial={tk.serial} value={tk.value} eventName={tk.event.name} showAt={tk.event.showAt} entered={tk.entered} />
      </div>
      <div className="card small">
        <div><b>{tk.event.name}</b></div>
        <div>{fmtDate(tk.event.showAt)}・台北國際會議中心 大會堂{tk.entrance ? `・${tk.entrance}` : ''}</div>
        <p className="muted" style={{ margin: '8px 0 0' }}>入場時出示這個 QR code 即可（可截圖保存）。每個 QR 只能入場一次，請勿轉給別人。如入座的人更換，請負責人在劃位頁改姓名，舊的 QR 會失效。有疑問請洽{tk.contact}。</p>
      </div>
    </main>
  );
}
