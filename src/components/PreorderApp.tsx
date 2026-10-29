'use client';

import { useCallback, useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';
import PushCard from './PushCard';

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

async function call<T>(url: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 這台裝置送出過的訂單（只存隨機查詢碼，不存個資）。瀏覽器不允許儲存時就略過 */
const STORE = 'ticc.preorders';
type Saved = { token: string; no: string };
function loadSaved(): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.token === 'string') : []; } catch { return []; }
}
function addSaved(x: Saved) {
  try { localStorage.setItem(STORE, JSON.stringify([x, ...loadSaved().filter((y) => y.token !== x.token)].slice(0, 20))); } catch { /* 無痕模式等 */ }
}
type Mine = { token: string; no: string; status: string; items: string; amount: number; createdAt: string; url: string | null };
const MINE_STATUS: Record<string, string> = { submitted: '等待主辦方確認收款', confirmed: '已確認收款', cancelled: '已取消' };

/** 這台裝置的訂單進度：確認收款後直接出現「開始劃位」按鈕 */
function MyPreorders({ mine, reload }: { mine: Mine[]; reload: () => void }) {
  if (!mine.length) return null;
  return (
    <div className="card">
      <h2>您在這支手機送出的訂單 <button className="btn small" onClick={reload}>重新整理</button></h2>
      {mine.map((m) => (
        <div key={m.token} className="note" style={{ marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b className="mono">{m.no}</b>
            <span className={`pill ${m.status === 'confirmed' ? 'p-paid' : m.status === 'cancelled' ? 'p-cancelled' : 'p-pending'}`}>{MINE_STATUS[m.status] ?? m.status}</span>
          </div>
          <div className="small muted">{m.items}・{money(m.amount)}</div>
          {m.url
            ? <a className="btn pri" style={{ display: 'block', textAlign: 'center', marginTop: 8 }} href={m.url}>開始劃位（選座位）</a>
            : m.status === 'submitted' && <div className="small" style={{ marginTop: 4 }}>主辦方確認收到款項後，這裡會出現「開始劃位」按鈕，同時寄 Email 給您。</div>}
        </div>
      ))}
    </div>
  );
}

/** 預購單（公開）：選購（不劃位）→ 匯款 → 填資料回傳；主辦方確認收訖後寄出專屬劃位連結 */
export default function PreorderApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [f, setF] = useState({ name: '', phone: '', email: '', paid: '', last5: '', agree: false });
  const [paidTouched, setPaidTouched] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ no: string; amount: number; mismatch: boolean; token: string } | null>(null);
  const [mine, setMine] = useState<Mine[]>([]);

  const reload = useCallback(async () => {
    const saved = loadSaved();
    if (!saved.length) return;
    const r = await call<Mine[]>('/api/buy/mine', { tokens: saved.map((x) => x.token) });
    if (r.ok) setMine(r.data);
  }, []);
  useEffect(() => { api<Menu>().then((r) => (r.ok ? setMenu(r.data) : setErr(r.message))); reload(); }, [reload]);
  // 等待收款期間：回到這頁或每分鐘自動更新一次
  useEffect(() => {
    if (!mine.some((m) => m.status === 'submitted')) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 60_000);
    const vis = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [mine, reload]);
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
    const r = await api<{ no: string; amount: number; mismatch: boolean; token: string }>({
      items: menu!.items.map((i) => ({ kind: i.kind, id: i.id, qty: qty[key(i)] ?? 0 })),
      name: f.name.trim(), phone: f.phone, email: f.email.trim(), paidAmount: parseInt(paid.replace(/\D/g, '')) || 0, last5: f.last5.trim(), agree: f.agree,
    });
    setBusy(false);
    if (!r.ok) { setReview(false); setErr(r.message); return; }
    addSaved({ token: r.data.token, no: r.data.no });
    setDone(r.data); window.scrollTo({ top: 0 });
  }

  const head = (
    <div className="card">
      <h1>{menu.event.name}</h1>
      <div className="muted">{fmtDate(menu.event.showAt)}・台北國際會議中心 大會堂</div>
      <p className="small" style={{ margin: '8px 0 0' }}>本頁為<b>預購單</b>，不在這裡劃位。匯款並送出資料後，主辦方確認收到款項，會把<b>專屬劃位連結寄到您的 Email</b>，再用連結選位。</p>
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
          <p className="small muted" style={{ marginBottom: 0 }}>確認信已寄出。之後用<b>這支手機</b>回到這個網頁，就能看到訂單進度；確認收款後會出現「開始劃位」按鈕。如需修改或取消，請聯繫主辦方並提供訂單號 {done.no}。</p>
        </div>
        <PushCard endpoint={`/api/buy/push?t=${encodeURIComponent(done.token)}`} api={call} compact={false}
          title="📱 收款確認後，劃位連結直接送到這支手機"
          offText={<>開啟後，主辦方確認收到款項時，這支手機會跳出通知，<b>點一下就能開始選位</b>。Email 也會照常寄出。</>}
          onText="✓ 已開啟通知：主辦方確認收款後，這支手機會收到劃位通知。也可以隨時回到這個網頁查看。" />
      </main>
    );
  }

  if (!menu.open) return <main className="wrap" style={{ maxWidth: 640 }}>{head}<MyPreorders mine={mine} reload={reload} /><div className="note err">目前未開放預購。</div></main>;

  return (
    <main className="wrap" style={{ maxWidth: 640 }}>
      {head}
      <MyPreorders mine={mine} reload={reload} />

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
          <p className="small muted" style={{ margin: '10px 0 0' }}>請用<b>自己的手機</b>送出：送出後，這支手機可以查進度、收到劃位通知。不要用公用或別人的電腦。</p>
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
