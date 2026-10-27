'use client';

import { useState } from 'react';

export default function LoginForm({ devHint }: { devHint: boolean }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="wrap" style={{ maxWidth: 420 }}>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
          .then((x) => x.json()).catch(() => ({ ok: false, message: '網路連線異常，請稍後再試。' }));
        setBusy(false);
        if (r.ok) location.reload(); else setErr(r.message);
      }}>
        <h1>大會堂劃位後台</h1>
        <p className="small muted">請以主辦方後台帳號登入。</p>
        <label className="f">帳號<input id="u" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" /></label>
        <label className="f" style={{ marginTop: 8 }}>密碼<input id="p" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        {err && <div className="note err" style={{ marginTop: 8 }}>{err}</div>}
        <button className="btn pri" style={{ width: '100%', marginTop: 12 }} disabled={busy || !u || !p}>{busy ? '登入中…' : '登入'}</button>
        {devHint && <p className="small muted">本機開發預設帳號：admin，密碼：ticc-dev-2026。正式環境請設定 ADMIN_USERNAME 與 ADMIN_PASSWORD。</p>}
      </form>
    </main>
  );
}
