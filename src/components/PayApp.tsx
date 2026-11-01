'use client';

import { useEffect, useState } from 'react';

type Info = { no: string; name: string; items: string; status: string; locked: string; remits: { last5: string; amount: number }[]; bank: { name: string; account: string; holder: string } };
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

async function call(body: unknown): Promise<Res<Info>> {
  try {
    const r = await fetch('/api/buy/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 買方用確認信的連結：補填或更正匯款帳號後五碼（可多筆） */
export default function PayApp({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [rows, setRows] = useState<{ last5: string; amount: string }[]>([{ last5: '', amount: '' }]);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call({ token }).then((r) => {
      if (!r.ok) { setErr(r.message); return; }
      setInfo(r.data);
      if (r.data.remits.length) setRows(r.data.remits.map((x) => ({ last5: x.last5, amount: String(x.amount) })));
    });
  }, [token]);

  async function save() {
    setErr(''); setOk('');
    for (const [n, r] of rows.entries()) {
      if (!/^\d{5}$/.test(r.last5)) { setErr(`第 ${n + 1} 筆：帳號後五碼應為 5 位數字`); return; }
      if (!(parseInt(r.amount.replace(/\D/g, '')) > 0)) { setErr(`第 ${n + 1} 筆：請填寫匯款金額`); return; }
    }
    setBusy(true);
    const r = await call({ token, remits: rows.map((x) => ({ last5: x.last5, amount: parseInt(x.amount.replace(/\D/g, '')) })) });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setInfo(r.data); setOk('已儲存，感恩您！主辦方核對款項後，會依登記順序寄出劃位通知。');
  }

  if (!info) return <main className="wrap" style={{ maxWidth: 560 }}><div className="card">{err ? <p className="note err">{err}</p> : <span className="muted">載入中…</span>}</div></main>;
  return (
    <main className="wrap" style={{ maxWidth: 560 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>填寫匯款帳號後五碼</h2>
        <div className="bank">
          <span className="muted">登記編號</span><span className="mono">{info.no}</span>
          <span className="muted">姓名</span><span>{info.name}</span>
          <span className="muted">認購</span><span>{info.items}</span>
        </div>
        {info.locked ? <p className="note ok" style={{ marginTop: 12 }}>{info.locked}</p> : <>
          <p className="small" style={{ margin: '12px 0 6px' }}>請填您<b>匯款帳戶</b>的帳號最後 5 碼。分成多筆、或用不同帳戶匯款的，請每一筆分別填。</p>
          <div className="small muted" style={{ marginBottom: 8 }}>匯款帳戶：{info.bank.name}　帳號 <span className="mono">{info.bank.account}</span>　戶名 {info.bank.holder}</div>
          {rows.map((r, n) => (
            <div key={n} className="fields" style={{ marginTop: 6 }}>
              <label className="f">{rows.length > 1 ? `第 ${n + 1} 筆 ` : ''}帳號後五碼<input value={r.last5} maxLength={5} inputMode="numeric"
                onChange={(e) => { setRows(rows.map((x, m) => (m === n ? { ...x, last5: e.target.value.replace(/\D/g, '') } : x))); setErr(''); }} /></label>
              <label className="f">這筆匯款金額<span className="row" style={{ flexWrap: 'nowrap' }}><input value={r.amount} inputMode="numeric"
                onChange={(e) => { setRows(rows.map((x, m) => (m === n ? { ...x, amount: e.target.value } : x))); setErr(''); }} />
                {rows.length > 1 && <button type="button" className="btn small" aria-label="刪除這筆" onClick={() => setRows(rows.filter((_, m) => m !== n))}>✕</button>}</span></label>
            </div>
          ))}
          {rows.length < 5 && <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => setRows([...rows, { last5: '', amount: '' }])}>＋再加一筆匯款</button>}
          {err && <div className="note err" style={{ marginTop: 10 }}>{err}</div>}
          {ok && <div className="note ok" style={{ marginTop: 10 }}>{ok}</div>}
          <button className="btn pri" style={{ marginTop: 12, width: '100%' }} disabled={busy} onClick={save}>{busy ? '儲存中…' : '儲存'}</button>
        </>}
      </div>
    </main>
  );
}
