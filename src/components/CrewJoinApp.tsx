'use client';

import { useEffect, useState } from 'react';

type Info = { event: string; showAt: string; leadName: string; lineId: string };
type Res<T> = { ok: true; data: T } | { ok: false; message: string };

async function call<T>(token: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(`/api/crew/j/${encodeURIComponent(token)}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, message: '網路連線異常，請確認後再試。' }; }
}

/** 驗票志工報名：姓名、Email、手機 → 完成後「加負責人 LINE 好友」 */
export default function CrewJoinApp({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState('');
  const [f, setF] = useState({ name: '', email: '', phone: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ code: string; again: boolean } | null>(null);
  const [friend, setFriend] = useState(false);

  useEffect(() => { call<Info>(token).then((r) => (r.ok ? setInfo(r.data) : setFatal(r.message))); }, [token]);

  if (fatal) return <main className="wrap" style={{ maxWidth: 480, padding: 16 }}><div className="card"><h2>無法開啟</h2><p>{fatal}</p></div></main>;
  if (!info) return <main className="wrap" style={{ maxWidth: 480, padding: 16 }}><div className="card">載入中…</div></main>;

  const lineUrl = info.lineId ? `https://line.me/R/ti/p/${info.lineId.startsWith('@') ? `@${encodeURIComponent(info.lineId.slice(1))}` : `~${encodeURIComponent(info.lineId)}`}` : '';
  const day = new Date(info.showAt).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short' });

  if (done) {
    return (
      <main className="wrap" style={{ maxWidth: 480, padding: 16 }}>
        <div className="card">
          <h2>✓ {done.again ? '已更新您的資料' : '報名完成，謝謝您！'}</h2>
          <p>{info.leadName || '驗票負責人'}會把您排到驗票位置，再把<b>您專屬的驗票連結</b>寄到 {f.email}。</p>
          {lineUrl ? <>
            <p style={{ marginBottom: 8 }}><b>最後一步：加驗票負責人 LINE 好友</b>，驗票連結也會從 LINE 傳給您。</p>
            <a className="btn pri" style={{ display: 'block', textAlign: 'center', padding: '12px 0', fontSize: 16 }} href={lineUrl}
              onClick={() => { if (!friend) { setFriend(true); call(token, { action: 'friend', code: done.code }); } }}>加 {info.leadName || '負責人'} 好友</a>
            {friend && <p className="small muted" style={{ marginTop: 8 }}>已打開 LINE。加好友後就可以關閉這一頁。</p>}
          </> : <p className="small muted">之後請留意 Email（也看一下垃圾郵件匣）。</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="wrap" style={{ maxWidth: 480, padding: 16 }}>
      <div className="card">
        <h2>驗票志工報名</h2>
        <p className="small muted" style={{ marginTop: 0 }}>{info.event}・{day}<br />報名後由{info.leadName || '驗票負責人'}安排驗票位置，驗票連結會寄到您的 Email。</p>
        <form onSubmit={async (e) => {
          e.preventDefault();
          setErr(''); setBusy(true);
          const r = await call<{ code: string; again: boolean }>(token, { action: 'signup', ...f });
          setBusy(false);
          if (r.ok) setDone(r.data); else setErr(r.message);
        }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label>姓名<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" required style={{ width: '100%' }} /></label>
          <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" inputMode="email" required style={{ width: '100%' }} /></label>
          <label>手機<input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" inputMode="tel" required placeholder="0912345678" style={{ width: '100%' }} /></label>
          {err && <div className="note err">{err}</div>}
          <button className="btn pri" disabled={busy} style={{ padding: '12px 0', fontSize: 16 }}>{busy ? '送出中…' : '送出報名'}</button>
          <p className="small muted" style={{ margin: 0 }}>您的資料只有驗票負責人與主辦單位看得到，只用於這次驗票聯絡。</p>
        </form>
      </div>
    </main>
  );
}
