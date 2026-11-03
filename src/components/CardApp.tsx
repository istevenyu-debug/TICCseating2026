'use client';

import { useEffect, useMemo, useState } from 'react';
import type { cardMenu } from '@/lib/card';
import { invProblem } from '@/lib/invoiceRules';

type Menu = Awaited<ReturnType<typeof cardMenu>>;
type Item = Menu['items'][number];
const money = (n: number) => `NT$${n.toLocaleString('en-US')}`;
const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const key = (i: { kind: string; id: number }) => `${i.kind}:${i.id}`;

/** 三樓購票：選方案與份數 → 填資料 → 綠界刷卡 → 回來劃位 */
export default function CardApp() {
  const [m, setM] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [step, setStep] = useState<1 | 2>(1);
  const [f, setF] = useState({ name: '', phone: '', email: '', invType: 'member', invCode: '', invTitle: '' });
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => fetch('/api/card/menu', { cache: 'no-store' }).then((x) => x.json()).then((r) => (r.ok ? setM(r.data) : setErr(r.message))).catch(() => setErr('網路連線異常，請稍後再試。'));
  useEffect(() => { load(); const id = setInterval(load, 15_000); return () => clearInterval(id); }, []);

  const picks = useMemo(() => (m?.items ?? []).filter((i) => (qty[key(i)] ?? 0) > 0), [m, qty]);
  const total = picks.reduce((a, i) => a + i.price * qty[key(i)], 0);
  const seats = picks.reduce((a, i) => a + i.seats * qty[key(i)], 0);

  if (!m) return <main style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}><div className="card">{err || '載入中…'}</div></main>;

  const set = (i: Item, n: number) => setQty((q) => ({ ...q, [key(i)]: Math.max(0, Math.min(i.left, n)) }));
  const soldOut = m.items.every((i) => i.left <= 0);

  async function pay() {
    setErr('');
    if (!f.name.trim()) return setErr('請填寫姓名');
    if (!/^09\d{8}$/.test(f.phone.replace(/[\s-]/g, ''))) return setErr('手機應為 09 開頭的 10 位數字');
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr('Email 格式不正確');
    const bad = invProblem(f.invType, f.invCode, f.invTitle);
    if (bad) return setErr(bad);
    if (!agree) return setErr('請先閱讀並同意個資與退票規則');
    setBusy(true);
    const r = await fetch('/api/card/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, agree, items: picks.map((i) => ({ kind: i.kind, id: i.id, qty: qty[key(i)] })) }) })
      .then((x) => x.json()).catch(() => null);
    if (!r?.ok) { setBusy(false); setErr(r?.message ?? '網路連線異常，請確認後再試。'); load(); return; }
    const form = document.createElement('form');
    form.method = 'POST'; form.action = r.data.action;
    for (const [k, v] of Object.entries(r.data.fields as Record<string, string>)) {
      const inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = k; inp.value = v;
      form.appendChild(inp);
    }
    document.body.appendChild(form);
    form.submit(); // 導到綠界付款頁
  }

  const inv = m.invTypes.find((x) => x.id === f.invType);
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 16 }} className="pstack">
      <div className="card">
        <h1 style={{ fontSize: 20, margin: '0 0 4px' }}>{m.event.name}</h1>
        <div className="small muted">{when(m.event.showAt)}・台北國際會議中心大會堂・三樓（3F 入口）第 13–27 排</div>
        {m.test && <div className="note warn small" style={{ marginTop: 8 }}>目前是測試環境：不會真的扣款，買到的票也不是正式票。</div>}
      </div>

      {m.state !== 'open' && (
        <div className="card">
          <b>{m.state === 'not_started' ? '尚未開賣' : m.state === 'ended' ? '已截止' : '目前未開放購票'}</b>
          {m.state === 'not_started' && m.startsAt && <div className="small muted">開賣時間：{when(m.startsAt)}</div>}
        </div>
      )}

      {m.state === 'open' && step === 1 && (
        <div className="card">
          <h2>選擇方案</h2>
          <p className="small muted" style={{ marginTop: 0 }}>三樓目前剩餘 <b>{m.freeSeats}</b> 席。</p>
          {soldOut && <div className="note err">三樓已售完，感謝您的支持。</div>}
          {m.items.map((i) => (
            <div key={key(i)} className="row" style={{ justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--line, #e5e7eb)', flexWrap: 'nowrap', gap: 8 }}>
              <div>
                <b>{i.name}</b>
                <div className="small">{money(i.price)} / {i.unit}</div>
                <div className="small muted">{i.desc}{i.left <= 0 ? '｜已售完' : i.left <= 20 ? `｜剩 ${i.left} ${i.unit}` : ''}</div>
              </div>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <button className="btn" aria-label={`減少${i.name}`} disabled={!(qty[key(i)] > 0)} onClick={() => set(i, (qty[key(i)] ?? 0) - 1)}>−</button>
                <b className="mono" style={{ minWidth: 24, textAlign: 'center' }}>{qty[key(i)] ?? 0}</b>
                <button className="btn" aria-label={`增加${i.name}`} disabled={(qty[key(i)] ?? 0) >= i.left} onClick={() => set(i, (qty[key(i)] ?? 0) + 1)}>＋</button>
              </div>
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <span>共 {seats} 席，<b>{money(total)}</b></span>
            <button className="btn pri" disabled={!picks.length} onClick={() => { setErr(''); setStep(2); window.scrollTo({ top: 0 }); }}>下一步</button>
          </div>
        </div>
      )}

      {m.state === 'open' && step === 2 && (
        <div className="card pstack">
          <h2 style={{ margin: 0 }}>填寫資料</h2>
          <div className="note small">{picks.map((i) => `${i.name} × ${qty[key(i)]}`).join('、')}・共 {seats} 席・<b>{money(total)}</b></div>
          <label>姓名<input value={f.name} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label>手機<input value={f.phone} inputMode="tel" autoComplete="tel" placeholder="0912345678" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label>Email<input value={f.email} type="email" autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label>電子發票
            <select value={f.invType} onChange={(e) => setF({ ...f, invType: e.target.value, invCode: '', invTitle: '' })}>
              {m.invTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          {inv && <div className="small muted">{inv.hint}</div>}
          {f.invType !== 'member' && <label>{f.invType === 'company' ? '統一編號' : f.invType === 'donate' ? '愛心碼' : '載具號碼'}<input value={f.invCode} onChange={(e) => setF({ ...f, invCode: e.target.value })} /></label>}
          {f.invType === 'company' && <label>公司抬頭<input value={f.invTitle} onChange={(e) => setF({ ...f, invTitle: e.target.value })} /></label>}
          <div className="note small"><b>退票規則</b><br />{m.refundText}</div>
          <label className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 8 }}>
            <input type="checkbox" checked={agree} style={{ width: 'auto', marginTop: 3 }} onChange={(e) => setAgree(e.target.checked)} />
            <span className="small">我已閱讀退票規則，並同意主辦方為票務、開立發票及入場核對之目的，蒐集與處理上述個人資料。</span>
          </label>
          <div className="note warn small"><b>付款後請立即劃位，座位依付款先後選取。</b>付款成功會直接進入劃位頁，也會寄連結到您的 Email。</div>
          {err && <div className="note err">{err}</div>}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button className="btn" disabled={busy} onClick={() => { setErr(''); setStep(1); }}>上一步</button>
            <button className="btn pri" disabled={busy} onClick={pay}>{busy ? '前往付款中…' : `信用卡付款 ${money(total)}`}</button>
          </div>
        </div>
      )}
      {step === 1 && err && <div className="note err">{err}</div>}
    </main>
  );
}
