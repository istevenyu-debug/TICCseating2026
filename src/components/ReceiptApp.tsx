'use client';

import { useEffect, useState } from 'react';

type Data = { event: string; showAt: string; name: string; seats: string[]; confirmedAt: string | null };
type Res<T> = { ok: true; data: T } | { ok: false; message: string };
const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** 收件人：打開頁面看座位，按「我收到了」才算確認（信箱掃毒自動開連結不算） */
export default function ReceiptApp({ token }: { token: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const api = `/api/vr/${encodeURIComponent(token)}`;
  useEffect(() => {
    fetch(api, { cache: 'no-store' }).then((r) => r.json() as Promise<Res<Data>>).then((r) => (r.ok ? setD(r.data) : setErr(r.message))).catch(() => setErr('網路連線異常，請重新整理。'));
  }, [api]);
  async function ok() {
    setBusy(true);
    const r = await fetch(api, { method: 'POST' }).then((x) => x.json() as Promise<Res<{ confirmedAt: string }>>).catch(() => ({ ok: false, message: '網路連線異常，請再試一次。' } as Res<{ confirmedAt: string }>));
    setBusy(false);
    if (r.ok && d) setD({ ...d, confirmedAt: r.data.confirmedAt }); else if (!r.ok) setErr(r.message);
  }
  return (
    <main className="wrap" style={{ maxWidth: 480 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        {err && <p className="note err" style={{ margin: 0 }}>{err}</p>}
        {!err && !d && <p className="muted">載入中…</p>}
        {d && <>
          <div className="small muted">{d.event}</div>
          <div className="small muted">{when(d.showAt)}・台北國際會議中心 大會堂</div>
          <h1 style={{ fontSize: 22, margin: '10px 0 6px' }}>{d.name} 您好</h1>
          <p style={{ margin: '0 0 6px' }}>您的座位</p>
          {d.seats.map((s) => <div key={s} style={{ fontSize: 22, fontWeight: 800 }}>{s}</div>)}
          {d.confirmedAt
            ? <p className="ok-text" style={{ fontSize: 18, fontWeight: 700, marginTop: 16 }}>✅ 已確認收到，謝謝您！</p>
            : <button className="btn pri" style={{ width: '100%', marginTop: 16, padding: 14, fontSize: 18 }} disabled={busy} onClick={ok}>我收到了</button>}
          <p className="small muted" style={{ marginTop: 12 }}>入場時請出示信中的 QR code（每個 QR 限用一次）。</p>
        </>}
      </div>
    </main>
  );
}
