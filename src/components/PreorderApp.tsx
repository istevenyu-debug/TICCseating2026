'use client';

import { useCallback, useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';
import PushCard from './PushCard';
import { invProblem, type InvType } from '@/lib/invoiceRules';

type Menu = {
  open: boolean;
  mailFrom: string;
  pushLink: boolean;
  line: { groups: { name: string; url: string }[]; map: Record<string, number> };
  invoice: boolean;
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
/** 草稿：去匯款、去加 LINE 群再回來，選的、填的都還在（只存在這支手機的這個瀏覽器） */
const DRAFT = 'ticc.buyDraft';
type Draft = { qty: Record<string, number>; f: Record<string, string>; extra: { last5: string; amount: string }[]; lineOpened: string[]; lineJoined: string[]; inv: { type: InvType; code: string; title: string }; paidTouched: boolean; at: number };
function loadDraft(): Draft | null {
  try { const v = JSON.parse(localStorage.getItem(DRAFT) ?? 'null') as Draft | null; return v && Date.now() - v.at < 30 * 86400_000 ? v : null; } catch { return null; }
}
function saveDraft(d: Omit<Draft, 'at'>) { try { localStorage.setItem(DRAFT, JSON.stringify({ ...d, at: Date.now() })); } catch { /* 無痕模式等 */ } }
function clearDraft() { try { localStorage.removeItem(DRAFT); } catch { /* 忽略 */ } }

function loadSaved(): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.token === 'string') : []; } catch { return []; }
}
function addSaved(x: Saved) {
  try { localStorage.setItem(STORE, JSON.stringify([x, ...loadSaved().filter((y) => y.token !== x.token)].slice(0, 20))); } catch { /* 無痕模式等 */ }
}
type Mine = { token: string; no: string; status: string; items: string; amount: number; createdAt: string; email: string; url: string | null };
const MINE_STATUS: Record<string, string> = { submitted: '等待主辦方確認收款', confirmed: '已確認收款', cancelled: '已取消' };

/** 這台裝置的訂單進度：確認收款後提醒查看 Email（劃位連結只用 Email 寄送） */
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
            ? <><a className="btn pri" style={{ display: 'block', textAlign: 'center', marginTop: 8 }} href={m.url}>開始劃位（選座位）</a>
                <div className="small muted" style={{ marginTop: 4 }}>劃位連結也已寄到您的 Email（{m.email}）。</div></>
            : m.status === 'confirmed'
            ? <div className="note ok small" style={{ marginTop: 8 }}>已確認收到款項。<b>劃位連結已寄到您的 Email（{m.email}）</b>，請到信箱點連結選位；沒看到請看看垃圾郵件匣，或聯繫主辦方。</div>
            : m.status === 'submitted' && <div className="small" style={{ marginTop: 4 }}>主辦方確認收到款項後，{'這裡會出現「開始劃位」按鈕，'}同時把劃位連結寄到您的 Email（{m.email}）。</div>}
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
  const [f, setF] = useState({ name: '', phone: '', email: '', paid: '', last5: '', lineName: '', agree: false });
  const [extra, setExtra] = useState<{ last5: string; amount: string }[]>([]); // 第二個以上的匯款帳號
  const [restored, setRestored] = useState<boolean | null>(null);
  const [lineOpened, setLineOpened] = useState<string[]>([]);
  const [lineJoined, setLineJoined] = useState<string[]>([]);
  const [paidTouched, setPaidTouched] = useState(false);
  const [inv, setInv] = useState<{ type: InvType; code: string; title: string }>({ type: 'member', code: '', title: '' });
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
  // 讀回草稿（只做一次）
  useEffect(() => {
    if (!menu || restored !== null) return;
    const d = loadDraft();
    if (d && (Object.values(d.qty).some((n) => n > 0) || d.f.name)) {
      setQty(d.qty); setF((x) => ({ ...x, ...d.f, agree: false })); setExtra(d.extra ?? []); setLineOpened(d.lineOpened ?? []); setLineJoined(d.lineJoined ?? []);
      setInv(d.inv ?? { type: 'member', code: '', title: '' }); setPaidTouched(!!d.paidTouched); setRestored(true);
    } else setRestored(false);
  }, [menu, restored]);
  // 自動存草稿
  useEffect(() => {
    if (!restored && restored !== false) return;
    if (done) return;
    const { agree: _a, ...rest } = f; void _a;
    saveDraft({ qty, f: rest, extra, lineOpened, lineJoined, inv, paidTouched });
  }, [qty, f, extra, lineOpened, lineJoined, inv, paidTouched, restored, done]);
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
  // 選了哪些項目，就要加入對應的 LINE 群（不重複、依後台設定順序）
  const lineIdx = new Set(lines.map((i) => menu.line.map[`${i.kind}:${i.id}`]).filter((x) => x !== undefined));
  const lineGroups = menu.line.groups.filter((_, n) => lineIdx.has(n));
  const extraSum = extra.reduce((a, r) => a + (parseInt(r.amount.replace(/\D/g, '')) || 0), 0);
  const paid = paidTouched ? f.paid : total ? String(Math.max(0, total - extraSum)) : '';
  const remits = [{ last5: f.last5.trim(), amount: parseInt(paid.replace(/\D/g, '')) || 0 }, ...extra.map((r) => ({ last5: r.last5.trim(), amount: parseInt(r.amount.replace(/\D/g, '')) || 0 }))];
  const paidSum = remits.reduce((a, r) => a + r.amount, 0);
  const ex = menu.items[0];
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
    for (const [n, r] of extra.entries()) {
      if (!/^\d{5}$/.test(r.last5.trim())) return bad(`第 ${n + 2} 筆匯款：帳號末 5 碼應為 5 位數字`, `p-x5-${n}`);
      if (!(parseInt(r.amount.replace(/\D/g, '')) > 0)) return bad(`第 ${n + 2} 筆匯款：請填寫金額`, `p-xa-${n}`);
    }
    { const ip = invProblem(inv.type, inv.code.toUpperCase(), inv.title); if (ip) return bad(ip, inv.type === 'company' && !inv.title.trim() && inv.code.trim() ? 'p-inv-title' : 'p-inv'); }
    if (!f.agree) return bad('請勾選同意個資蒐集', 'p-agree');
    const miss = lineGroups.find((g) => !lineJoined.includes(g.name));
    if (miss) return bad(lineOpened.includes(miss.name) ? `請勾選「我已加入 ${miss.name}」` : `請先按「加入 ${miss.name}」，加入後再勾選「我已加入」`, `p-line-${lineGroups.indexOf(miss)}`);
    setErr(''); setReview(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function send() {
    setBusy(true);
    const r = await api<{ no: string; amount: number; mismatch: boolean; token: string }>({
      items: menu!.items.map((i) => ({ kind: i.kind, id: i.id, qty: qty[key(i)] ?? 0 })),
      name: f.name.trim(), phone: f.phone, email: f.email.trim(), agree: f.agree, lineName: f.lineName.trim(),
      remits: remits.map((r) => ({ last5: r.last5, amount: r.amount })), lineJoined: lineGroups.map((g) => g.name).filter((n) => lineJoined.includes(n)),
      invType: inv.type, invCode: inv.type === 'company' ? inv.code.trim() : '', invTitle: inv.type === 'company' ? inv.title.trim() : '',
    });
    setBusy(false);
    if (!r.ok) { setReview(false); setErr(r.message); return; }
    addSaved({ token: r.data.token, no: r.data.no });
    clearDraft();
    setDone(r.data); window.scrollTo({ top: 0 });
  }

  const head = (
    <div className="card">
      <h1>{menu.event.name}</h1>
      <div className="muted">{fmtDate(menu.event.showAt)}・台北國際會議中心 大會堂</div>
      <h3 style={{ margin: '12px 0 4px' }}>怎麼訂</h3>
      <ol className="small" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
        <li>選好要訂的項目，畫面會算出<b>應匯金額</b>。</li>
        {menu.line.groups.length > 0 && <li>加入 LINE 群（依您選的項目）。</li>}
        <li>到銀行或網銀 App <b>匯款</b>。</li>
        <li>回到這個頁面，填<b>匯款帳號後五碼</b>和聯絡資料，送出。</li>
      </ol>
      {ex && <p className="small" style={{ margin: '6px 0 0' }}>例：{ex.name} 1 {ex.unit} {money(ex.price)} → 匯 {money(ex.price)} 到下方帳戶 → 回來填帳號後五碼送出。</p>}
      <p className="small" style={{ margin: '6px 0 0' }}>去匯款或加 LINE 群會離開這頁，沒關係：<b>用同一支手機、同一個方式再打開這個連結</b>，您選的、填的都還在。</p>
      <h3 style={{ margin: '12px 0 4px' }}>劃位順序</h3>
      <p className="small" style={{ margin: 0 }}>依<b>送出預購單的先後順序</b>劃位。主辦方核對<b>匯款已入帳</b>、並確認您<b>已加入 LINE 群</b>後，會依序通知您劃位；尚未匯款或還沒加入 LINE 群的，先輪給後面已完成的人。輪到您時，劃位連結會寄到您的 Email，主辦方也可能用電話或 LINE 與您聯繫。</p>
    </div>
  );

  if (done) {
    return (
      <main className="wrap" style={{ maxWidth: 640 }}>
        {head}
        <div className="card">
          <h2>已送出訂單 {done.no}</h2>
          <p>合計 <b>{money(done.amount)}</b>。主辦方確認收到款項後，會把專屬劃位連結寄到 <b>{f.email.trim()}</b>，請留意信箱。</p>
          <p className="note warn">劃位通知信可能被歸到<b>垃圾郵件匣</b>，沒看到請到垃圾郵件匣找找看。{menu.mailFrom && <>建議先把寄件信箱 <b className="mono">{menu.mailFrom}</b> 加入聯絡人。</>}</p>
          {done.mismatch && <p className="note warn">提醒：您填寫的匯款金額與合計不同，主辦方會再與您確認。</p>}
          <p className="small muted" style={{ marginBottom: 0 }}>確認信已寄出。之後用<b>這支手機</b>回到這個網頁，就能看到訂單進度{menu.pushLink ? '；確認收款後會出現「開始劃位」按鈕' : ''}。如需修改或取消，請聯繫主辦方並提供訂單號 {done.no}。</p>
        </div>
        <PushCard endpoint={`/api/buy/push?t=${encodeURIComponent(done.token)}`} api={call} compact={false}
          title={menu.pushLink ? '📱 收款確認後，劃位連結直接送到這支手機' : '📱 收款確認時通知這支手機'}
          offText={menu.pushLink ? <>開啟後，主辦方確認收到款項時，這支手機會跳出通知，<b>點一下就能開始選位</b>。Email 也會照常寄出。</> : <>開啟後，主辦方確認收到款項時，這支手機會跳出通知，提醒您<b>到 Email 收劃位連結</b>。</>}
          onText={menu.pushLink ? '✓ 已開啟通知：主辦方確認收款後，這支手機會收到劃位通知，點一下就能選位。也可以隨時回到這個網頁按「開始劃位」。' : '✓ 已開啟通知：主辦方確認收款後，這支手機會跳出通知，提醒您查看 Email。也可以隨時回到這個網頁查看進度。'} />
      </main>
    );
  }

  if (!menu.open) return <main className="wrap" style={{ maxWidth: 640 }}>{head}<MyPreorders mine={mine} reload={reload} /><div className="note err">目前未開放預購。</div></main>;

  return (
    <main className="wrap" style={{ maxWidth: 640 }}>
      {head}
      <MyPreorders mine={mine} reload={reload} />
      {restored && !review && lines.length > 0 && (
        <div className="note ok">歡迎回來，您上次選的是 <b>{lines.map((i) => `${i.name} × ${qty[key(i)]}`).join('、')}</b>，應匯 <b>{money(total)}</b>。匯好了嗎？請在下面填帳號後五碼送出。
          <button type="button" className="btn small" style={{ marginLeft: 8 }} onClick={() => { clearDraft(); location.reload(); }}>清除重填</button></div>
      )}

      {review ? (
        <div className="card review" style={{ marginTop: 0 }}>
          <h2>請確認您的資料</h2>
          <p className="small" style={{ margin: '0 0 8px' }}>送出後不能自行修改。劃位連結會寄到下面的 Email，請確認正確。</p>
          <div className="bank">
            <span className="muted">姓名</span><span><b>{f.name.trim()}</b></span>
            <span className="muted">手機</span><span className="mono"><b>{f.phone.replace(/\D/g, '').replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')}</b></span>
            <span className="muted">Email</span><span className="mono"><b>{f.email.trim()}</b></span>
            {f.lineName.trim() && <><span className="muted">LINE 名稱</span><span>{f.lineName.trim()}</span></>}
            <span className="muted">匯款</span><span className="mono">{remits.map((r, n) => <div key={n}>末五碼 {r.last5}・{money(r.amount)}</div>)}
              {remits.length > 1 && <div>合計 {money(paidSum)}</div>}{paidSum !== total && <b style={{ color: 'var(--red)' }}>（與應付 {money(total)} 不同）</b>}</span>
            <span className="muted">發票</span><span>{inv.type === 'company' ? `三聯：${inv.title.trim()}（統編 ${inv.code.trim()}）` : '二聯（個人）'}</span>
          </div>
          <h3>選購內容</h3>
          <div className="sellist">{lines.map((i) => <div className="selitem" key={key(i)}><span>{i.name} × {qty[key(i)]}</span><span className="mono">{money(i.price * qty[key(i)])}</span></div>)}</div>
          <div className="total"><span className="muted">合計</span><b>{money(total)}</b></div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>請用<b>自己的手機</b>送出：送出後，這支手機可以查進度、收到收款通知。</p>
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

          {lineGroups.length > 0 && (
            <div className="card">
              <h2>二、加入 LINE 群（必做）</h2>
              <p className="small" style={{ margin: 0 }}>依您選購的項目，請先加入下面的 LINE 群，才能送出。加入後請<b>回到這個頁面</b>繼續（iPhone 按左上角返回；在 LINE 裡打開的，請再點一次預購單連結，資料都還在）。</p>
              {lineGroups.map((g, n) => {
                const opened = lineOpened.includes(g.name);
                return (
                  <div key={g.name} style={{ marginTop: 10 }}>
                    <a className="btn pri" href={g.url} target="_blank" rel="noreferrer" style={{ background: '#06c755', borderColor: '#06c755', display: 'inline-block' }}
                    onClick={() => { if (!opened) setLineOpened([...lineOpened, g.name]); setErr(''); }}>① 加入「{g.name}」</a>
                    <label className="check" style={{ marginTop: 6, opacity: opened ? 1 : 0.5 }}>
                    <input id={`p-line-${n}`} type="checkbox" checked={lineJoined.includes(g.name)} disabled={!opened}
                      onChange={(e) => { setLineJoined(e.target.checked ? [...lineJoined, g.name] : lineJoined.filter((x) => x !== g.name)); setErr(''); }} />
                    <span>② 我已加入「{g.name}」{!opened && <><br /><span className="small muted">請先按上面的「加入「{g.name}」」</span></>}</span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          <div className="card">
            <h2>{lineGroups.length ? '三' : '二'}、請先匯款</h2>
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
            <h2>{lineGroups.length ? '四' : '三'}、匯款後填寫資料</h2>
            <label className="f">姓名（與身分證相同）<input id="p-name" value={f.name} autoComplete="name" onChange={(e) => upd({ name: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">手機<input id="p-phone" value={f.phone} maxLength={13} inputMode="tel" autoComplete="tel" placeholder="09xxxxxxxx"
                style={phoneProblem(f.phone) ? { borderColor: 'var(--red)' } : undefined} onChange={(e) => upd({ phone: e.target.value })} />
                {phoneProblem(f.phone) && <span className="small" style={{ color: 'var(--red)' }}>{phoneProblem(f.phone)}</span>}</label>
              <label className="f">Email（劃位連結寄到這裡）<input id="p-email" type="email" value={f.email} autoComplete="email" onChange={(e) => upd({ email: e.target.value })} /></label>
            </div>
            <label className="f" style={{ marginTop: 8 }}>LINE 顯示名稱（選填，方便主辦方在群裡找到您）<input value={f.lineName} maxLength={40} onChange={(e) => upd({ lineName: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">匯款帳號後五碼<input id="p-last5" value={f.last5} maxLength={5} inputMode="numeric" onChange={(e) => upd({ last5: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="f">匯款金額<input id="p-paid" value={paid} inputMode="numeric" onChange={(e) => { setPaidTouched(true); upd({ paid: e.target.value }); }} /></label>
            </div>
            {extra.map((r, n) => (
              <div key={n} className="fields" style={{ marginTop: 6 }}>
                <label className="f">第 {n + 2} 個帳號後五碼<input id={`p-x5-${n}`} value={r.last5} maxLength={5} inputMode="numeric" onChange={(e) => { setExtra(extra.map((x, m) => m === n ? { ...x, last5: e.target.value.replace(/\D/g, '') } : x)); setErr(''); }} /></label>
                <label className="f">金額<span className="row" style={{ flexWrap: 'nowrap' }}><input id={`p-xa-${n}`} value={r.amount} inputMode="numeric" onChange={(e) => { setExtra(extra.map((x, m) => m === n ? { ...x, amount: e.target.value } : x)); setErr(''); }} />
                  <button type="button" className="btn small" aria-label="刪除這筆" onClick={() => setExtra(extra.filter((_, m) => m !== n))}>✕</button></span></label>
              </div>
            ))}
            {extra.length < 4 && <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => setExtra([...extra, { last5: '', amount: '' }])}>＋用了兩個以上帳號匯款，再加一筆</button>}
            {extra.length > 0 && <div className="small" style={{ marginTop: 4 }}>匯款合計 <b>{money(paidSum)}</b>{paidSum !== total && <span style={{ color: 'var(--red)' }}>（應付 {money(total)}）</span>}</div>}
            <div style={{ marginTop: 12 }}>
              <h3 style={{ margin: '0 0 6px' }}>發票</h3>
              <div className="row">
                <label className="check"><input type="radio" name="inv" checked={inv.type !== 'company'} onChange={() => { setInv({ type: 'member', code: '', title: '' }); setErr(''); }} />二聯（個人）</label>
                <label className="check"><input type="radio" name="inv" checked={inv.type === 'company'} onChange={() => { setInv({ type: 'company', code: '', title: '' }); setErr(''); }} />三聯（公司）</label>
              </div>
              {inv.type === 'company' && (
                <div className="fields" style={{ marginTop: 6 }}>
                  <label className="f">公司名稱<input id="p-inv-title" value={inv.title} maxLength={60} onChange={(e) => { setInv({ ...inv, title: e.target.value }); setErr(''); }} /></label>
                  <label className="f">統一編號<input id="p-inv" value={inv.code} maxLength={8} inputMode="numeric" placeholder="8 位數字"
                    onChange={(e) => { setInv({ ...inv, code: e.target.value.replace(/\D/g, '') }); setErr(''); }} /></label>
                </div>
              )}
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
