'use client';

import { useEffect, useState } from 'react';

type S = { status: string; code: string | null; orderNo: string };

/** 付款結果：確認中就持續查詢，一確認付款成功就跳進劃位頁 */
export default function CardResult({ token }: { token: string }) {
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/card/status?token=${encodeURIComponent(token)}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
      if (stop) return;
      if (r?.ok) {
        setS(r.data); setErr('');
        if (r.data.status === 'paid' && r.data.code) { location.replace(`/t/${r.data.code}`); return; }
        if (r.data.status !== 'pending') return;
      } else if (r) { setErr(r.message); return; }
      setTimeout(tick, 4000);
    };
    tick();
    return () => { stop = true; };
  }, [token]);

  const st = s?.status;
  return (
    <main className="wrap" style={{ maxWidth: 520, margin: '0 auto', padding: 16 }}>
      <div className="card">
        {err && <div className="note err">{err}</div>}
        {!err && (!s || st === 'pending') && <><h2>正在確認付款結果…</h2><p className="small muted">請不要關閉這個畫面，確認後會自動進入劃位。還沒付款的話，可以回到付款頁完成。如果已經付款，也可以稍後從 Email 收到的連結進入劃位。</p></>}
        {st === 'paid' && <><h2>付款成功</h2><p>正在進入劃位頁…</p></>}
        {(st === 'failed' || st === 'expired') && <><h2>付款沒有完成</h2><p className="small muted">這筆訂單沒有扣款成功，可以重新購買。如果您的信用卡已被扣款，請聯繫主辦單位，並提供訂單編號 <span className="mono">{s?.orderNo}</span>。</p><a className="btn pri" href="/3f">回購票頁</a></>}
        {(st === 'refunded' || st === 'refunding') && <><h2>這筆訂單已退票</h2><p className="small muted">訂單編號 <span className="mono">{s?.orderNo}</span></p></>}
      </div>
    </main>
  );
}
