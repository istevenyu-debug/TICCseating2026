'use client';

import { useCallback, useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';
import { invProblem, type InvType } from '@/lib/invoiceRules';
import SeatMap from './SeatMap';
import type { BookingState } from '@/lib/booking';
type Seat = BookingState['seats'][number];

type Menu = {
  open: boolean;
  mailFrom: string;
  pushLink: boolean;
  line: { groups: { name: string; url: string }[]; map: Record<string, number> };
  invoice: boolean;
  event: { name: string; showAt: string; bankName: string; bankAccount: string; accountName: string };
  intro: string;
  items: { kind: 'combo' | 'zone'; id: number; name: string; desc: string; unit: string; zoneIds: number[]; status: 'open' | 'waitlist' | 'full' }[];
  map: { vipInstalled: boolean; seats: Seat[]; zones: { id: number; name: string; color: string; gift: boolean }[] } | null;
};
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

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
type Mine = { token: string; no: string; status: string; items: string; createdAt: string; email: string; url: string | null };
const MINE_STATUS: Record<string, string> = { submitted: '等待主辦方確認收款', confirmed: '已確認收款', cancelled: '已取消' };

/** 這台裝置的訂單進度：確認收款後提醒查看 Email（劃位連結只用 Email 寄送） */
function MyPreorders({ mine, reload }: { mine: Mine[]; reload: () => void }) {
  if (!mine.length) return null;
  return (
    <div className="card">
      <h2>您在這支手機送出的贊助登記 <button className="btn small" onClick={reload}>重新整理</button></h2>
      {mine.map((m) => (
        <div key={m.token} className="note" style={{ marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b className="mono">{m.no}</b>
            <span className={`pill ${m.status === 'confirmed' ? 'p-paid' : m.status === 'cancelled' ? 'p-cancelled' : 'p-pending'}`}>{MINE_STATUS[m.status] ?? m.status}</span>
          </div>
          <div className="small muted">{m.items}</div>
          {m.url
            ? <><a className="btn pri" style={{ display: 'block', textAlign: 'center', marginTop: 8 }} href={m.url}>開始劃位（選座位）</a>
                <div className="small muted" style={{ marginTop: 4 }}>劃位連結也已寄到您的 Email（{m.email}）。</div></>
            : m.status === 'confirmed'
            ? <div className="note ok small" style={{ marginTop: 8 }}>已輪到您劃位。<b>劃位連結已寄到您的 Email（{m.email}）</b>，請到信箱點連結選位；沒看到請看看垃圾郵件匣，或聯繫主辦方。</div>
            : m.status === 'submitted' && <div className="small" style={{ marginTop: 4 }}>主辦方確認款項、並依送單順序輪到您時，會把劃位連結寄到您的 Email（{m.email}）。</div>}
        </div>
      ))}
    </div>
  );
}

/** 開頭文字（後台可編輯）：「## 」開頭為小標題，「1. 」開頭為步驟，空行分段 */
function Intro({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  return <div style={{ marginTop: 10 }}>{blocks.map((b, n) => {
    const lines = b.split('\n').filter((x) => x.trim());
    const out: React.ReactNode[] = [];
    let list: string[] = [];
    const flush = () => { if (list.length) { out.push(<ol key={`o${out.length}`} style={{ margin: '0 0 8px', paddingLeft: 22, lineHeight: 1.8 }}>{list.map((x, k) => <li key={k}>{x}</li>)}</ol>); list = []; } };
    for (const l of lines) {
      if (/^##\s*/.test(l)) { flush(); out.push(<h3 key={`h${out.length}`} style={{ margin: '14px 0 6px', color: '#7a5a1e' }}>{l.replace(/^##\s*/, '')}</h3>); }
      else if (/^\d+[.、]\s*/.test(l)) list.push(l.replace(/^\d+[.、]\s*/, ''));
      else { flush(); out.push(<p key={`p${out.length}`} style={{ margin: '0 0 6px', lineHeight: 1.8 }}>{l}</p>); }
    }
    flush();
    return <div key={n} style={{ marginBottom: 6 }}>{out}</div>;
  })}</div>;
}

/** 預購單（公開）：選購（不劃位）→ 匯款 → 填資料回傳；主辦方確認收訖後寄出專屬劃位連結 */
export default function PreorderApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [f, setF] = useState({ name: '', phone: '', email: '', paid: '', last5: '', lineName: '', agree: false });
  const [extra, setExtra] = useState<{ last5: string; amount: string }[]>([]); // 第二個以上的匯款帳號
  const [restored, setRestored] = useState<boolean | null>(null);
  const [hl, setHl] = useState<string | null>(null); // 座位圖上要亮起哪個項目的區域
  const [lineOpened, setLineOpened] = useState<string[]>([]);
  const [lineJoined, setLineJoined] = useState<string[]>([]);
  const [paidTouched, setPaidTouched] = useState(false);
  const [inv, setInv] = useState<{ type: InvType; code: string; title: string }>({ type: 'member', code: '', title: '' });
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ no: string; token: string; waitlist: number | null } | null>(null);
  const [mismatch, setMismatch] = useState('');
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
  // 選了哪些項目，就要加入對應的 LINE 群（不重複、依後台設定順序）
  const lineIdx = new Set(lines.map((i) => menu.line.map[`${i.kind}:${i.id}`]).filter((x) => x !== undefined));
  const lineGroups = menu.line.groups.filter((_, n) => lineIdx.has(n));
  const paid = f.paid; // 贊助金額：買方自己填，不幫他算、不顯示任何金額
  const remits = [{ last5: f.last5.trim(), amount: parseInt(paid.replace(/\D/g, '')) || 0 }, ...extra.map((r) => ({ last5: r.last5.trim(), amount: parseInt(r.amount.replace(/\D/g, '')) || 0 }))];
  const setN = (i: Menu['items'][number], n: number) => { setQty({ ...qty, [key(i)]: i.status === 'full' ? 0 : Math.max(0, Math.min(200, n)) }); setErr(''); };
  const upd = (v: Partial<typeof f>) => { setF({ ...f, ...v }); setErr(''); };

  function next(e: React.FormEvent) {
    e.preventDefault();
    const bad = (m: string, id?: string) => { setErr(m); if (id) document.getElementById(id)?.focus(); };
    if (!lines.length) return bad('請先選擇至少一項贊助方案');
    if (!f.name.trim()) return bad('請填寫身分證上的姓名', 'p-name');
    const pp = f.phone.trim() ? phoneProblem(f.phone) : '請填寫手機';
    if (pp) return bad(pp, 'p-phone');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return bad('Email 格式不正確，劃位連結會寄到這個信箱', 'p-email');
    if (!(parseInt(paid.replace(/\D/g, '')) > 0)) return bad('請填寫贊助金額', 'p-paid');
    if (!/^\d{5}$/.test(f.last5.trim())) return bad('匯款帳號末 5 碼應為 5 位數字', 'p-last5');
    for (const [n, r] of extra.entries()) {
      if (!/^\d{5}$/.test(r.last5.trim())) return bad(`第 ${n + 2} 筆匯款：帳號末 5 碼應為 5 位數字`, `p-x5-${n}`);
      if (!(parseInt(r.amount.replace(/\D/g, '')) > 0)) return bad(`第 ${n + 2} 筆：請填寫贊助金額`, `p-xa-${n}`);
    }
    { const ip = invProblem(inv.type, inv.code.toUpperCase(), inv.title); if (ip) return bad(ip, inv.type === 'company' && !inv.title.trim() && inv.code.trim() ? 'p-inv-title' : 'p-inv'); }
    if (!f.agree) return bad('請勾選同意個資蒐集', 'p-agree');
    const miss = lineGroups.find((g) => !lineJoined.includes(g.name));
    if (miss) return bad(`請先加入「${miss.name}」並勾選「我已加入」（已經在群裡的，直接打勾即可）`, `p-line-${lineGroups.indexOf(miss)}`);
    setErr(''); setReview(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function send(confirmMismatch = false) {
    setBusy(true); setMismatch('');
    const r = await api<{ no: string; token: string; waitlist: number | null }>({
      items: menu!.items.map((i) => ({ kind: i.kind, id: i.id, qty: qty[key(i)] ?? 0 })),
      name: f.name.trim(), phone: f.phone, email: f.email.trim(), agree: f.agree, lineName: f.lineName.trim(),
      remits: remits.map((r) => ({ last5: r.last5, amount: r.amount })), lineJoined: lineGroups.map((g) => g.name).filter((n) => lineJoined.includes(n)),
      invType: inv.type, invCode: inv.type === 'company' ? inv.code.trim() : '', invTitle: inv.type === 'company' ? inv.title.trim() : '',
      confirmMismatch,
    });
    setBusy(false);
    if (!r.ok && r.code === 'AMOUNT_MISMATCH') { setMismatch(r.message); return; } // 留在確認畫面，讓他選「返回修改」或「確認送出」
    if (!r.ok) { setReview(false); setErr(r.message); return; }
    addSaved({ token: r.data.token, no: r.data.no });
    clearDraft();
    setDone(r.data); window.scrollTo({ top: 0 });
  }

  const head = (
    <div className="card">
      <h1>{menu.event.name}</h1>
      <div className="muted">{fmtDate(menu.event.showAt)}・台北國際會議中心 大會堂</div>
      <Intro text={menu.intro} />
    </div>
  );

  if (done) {
    return (
      <main className="wrap" style={{ maxWidth: 640 }}>
        <div className="card" style={{ borderTop: '4px solid var(--ok)' }}>
          {done.waitlist
            ? <><h2>🙏 已收到您的登記（{done.no}）</h2><p>目前為<b>候補第 {done.waitlist} 位</b>。有名額釋出時，我們會依序與您聯繫，感恩您的耐心等候。</p></>
            : <><h2>🙏 已收到您的贊助登記（{done.no}）</h2><p>感恩您的護持。主辦方確認款項、並依登記順序輪到您時，會把專屬劃位連結寄到 <b>{f.email.trim()}</b>，請留意信箱。</p></>}
          <p className="note warn">劃位通知信可能被歸到<b>垃圾郵件匣</b>，沒看到請到垃圾郵件匣找找看。{menu.mailFrom && <>建議先把寄件信箱 <b className="mono">{menu.mailFrom}</b> 加入聯絡人。</>}</p>
          <p className="small muted" style={{ marginBottom: 0 }}>確認信已寄出。之後用<b>這支手機</b>回到這個網頁，就能看到登記進度。如需修改或取消，請聯繫主辦方並提供登記編號 {done.no}。</p>
        </div>
        {head}

      </main>
    );
  }

  if (!menu.open) return <main className="wrap" style={{ maxWidth: 640 }}>{head}<MyPreorders mine={mine} reload={reload} /><div className="note" style={{ fontSize: 16, textAlign: 'center', padding: 16 }}>目前尚未開放贊助登記，敬請期待。</div></main>;

  return (
    <main className="wrap" style={{ maxWidth: 640 }}>
      {head}
      <MyPreorders mine={mine} reload={reload} />
      {restored && !review && lines.length > 0 && (
        <div className="note ok">歡迎回來，您上次選的是 <b>{lines.map((i) => `${i.name} × ${qty[key(i)]}`).join('、')}</b>。匯好了嗎？請在下面填帳號後五碼送出。
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
            <span className="muted">匯款帳號後五碼</span><span className="mono">{remits.map((r) => r.last5).join('、')}</span>
            <span className="muted">發票</span><span>{inv.type === 'company' ? `三聯：${inv.title.trim()}（統編 ${inv.code.trim()}）` : '二聯（個人）'}</span>
          </div>
          <h3>贊助方案</h3>
          <div className="sellist">{lines.map((i) => <div className="selitem" key={key(i)}><span>{i.name}</span><span>× {qty[key(i)]} {i.unit}</span></div>)}</div>
          <p className="small muted" style={{ margin: '10px 0 0' }}>請用<b>自己的手機</b>送出：送出後，用這支手機回到本頁就能查看登記進度。</p>
          {err && <div className="note err" style={{ marginTop: 10 }}>{err}</div>}
          {mismatch ? (
            <div className="note warn" style={{ marginTop: 12 }}>
              <b>{mismatch}</b>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" disabled={busy} onClick={() => { setMismatch(''); setReview(false); }}>返回修改</button>
                <button className="btn pri" disabled={busy} onClick={() => send(true)}>{busy ? '送出中…' : '我已確認無誤，送出'}</button>
              </div>
            </div>
          ) : (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn pri" style={{ flex: 1 }} disabled={busy} onClick={() => send()}>{busy ? '送出中…' : '資料正確，確認送出'}</button>
            <button className="btn" disabled={busy} onClick={() => setReview(false)}>返回修改</button>
          </div>)}
        </div>
      ) : (
        <form onSubmit={next} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {menu.map && (() => {
            const pick = hl ? menu.items.filter((i) => key(i) === hl) : lines;
            const zs = new Set(pick.flatMap((i) => i.zoneIds));
            return (
              <div>
                <div className="small" style={{ margin: '0 0 6px' }}>{pick.length ? <>亮起來的是 <b>{pick.map((i) => i.name).join('、')}</b> 的座位區，其他區淡化。</> : '點下面的項目，座位圖會亮起它的座位區。'}</div>
                <SeatMap view seats={menu.map.seats} zones={menu.map.zones} vipInstalled={menu.map.vipInstalled} selected={new Set()} onToggle={() => undefined} locked
                  allowed={zs.size ? zs : undefined} />
              </div>
            );
          })()}
          <div className="card">
            <h2>一、贊助方案</h2>
            {menu.items.map((i) => (
              <div key={key(i)} className="selitem" style={{ alignItems: 'center', padding: '8px 0' }}>
                <span style={{ cursor: 'pointer' }} onClick={() => setHl(hl === key(i) ? null : key(i))}>
                  <b>{i.name}</b>{hl === key(i) && <span className="small" style={{ color: 'var(--accent)' }}>（座位圖已亮起）</span>}<br />
                  <span className="small">方案內容：{i.desc}</span><br />
                  <span className="small muted">座位參考：</span>
                  {[...new Set(i.zoneIds)].map((z) => menu.map?.zones.find((x) => x.id === z)).filter(Boolean).map((z) => (
                    <span key={z!.id} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
                      <i style={{ width: 12, height: 12, borderRadius: 3, background: z!.color, display: 'inline-block' }} />{z!.name}</span>))}
                  <span className="small" style={{ color: 'var(--accent)' }}>查看座位 ›</span>
                  {i.status === 'waitlist' && <div className="small" style={{ color: '#9a6700', marginTop: 4 }}>目前名額已滿，仍可登記候補，有名額釋出時我們會依序與您聯繫。</div>}
                  {i.status === 'full' && <div className="small" style={{ color: 'var(--muted)', marginTop: 4 }}>感謝您的護持，此方案名額已圓滿。歡迎留意其他方案，或直接與我們聯繫。</div>}
                </span>
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className="btn" aria-label={`減少 ${i.name}`} onClick={() => setN(i, (qty[key(i)] ?? 0) - 1)}>−</button>
                  <input aria-label={`${i.name} 數量`} value={qty[key(i)] ?? 0} inputMode="numeric" style={{ width: 52, textAlign: 'center' }}
                    onChange={(e) => setN(i, parseInt(e.target.value.replace(/\D/g, '')) || 0)} />
                  <button type="button" className="btn" aria-label={`增加 ${i.name}`} disabled={i.status === 'full'} onClick={() => setN(i, (qty[key(i)] ?? 0) + 1)}>＋</button>
                </span>
              </div>
            ))}
            {lines.length > 0 && <div className="small" style={{ marginTop: 8 }}>已選：{lines.map((i) => `${i.name} × ${qty[key(i)]} ${i.unit}`).join('、')}</div>}
          </div>

          {lineGroups.length > 0 && (
            <div className="card">
              <h2>二、加入 LINE 專屬群組</h2>
              <p className="small" style={{ margin: 0 }}>請依您選擇的贊助項目，加入對應的 LINE 群組（完成後才能送出）。加入後請<b>回到這個頁面</b>繼續（iPhone 按左上角返回；在 LINE 裡打開的，請再點一次預購單連結，資料都還在）。</p>
              {lineGroups.map((g, n) => {
                const opened = lineOpened.includes(g.name);
                return (
                  <div key={g.name} style={{ marginTop: 10 }}>
                    <a className="btn pri" href={g.url} target="_blank" rel="noreferrer" style={{ background: '#06c755', borderColor: '#06c755', display: 'inline-block' }}
                    onClick={() => { if (!opened) setLineOpened([...lineOpened, g.name]); setErr(''); }}>① 加入「{g.name}」</a>
                    <label className="check" style={{ marginTop: 6 }}>
                    <input id={`p-line-${n}`} type="checkbox" checked={lineJoined.includes(g.name)}
                      onChange={(e) => { setLineJoined(e.target.checked ? [...lineJoined, g.name] : lineJoined.filter((x) => x !== g.name)); setErr(''); }} />
                    <span>② 我已加入「{g.name}」<br /><span className="small muted">{opened ? '加入後回到這裡打勾' : '已經在群裡的，直接打勾即可'}</span></span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          <div className="card">
            <h2>{lineGroups.length ? '三' : '二'}、完成匯款</h2>
            <div className="bank">
              <span className="muted">銀行</span><span>{menu.event.bankName || '（主辦方尚未設定）'}</span>
              <span className="muted">帳號</span><span className="mono">{menu.event.bankAccount}</span>
              <span className="muted">戶名</span><span>{menu.event.accountName}</span>
            </div>
            <button type="button" className="btn small" style={{ marginTop: 6 }} disabled={!menu.event.bankAccount}
              onClick={() => navigator.clipboard?.writeText(menu.event.bankAccount.replace(/-/g, '')).catch(() => undefined)}>複製帳號</button>
          </div>

          <div className="card">
            <h2>{lineGroups.length ? '四' : '三'}、填寫回報資料</h2>
            <label className="f">姓名（與身分證相同）<input id="p-name" value={f.name} autoComplete="name" onChange={(e) => upd({ name: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">手機<input id="p-phone" value={f.phone} maxLength={13} inputMode="tel" autoComplete="tel" placeholder="09xxxxxxxx"
                style={phoneProblem(f.phone) ? { borderColor: 'var(--red)' } : undefined} onChange={(e) => upd({ phone: e.target.value })} />
                {phoneProblem(f.phone) && <span className="small" style={{ color: 'var(--red)' }}>{phoneProblem(f.phone)}</span>}</label>
              <label className="f">Email（劃位連結寄到這裡）<input id="p-email" type="email" value={f.email} autoComplete="email" onChange={(e) => upd({ email: e.target.value })} />
                <span className="small muted">建議填 Gmail 等個人信箱，公司或學校信箱可能收不到通知。</span></label>
            </div>
            <label className="f" style={{ marginTop: 8 }}>LINE 顯示名稱（選填，方便主辦方在群裡找到您）<input value={f.lineName} maxLength={40} onChange={(e) => upd({ lineName: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">匯款帳號後五碼<input id="p-last5" value={f.last5} maxLength={5} inputMode="numeric" onChange={(e) => upd({ last5: e.target.value.replace(/\D/g, '') })} /></label>
              <label className="f">贊助金額<input id="p-paid" value={paid} inputMode="numeric" onChange={(e) => { setPaidTouched(true); upd({ paid: e.target.value }); }} /></label>
            </div>
            {extra.map((r, n) => (
              <div key={n} className="fields" style={{ marginTop: 6 }}>
                <label className="f">第 {n + 2} 個帳號後五碼<input id={`p-x5-${n}`} value={r.last5} maxLength={5} inputMode="numeric" onChange={(e) => { setExtra(extra.map((x, m) => m === n ? { ...x, last5: e.target.value.replace(/\D/g, '') } : x)); setErr(''); }} /></label>
                <label className="f">贊助金額<span className="row" style={{ flexWrap: 'nowrap' }}><input id={`p-xa-${n}`} value={r.amount} inputMode="numeric" onChange={(e) => { setExtra(extra.map((x, m) => m === n ? { ...x, amount: e.target.value } : x)); setErr(''); }} />
                  <button type="button" className="btn small" aria-label="刪除這筆" onClick={() => setExtra(extra.filter((_, m) => m !== n))}>✕</button></span></label>
              </div>
            ))}
            {extra.length < 4 && <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => setExtra([...extra, { last5: '', amount: '' }])}>＋再加一筆匯款</button>}
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
              我同意主辦方為票務、對帳及實名入場核對之目的，蒐集與處理上述個人資料。
            </label>
            {err && <div className="note err" style={{ marginTop: 10 }}>{err}</div>}
            <button className="btn pri" type="submit" style={{ width: '100%', marginTop: 12 }}>下一步：確認資料</button>
          </div>
        </form>
      )}
    </main>
  );
}
