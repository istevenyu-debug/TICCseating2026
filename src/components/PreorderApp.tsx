'use client';

import { useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';

type Menu = {
  open: boolean;
  event: { name: string; showAt: string; bankName: string; bankAccount: string; accountName: string };
  items: { kind: 'combo' | 'zone'; id: number; name: string; price: number; desc: string; unit: string }[];
};
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const money = (n: number) => `NT$${n.toLocaleString('en-US')}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

async function api<T>(body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch('/api/buy', body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 公開訂購頁：選購（不劃位）→ 匯款 → 填資料回傳；主辦方確認收訖後寄出專屬劃位連結 */
export default function PreorderApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [f, setF] = useState({ name: '', phone: '', email: '', paid: '', last5: '', agree: false });
  const [paidTouched, setPaidTouched] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ no: string; amount: number; mismatch: boolean } | null>(null);

  useEffect(() => { api<Menu>().then((r) => (r.ok ? setMenu(r.data) : setErr(r.message))); }, []);
  if (err && !menu) return <main className="wrap"><div className="card"><p className="note err">{err}</p></div></main>;
  if (!menu) return <main className="wrap"><div className="card muted">載入中…</div></main>;

  const key = (i: Menu['items'][number]) => `${i.kind}-${i.id}`;
  const lines = menu.items.filter((i) => (qty[key(i)] ?? 0) > 0);
  const total = lines.reduce((a, i) => a + i.price * qty[key(i)], 0);
  const paid = paidTouched ? f.paid : total ? String(total) : '';
  const setN = (i: Menu['items'][number], n: number) => { setQty({ ...qty, [key(i)]: Math.max(0, Math.min(200, n)) }); setErr(''); };
  const upd = (v: Partial<typeof f>) => { setF({ ...f, ...v }); setErr(''); };

  function next(e: React.FormEvent) {
    e.preventDefault();
    const bad = (m: string, id?: string) => { setErr(m); if (id) document.getElementById(id)?.focus(); };
    if (!lines.length) return bad('請先選購至少一項');
    if (!f.name.trim()) return bad('請填寫身分證上的姓名', 'p-name');
    const pp = f.phone.trim() ? phoneProblem(f.phone) : '請填寫手機';
    if (pp) return bad(pp, 'p-phone');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return bad('Email 格式不正確，劃位連結會寄到這個信箱', 'p-email');
    if (!(parseInt(paid.replace(/\D/g, '')) > 0)) return bad('請填寫匯款金額', 'p-paid');
    if (!/^\d{5}$/.test(f.last5.trim())) return bad('匯款帳號末 5 碼應為 5 位數字', 'p-last5');
    if (!f.agree) return bad('請勾選同意個資蒐集', 'p-agree');
    setErr(''); setReview(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function send() {
    setBusy(true);
    const r = await api<{ no: string; amount: number; mismatch: boolean }>({
      items: menu!.items.map((i) => ({ kind: i.kind, id: i.id, qty: qty[key(i)] ?? 0 })),
      name: f.name.trim(), phone: f.phone, email: f.email.trim(), paidAmount: parseInt(paid.replace(/\D/g, '')) || 0, last5: f.last5.trim(), agree: f.agree,
    });
    setBusy(false);
    if (!r.ok) { setReview(false); setErr(r.message); return; }
    setDone(r.data); window.scrollTo({ top: 0 });
  }

  const head = (
    <div className="card">
      <h1>{menu.event.name}</h1>
      <div className="muted">{fmtDate(menu.event.showAt)}・台北國際會議中心 大會堂</div>
      <p className="small" style={{ margin: '8px 0 0' }}>本頁為<b>訂購</b>，不在這裡劃位。匯款並送出資料後，主辦方確認收到款項，會把<b>專屬劃位連結寄到您的 Email</b>，再用連結選位。</p>
    </div>
  );

  if (done) {
    return (
      <main className="wrap" style={{ maxWidth: 640 }}>
        {head}
        <div className="card">
          <h2>已送出訂單 {done.no}</h2>
          <p>合計 <b>{money(done.amount)}</b>。主辦方確認收到款項後，會把專屬劃位連結寄到 <b>{f.email.trim()}</b>，請留意信箱（也請看看垃圾郵件匣）。</p>
          {done.mismatch && <p className="note warn">提醒：您填寫的匯款金額與合計不同，主辦方會再與您確認。</p>}
          <p className="small muted" style={{ marginBottom: 0 }}>確認信已寄出。如需修改或取消，請聯繫主辦方並提供訂單號 {done.no}。</p>
        </div>
      </main>
    );
  }

  if (!menu.open) return <main className="wrap" style={{ maxWidth: 640 }}>{head}<div className="note err">目前未開放訂購。</div></main>;

  return (
    <main className="wrap" style={{ maxWidth: 640 }}>
      {head}

      {review ? (
        <div className="card review" style={{ marginTop: 0 }}>
          <h2>請確認您的資料</h2>
          <p className="small" style={{ margin: '0 0 8px' }}>送出後不能自行修改。劃位連結會寄到下面的 Email，請確認正確。</p>
          <div className="bank">
            <span className="muted">姓名</span><span><b>{f.name.trim()}</b></span>
            <span className="muted">手機</span><span className="mono"><b>{f.phone.replace(/\D/g, '').replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')}</b></span>
            <span className="muted">Email</span><span className="mono"><b>{f.email.trim()}</b></span>
            <span className="muted">匯款金額</span><span className="mono">{money(parseInt(paid.replace(/\D/g, '')) || 0)}{(parseInt(paid.replace(/\D/g, '')) || 0) !== total && <b style={{ color: 'var(--red)' }}>（與合計 {money(total)} 不同）</b>}</span>
            <span className="muted">帳號末五碼</span><span className="mono">{f.last5.trim()}</span>
          </div>
          <h3>選購內容</h3>
          <div className="sellist">{lines.map((i) => <div className="selitem" key={key(i)}><span>{i.name} × {qty[key(i)]}</span><span className="mono">{money(i.price * qty[key(i)])}</span></div>)}</div>
          <div className="total"><span className="muted">合計</span><b>{money(total)}</b></div>
          {err && <div className="note err" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn pri" style={{ flex: 1 }} disabled={busy} onClick={send}>{busy ? '送出中…' : '資料正確，確認送出'}</button>
            <button className="btn" disabled={busy} onClick={() => setReview(false)}>返回修改</button>
          </div>
        </div>
      ) : (
        <form onSubmit={next} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <h2>一、選購</h2>
            {menu.items.map((i) => (
              <div key={key(i)} className="selitem" style={{ alignItems: 'center', padding: '8px 0' }}>
                <span><b>{i.name}</b><br /><span className="small muted">{i.desc}・{money(i.price)} / {i.unit}</span></span>
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className="btn" aria-label={`減少 ${i.name}`} onClick={() => setN(i, (qty[key(i)] ?? 0) - 1)}>−</button>
                  <input aria-label={`${i.name} 數量`} value={qty[key(i)] ?? 0} inputMode="numeric" style={{ width: 52, textAlign: 'center' }}
                    onChange={(e) => setN(i, parseInt(e.target.value.replace(/\D/g, '')) || 0)} />
                  <button type="button" className="btn" aria-label={`增加 ${i.name}`} onClick={() => setN(i, (qty[key(i)] ?? 0) + 1)}>＋</button>
                </span>
              </div>
            ))}
            <div className="total"><span className="muted">合計{lines.length ? `（${lines.map((i) => `${i.name} × ${qty[key(i)]}`).join('、')}）` : ''}</span><b>{money(total)}</b></div>
          </div>

          <div className="card">
            <h2>二、請先匯款</h2>
            <div className="bank">
              <span className="muted">銀行</span><span>{menu.event.bankName || '（主辦方尚未設定）'}</span>
              <span className="muted">帳號</span><span className="mono">{menu.event.bankAccount}</span>
              <span className="muted">戶名</span><span>{menu.event.accountName}</span>
              <span className="muted">金額</span><span className="mono"><b>{money(total)}</b></span>
            </div>
            <button type="button" className="btn small" style={{ marginTop: 6 }} disabled={!menu.event.bankAccount}
              onClick={() => navigator.clipboard?.writeText(menu.event.bankAccount.replace(/-/g, '')).catch(() => undefined)}>複製帳號</button>
          </div>

          <div className="card">
            <h2>三、匯款後填寫資料</h2>
            <label className="f">姓名（與身分證相同）<input id="p-name" value={f.name} autoComplete="name" onChange={(e) => upd({ name: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">手機<input id="p-phone" value={f.phone} maxLength={13} inputMode="tel" autoComplete="tel" placeholder="09xxxxxxxx"
                style={phoneProblem(f.phone) ? { borderColor: 'var(--red)' } : undefined} onChange={(e) => upd({ phone: e.target.value })} />
                {phoneProblem(f.phone) && <span className="small" style={{ color: 'var(--red)' }}>{phoneProblem(f.phone)}</span>}</label>
              <label className="f">Email（劃位連結寄到這裡）<input id="p-email" type="email" value={f.email} autoComplete="email" onChange={(e) => upd({ email: e.target.value })} /></label>
            </div>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">匯款金額<input id="p-paid" value={paid} inputMode="numeric" onChange={(e) => { setPaidTouched(true); upd({ paid: e.target.value }); }} /></label>
              <label className="f">匯款帳號末五碼<input id="p-last5" value={f.last5} maxLength={5} inputMode="numeric" onChange={(e) => upd({ last5: e.target.value.replace(/\D/g, '') })} /></label>
            </div>
            <label className="check" style={{ marginTop: 10 }}>
              <input id="p-agree" type="checkbox" checked={f.agree} onChange={(e) => upd({ agree: e.target.checked })} />
              我同意主辦方為售票、對帳及實名入場核對之目的，蒐集與處理上述個人資料。
            </label>
            {err && <div className="note err" style={{ marginTop: 10 }}>{err}</div>}
            <button className="btn pri" type="submit" style={{ width: '100%', marginTop: 12 }}>下一步：確認資料</button>
          </div>
        </form>
      )}
    </main>
  );
}
