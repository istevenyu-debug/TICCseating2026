'use client';

import { useState } from 'react';

export default function SetupForm({ token, username, displayName }: { token: string; username: string; displayName: string }) {
  const [p, setP] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const bad = p.length > 0 && p.length < 10 ? '密碼至少 10 個字元' : p2 && p !== p2 ? '兩次輸入的密碼不一樣' : '';
  return (
    <main className="wrap" style={{ maxWidth: 420 }}>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        const r = await fetch('/api/admin/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: p }) })
          .then((x) => x.json()).catch(() => ({ ok: false, message: '網路連線異常，請稍後再試。' }));
        setBusy(false);
        if (r.ok) location.href = '/admin'; else setErr(r.message);
      }}>
        <h1>設定後台密碼</h1>
        <p className="small muted">{displayName ? `${displayName}，您好。` : ''}請設定您自己的密碼，之後用帳號＋密碼登入後台。</p>
        <label className="f">帳號<input value={username} readOnly autoComplete="username" /></label>
        <label className="f" style={{ marginTop: 8 }}>新密碼（至少 10 個字元）<input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="new-password" /></label>
        <label className="f" style={{ marginTop: 8 }}>再輸入一次<input type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" /></label>
        {(bad || err) && <div className="note err" style={{ marginTop: 8 }}>{bad || err}</div>}
        <button className="btn pri" style={{ width: '100%', marginTop: 12 }} disabled={busy || !!bad || p.length < 10 || p !== p2}>{busy ? '設定中…' : '設定並登入'}</button>
        <p className="small muted" style={{ marginBottom: 0 }}>請記下帳號：<b>{username}</b>。這個連結只能用一次，1 小時內有效。</p>
      </form>
    </main>
  );
}
