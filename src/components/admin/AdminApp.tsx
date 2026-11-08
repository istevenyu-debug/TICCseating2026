'use client';

import Floor3Tab from './Floor3Tab';
import { createContext, Fragment, useCallback, useContext, useEffect, useState } from 'react';
import type { AdminState } from '@/lib/admin';
import { inkFor } from '@/lib/color';
import { comboDesc, comboQty } from '@/lib/pricing';
import { phoneProblem } from '@/lib/validation';
import { APP_VERSION } from '@/lib/version';
import { bundleIndex } from '@/lib/bundle';
import { parseRemits, pasteToGrid, reconcile } from '@/lib/reconcile';
import { invItemName, invLabel } from '@/lib/invName';
import { createPortal } from 'react-dom';
import AdminMap, { type SeatLook } from './AdminMap';
import { INV_TYPES } from '@/lib/invoiceRules';
import { appsScript } from '@/lib/formScript';
import { leaderboard } from '@/lib/leaderboard';

type NotifyPublic = {
  email: { host: string; port: number; user: string; fromName: string; passSet: boolean; ready: boolean };
  sms: { url: string; user: string; passSet: boolean; ready: boolean };
};
type Notice = { id: number; orderId: number | null; channel: string; template: string; recipient: string; content: string; status: string; error: string | null; attempts: number; createdAt: string; sentAt: string | null; sendAfter: string | null };
type Pre = { id: number; no: string; items: { kind: string; id: number; name: string; price: number; qty: number }[]; amount: number; name: string; phone: string; email: string;
  paidAmount: number; last5: string; status: string; note: string; createdAt: string; confirmedAt: string | null; confirmedBy: string | null; isNew: boolean; linkCode: string | null; invoice: string; source: string; answers: { q: string; a: string }[]; invType: string; invTitle: string; invCode: string; seq: number | null; lineName: string; waitlist: boolean; paidOkAt: string | null; paidOkBy: string | null; lineOk: string[]; released: string[]; needGroups: Record<string, string[]>; progress: { left: number; held: number; pending: number; paid: number } | null; invoiceState: { status: string; invoiceNo: string; checks: number } | null };
type Gate = { id: number; name: string; token: string; active: boolean; count: number };
type Checkins = { total: number; entered: number; recent: { id: number; serial: string; at: string; manual: boolean; gate: string; seatId: string; holder: string | null }[] };
type EinvPublic = { enabled: boolean; mode: 'mock' | 'test' | 'prod'; timing: 'auto' | 'review'; merchantId: string; keySet: boolean; ivSet: boolean; taxType: string; itemName: string; log: { at: string; actor: string; detail: string }[] };
type Inv = { id: number; orderNo: string; status: string; env: string; invoiceNo: string; invoiceDate: string; randomNumber: string; amount: number; buyer: string; checks: string[]; error: string | null;
  issuedBy: string | null; voidReason: string | null; lines: { name: string; qty: number; unit: string; price: number; amount: number }[]; name: string; phone: string; email: string; paidAmount: number | null; invType: string; invCode: string; invTitle: string; preorderId: number | null; confirmedAt: string | null };
type Bank = { id: number; at: string; amount: number; last5: string; memo: string; ignored: boolean };
type State = AdminState & { bank: Bank[]; user: { username: string; displayName: string; role: string }; notify: NotifyPublic; einvoice: EinvPublic; invoices: Inv[]; pushLink: boolean; backups: { dir: string; count: number; list: { name: string; size: number; at: string }[] }; vips: Awaited<ReturnType<typeof import('@/lib/vip').listVips>>; notifications: Notice[]; preorders: Pre[]; flowImage: string | null; preorderSettings: { rateLimit: number; waitlistCap: number; intro: string; defaultIntro: string }; line: { groups: { name: string; url: string }[]; map: Record<string, number> }; preMenu: { kind: 'combo' | 'zone'; id: number; name: string; price: number; desc: string; unit: string }[]; form: { key: string; base: string }; audit: { id: number; at: string; actor: string; action: string; what: string; target: string }[]; gates: Gate[]; checkins: Checkins; floor3: Awaited<ReturnType<typeof import('@/lib/card').floor3State>> };
type Delivery = { channel: string; status: string; error: string | null }[];
const N_STATUS: Record<string, string> = { queued: '寄送中', sent: '已寄出', failed: '寄送失敗', simulated: '未寄出（尚未設定）' };
const CH: Record<string, string> = { sms: '簡訊', email: 'Email', push: 'App 推播' };
const nStatus = (ch: string, st: string) => (ch === 'push' ? ({ sent: '已送達手機', simulated: '僅顯示在購票頁' } as Record<string, string>)[st] : undefined) ?? N_STATUS[st] ?? st;
const N_TEMPLATE: Record<string, string> = { preorder_received: '收到訂單', preorder_link: '寄出劃位連結', preorder_cancelled: '訂單取消', invite: '劃位連結', order_received: '收到劃位資料', order_confirmed: '劃位成功', order_cancelled: '劃位取消', order_expired: '劃位逾時' };
/** 例：「簡訊已寄出、Email 寄送失敗：帳號或密碼錯誤」 */
function deliveryText(d: Delivery | undefined) {
  if (!d?.length) return { text: '', bad: false };
  const email = d.find((x) => x.channel === 'email');
  const sms = d.find((x) => x.channel === 'sms');
  const push = d.find((x) => x.channel === 'push');
  const line = (x: { status: string; error: string | null } | undefined, name: string) => !x ? '' :
    x.status === 'sent' ? `✓ ${name}已寄出` : x.status === 'simulated' ? `✗ ${name}沒有寄出（${name === 'Email' ? '尚未設定 Gmail' : '尚未設定簡訊帳號'}）`
      : x.status === 'failed' ? `✗ ${name}寄送失敗：${x.error ?? ''}` : x.error ? `✗ ${name}暫時寄不出（${x.error}），系統會再試` : `${name}寄送中（稍後自動寄出）`;
  const parts = [line(email, 'Email'), line(sms, '簡訊'), push?.status === 'sent' ? '✓ 手機通知已送達' : ''].filter(Boolean);
  // Email 沒寄出就以紅色提醒（簡訊未設定不算，可能本來就不用）
  const bad = !!email && (email.status === 'failed' || email.status === 'simulated' || !!email.error);
  return { text: `${parts.join('；')}。${bad ? '請到「八、通知設定」設定 Gmail 後，在通知紀錄按「重寄」。' : ''}（訊息也已顯示在對方的購票頁）`, bad };
}
type Seat = State['seats'][number];
type Order = State['orders'][number];
type Tab = 'home' | 'usage' | 'price' | 'groups' | 'pre' | 'links' | 'orders' | 'tickets' | 'notify' | 'gates' | 'einv' | 'vip' | 'floor3';

const TABS: [Tab, string][] = [
  ['home', '首頁'], ['usage', '一、席位用途'], ['price', '二、價格設定'], ['groups', '三、連座分組'], ['pre', '四、訂單核帳'],
  ['links', '五、劃位專屬連結'], ['orders', '六、劃位確認'], ['tickets', '七、紙本入場券'], ['notify', '八、通知設定'], ['gates', '九、驗票'],
  ['einv', '十、電子發票'], ['vip', '十一、招待'], ['floor3', '三樓售票'],
];
const COLOR_PRESETS = [
  '#b8ccf3', '#c4e5cf', '#f0dbb1', '#e6c3e5', '#bde2ea', '#f5c4c4', '#d9e7a8', '#c9c2f0', '#ffd29d',
  '#ffadad', '#9fd8c8', '#d3d3d3', '#4f7bd8', '#2f9a62', '#d9822b', '#c0392b', '#8e44ad', '#555e70',
];
const USAGE_COLOR: Record<string, string> = { sale: '#dfe5f1', 'hold-pr': '#f5c6a5', 'hold-sponsor': '#cdbdf2', closed: '#ffffff' };
const STATUS: Record<string, string> = { held: '選位中・填寫資料', pending: '待確認劃位', paid: '劃位成功', cancelled: '已取消', expired: '逾時取消' };
const BLOCKS: [string, string][] = [['L2', '左側區'], ['L1', '左區'], ['C0', '中區'], ['R1', '右區'], ['R2', '右側區']];

const money = (n: number) => `NT$${(n || 0).toLocaleString('en-US')}`;
const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const toDateInput = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : '');
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000); // 台北時間
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(`${v}:00+08:00`).toISOString() : null);

function rowsText(set: Set<number>) {
  const n = [...set].filter((x) => x > 0).sort((a, b) => a - b), p: string[] = [];
  for (let i = 0; i < n.length;) { let j = i; while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++; p.push(i === j ? `${n[i]}` : `${n[i]}-${n[j]}`); i = j + 1; }
  if (set.has(0)) p.unshift('VIP');
  if (set.has(-1)) p.push('輪椅');
  return p.join(', ');
}
function parseRows(t: string) {
  const set = new Set<number>(), bad: string[] = [];
  t.split(/[\s,，、]+/).filter(Boolean).forEach((x) => {
    const u = x.toUpperCase();
    if (u === 'VIP' || u === 'V') set.add(0);
    else if (x === '輪椅' || u === 'WC') set.add(-1);
    else {
      const m = u.match(/^(\d{1,2})(?:[-~－到](\d{1,2}))?$/);
      if (!m) { bad.push(x); return; }
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b < 1 || a > 12 || b > 12) { bad.push(x); return; }
      for (let r = Math.min(a, b); r <= Math.max(a, b); r++) set.add(r);
    }
  });
  return { set, bad };
}

type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
interface Ctx {
  st: State; act: Act; busy: boolean; sure: string | null; confirm2: (key: string, fn: () => void) => void; go: (t: Tab) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
  zoneById: Record<number, State['zones'][number]>; usageById: Record<number, State['usages'][number]>; now: number;
  filter: string; setFilter: (v: string) => void; openId: number | null; setOpenId: (id: number | null) => void; openOrder: (o: Order) => void;
}
const AdminCtx = createContext<Ctx | null>(null);
const useAdmin = () => useContext(AdminCtx)!;

export default function AdminApp() {
  const [st, setSt] = useState<State | null>(null);
  const [empty, setEmpty] = useState(false); // 全新的系統（雲端剛建好）：還沒有場次，先上傳備份
  const [tab, setTab] = useState<Tab>('home');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  useEffect(() => { if (msg?.kind !== 'ok') return; const id = setTimeout(() => setMsg(null), 6000); return () => clearTimeout(id); }, [msg]);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null); // 二次確認的按鈕
  const [, tick] = useState(0);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/state', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (!r) { setMsg({ kind: 'err', text: '網路連線異常，請稍後再試。' }); return; }
    if (!r.ok) { if (r.code === 'UNAUTHORIZED') location.reload(); else if (r.code === 'NO_EVENT') setEmpty(true); else setMsg({ kind: 'err', text: r.message }); return; }
    setEmpty(false); setSt(r.data);
  }, []);

  useEffect(() => {
    load();
    const p = setInterval(load, 15_000);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, [load]);

  useEffect(() => {
    const fromHash = () => { const h = location.hash.slice(1) as Tab; setTab(TABS.some(([k]) => k === h) ? h : 'home'); };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  const go = (t: Tab) => { location.hash = t; setTab(t); setSure(null); window.scrollTo({ top: 0 }); };

  async function act(body: Record<string, unknown>, ok?: string) {
    setBusy(true); setSure(null);
    const r = await fetch('/api/admin/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((x) => x.json()).catch(() => ({ ok: false, message: '網路連線異常，請稍後再試。' }));
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.message }); await load(); return null; }
    if (ok) setMsg({ kind: 'ok', text: ok });
    await load();
    return r.data ?? true;
  }
  const confirm2 = (key: string, fn: () => void) => { if (sure === key) fn(); else setSure(key); };

  if (!st && empty) return <main className="wrap" style={{ maxWidth: 640 }}><EmptyRestore onDone={load} /></main>;
  if (!st) return <main className="wrap"><div className="card muted">後台載入中…</div></main>;

  const zoneById = Object.fromEntries(st.zones.map((z) => [z.id, z]));
  const usageById = Object.fromEntries(st.usages.map((u) => [u.id, u]));
  const now = Date.now();
  const heldOrders = st.orders.filter((o) => o.status === 'held');
  const openOrder = (o: Order) => { setOpenId(o.id); if (o.isNew) act({ action: 'order.seen', id: o.id }); };
  const ctx: Ctx = { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder };

  return (
    <AdminCtx.Provider value={ctx}>
    <main className="wrap">
      <header className="top">
        <div>
          <h1>大會堂劃位後台</h1>
          <div className="small muted">{st.event.name}・{tw(st.event.showAt)}・{st.user.displayName}・<span title="系統版本">{APP_VERSION}</span></div>
        </div>
        <div className="row">
          <a className="btn" href="/" target="_blank" rel="noreferrer">網站首頁</a>
          <button className="btn" onClick={async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.reload(); }}>登出</button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map(([k, n]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {n}{k === 'orders' && st.orders.some((o) => o.status === 'pending') ? <span className="badge" title="等你確認">{st.orders.filter((o) => o.status === 'pending').length}</span> : null}
            {k === 'pre' && st.preorders.some(needsCheck) ? <span className="badge" title="待核帳">{st.preorders.filter(needsCheck).length}</span> : null}
            {k === 'links' && st.preorders.some((p) => p.status === 'confirmed' && inProgress(p)) ? <span className="badge" title="劃位中">{st.preorders.filter((p) => p.status === 'confirmed' && inProgress(p)).length}</span> : null}
            {k === 'notify' && (!st.notify.email.ready || !st.notify.sms.ready || st.notifications.some((x) => x.status === 'failed')) ? <span className="badge">!</span> : null}
          </button>
        ))}
      </nav>

      {msg && <div className={`note ${msg.kind}`} role="status" onClick={() => setMsg(null)}
        style={{ position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 50, maxWidth: 'min(560px, calc(100vw - 32px))', boxShadow: '0 6px 24px rgba(0,0,0,.18)', cursor: 'pointer' }}>{msg.text}</div>}

      {(st.event.name === '請在後台填寫演出名稱' || !st.event.bankAccount) && (
        <div className="alertbar">
          <span><b>請先填寫場次資料</b>：{[st.event.name === '請在後台填寫演出名稱' && '演出名稱與時間', !st.event.bankAccount && '匯款帳戶'].filter(Boolean).join('、')}尚未設定，消費者的購票頁會顯示空白。</span>
          <button className="btn pri" onClick={() => go('price')}>前往填寫</button>
        </div>
      )}
      {st.preorders.some((x) => x.isNew) && (
        <div className="alertbar">
          <span><b>有 {st.preorders.filter((x) => x.isNew).length} 張新訂單</b>，請核帳後勾「已匯款」「已入群」；輪到時按「發出劃位連結」才會寄出。</span>
          <button className="btn pri" onClick={() => go('pre')}>前往訂單</button>
        </div>
      )}
      {st.stats.newOrders > 0 && (
        <div className="alertbar">
          <span><b>有 {st.stats.newOrders} 筆新劃位已送出</b>，請核對座位與持票人後按「確認劃位」，系統會寄出 QR code。</span>
          <button className="btn pri" onClick={() => { const o = st.orders.find((x) => x.isNew); go('orders'); if (o) openOrder(o); }}>立即查看</button>
        </div>
      )}
      {heldOrders.length > 0 && (
        <div className="alertbar soft">
          <span>目前有 {heldOrders.length} 筆暫存中（消費者正在填寫資料），座位已先保留。</span>
          <button className="btn" onClick={() => { setFilter('held'); go('orders'); }}>查看暫存</button>
        </div>
      )}

      <div className="stats">
        <div className="stat"><b>{st.stats.total}</b><span>本場席位</span></div>
        <div className="stat"><b>{st.stats.sale}</b><span>可售剩餘</span></div>
        <div className="stat"><b style={{ color: 'var(--accent)' }}>{st.stats.held}</b><span>暫存中</span></div>
        <div className="stat"><b style={{ color: 'var(--warn)' }}>{st.stats.pending}</b><span>待確認劃位</span></div>
        <div className="stat"><b style={{ color: 'var(--ok)' }}>{st.stats.sold}</b><span>已售出</span></div>
        <div className="stat"><b>{st.stats.reserved}</b><span>保留／不開放</span></div>
        <div className="stat"><b>{money(st.stats.revenue)}</b><span>已到帳金額</span></div>
        {st.stats.vipSeats > 0 && <div className="stat"><b>{st.stats.vipSeats}</b><span>招待席（不算收入）</span></div>}
      </div>

      {tab === 'home' && <Home />}
      {tab === 'usage' && <Usage />}
      {tab === 'price' && <Price />}
      {tab === 'groups' && <Groups />}
      {tab === 'pre' && <Preorders />}
      {tab === 'gates' && <Gates />}
      {tab === 'links' && <Links />}
      {tab === 'orders' && <Orders />}
      {tab === 'tickets' && <Tickets />}
      {tab === 'einv' && <Invoices />}
      {tab === 'floor3' && st.floor3 && <Floor3Tab f={st.floor3} act={act} busy={busy} usages={st.usages} base={st.form.base} sure={sure} confirm2={confirm2} setMsg={setMsg} />}
      {tab === 'vip' && <Vips />}
      {tab === 'notify' && <Notify />}
    </main>
    </AdminCtx.Provider>
  );

}

/* ---------- 首頁 ---------- */
/** 一鍵更新：有新版時按一下，家裡電腦自己下載、建置、切換（失敗留舊版） */
type UpInfo = { current: string; latest: string; canUpdate: boolean; pending: boolean; status: { step: string; at: string; from?: string; to?: string; error?: string; rolledBack?: boolean } | null };
const UP_STEP: Record<string, string> = {
  queued: '已送出要求，準備開始…', download: '1/4 下載新版中…', install: '2/4 安裝新套件中…', build: '3/4 建置新版中（舊版照常營業，約 1～3 分鐘）…',
  switch: '4/4 切換中（網站約中斷 20 秒）…', rollback: '新版啟動失敗，正在退回舊版…', done: '✅ 更新完成', same: '已經是最新版', failed: '✖ 更新失敗，網站維持舊版',
};
function UpdateCard() {
  const { act, busy } = useAdmin();
  const [u, setU] = useState<UpInfo | null>(null);
  const [sure, setSure] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch('/api/admin/update', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (r?.ok) setU(r.data);
  }, []);
  const running = !!u && (u.pending || (!!u.status && ['queued', 'download', 'install', 'build', 'switch', 'rollback'].includes(u.status.step) && Date.now() - Date.parse(u.status.at) < 15 * 60_000));
  useEffect(() => { load(); const id = setInterval(load, running ? 3000 : 60_000); return () => clearInterval(id); }, [load, running]);
  if (!u) return null;
  const hasNew = !!u.latest && u.latest !== u.current;
  const recent = u.status && Date.now() - Date.parse(u.status.at) < 24 * 3600_000 ? u.status : null;
  return (
    <div className="card" style={{ marginTop: 14, ...(hasNew ? { borderColor: 'var(--pri, #1f4e78)', borderWidth: 2 } : {}) }}>
      <h2 style={{ marginBottom: 6 }}>系統版本 {hasNew && <span className="badge">有新版</span>}</h2>
      <p style={{ margin: 0 }}>目前：<b>{u.current}</b>{u.latest ? <>　最新：<b>{u.latest}</b></> : <span className="small muted">　（暫時查不到最新版本）</span>}</p>
      {recent && <p style={{ margin: '6px 0 0', color: recent.step === 'failed' ? 'var(--red)' : recent.step === 'done' ? 'var(--ok)' : undefined }}>
        <b>{UP_STEP[recent.step] ?? recent.step}</b>{recent.step === 'done' && recent.to ? `：${recent.to}（${tw(recent.at)}）` : ''}
        {recent.error && <span className="small" style={{ display: 'block', whiteSpace: 'pre-wrap' }}>原因：{recent.error}</span>}</p>}
      {running ? <p className="small muted" style={{ margin: '6px 0 0' }}>更新中可以關掉這頁，網站會自己完成。完成後請重新整理後台。</p>
        : !u.canUpdate ? <p className="small muted" style={{ margin: '6px 0 0' }}>這次是用舊的啟動程式開的，還不能一鍵更新；照說明手動更新一次後就可以了。</p>
        : hasNew && (sure
          ? <div className="note warn" style={{ marginTop: 8 }}>更新時會先自動備份；建置期間網站照常營業，切換時約中斷 <b>20 秒</b>。請挑沒人填單的時間。
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn pri" disabled={busy} onClick={async () => { setSure(false); if (await act({ action: 'app.update' }, '已送出更新要求')) load(); }}>確定，立即更新</button>
                <button className="btn" onClick={() => setSure(false)}>取消</button></div></div>
          : <button className="btn pri" style={{ marginTop: 8 }} onClick={() => setSure(true)}>立即更新到 {u.latest}</button>)}
    </div>
  );
}

/** 備份：每小時自動一份；可立即備份並下載 */
function BackupCard() {
  const { st } = useAdmin();
  const b = st.backups;
  const last = b.list[0];
  const stale = !last || Date.now() - Date.parse(last.at) > 2 * 3600_000;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2>資料備份</h2>
      <p style={{ margin: 0 }}>
        {last ? <>最近一次：{tw(last.at)}（{Math.max(1, Math.round(last.size / 1024))} KB）・共 {b.count} 份</> : '還沒有備份（網站開著 1 分鐘後會自動備份第一份）'}
        {last && stale && <b className="err-text">　超過 2 小時沒有新備份，請確認網站是否正常開著</b>}
      </p>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>網站開著時每小時自動備份一次，存在：<span className="mono">{b.dir}</span>。設定好 Gmail 後，每天另寄一份到寄件信箱（異地備份）。</p>
      {st.user.role === 'admin' && <a className="btn" href="/api/admin/backup">立即備份並下載</a>}
      {st.user.role === 'admin' && <RestoreUpload />}
    </div>
  );
}

/** 全新的系統（例如剛搬上雲端）：上傳舊系統的備份檔，資料就搬過來了 */
function EmptyRestore({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <div className="card">
      <h1>新的系統，還沒有資料</h1>
      <p>請上傳從舊系統下載的備份檔（舊後台首頁「資料備份」→「立即備份並下載」，檔名像 <span className="mono">ticc-202610310500.json.gz</span>）。上傳後，訂單、劃位、連結、設定和後台帳號都會搬過來。</p>
      <input type="file" accept=".gz,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button className="btn pri" style={{ marginTop: 10, width: '100%' }} disabled={busy || !file} onClick={async () => {
        setBusy(true); setMsg('');
        try {
          const r = await fetch(`/api/admin/restore?confirm=${encodeURIComponent('還原')}`, { method: 'POST', body: file });
          const j = await r.json() as { ok: boolean; message?: string };
          if (!j.ok) setMsg(j.message ?? '還原失敗');
          else { setMsg('已搬入資料。後台帳號密碼改為舊系統的，請重新登入。'); setTimeout(() => location.reload(), 2500); onDone(); }
        } catch { setMsg('網路連線異常，請再試一次'); }
        setBusy(false);
      }}>{busy ? '上傳中…' : '上傳並搬入資料'}</button>
      {msg && <p className="note" style={{ marginTop: 10 }}>{msg}</p>}
    </div>
  );
}

/** 從備份檔還原：搬家（家裡電腦 → 雲端）或萬一需要時使用 */
function RestoreUpload() {
  const { setMsg } = useAdmin();
  const [file, setFile] = useState<File | null>(null);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <details style={{ marginTop: 10 }}>
      <summary className="small" style={{ cursor: 'pointer' }}><b style={{ color: 'var(--red)' }}>從備份檔還原</b>（搬家或救援用，會取代目前所有資料）</summary>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input type="file" accept=".gz,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <label className="f">請輸入「還原」確認<input value={word} onChange={(e) => setWord(e.target.value)} /></label>
        <button className="btn danger" disabled={busy || !file || word !== '還原'} onClick={async () => {
          setBusy(true);
          try {
            const r = await fetch(`/api/admin/restore?confirm=${encodeURIComponent('還原')}`, { method: 'POST', body: file });
            const j = await r.json() as { ok: boolean; message?: string; data?: { at: string; preorders: number; orders: number; links: number } };
            if (!j.ok) setMsg({ kind: 'err', text: j.message ?? '還原失敗' });
            else { setMsg({ kind: 'ok', text: `已還原 ${tw(j.data!.at)} 的備份：訂單 ${j.data!.preorders} 筆、劃位 ${j.data!.orders} 筆、連結 ${j.data!.links} 條。請重新整理頁面。` }); setWord(''); }
          } catch { setMsg({ kind: 'err', text: '網路連線異常，還原沒有完成' }); }
          setBusy(false);
        }}>{busy ? '還原中…' : '用這個檔案還原'}</button>
      </div>
    </details>
  );
}

function Home() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const items: [Tab, string, string, string][] = [
    ['price', '價格設定', '票種名稱、票價與座位底色，依排數和區塊指定座位，組合票，開放劃位與發布', st.zones.slice(0, 3).map((z) => `${z.name || '未命名'} ${money(z.price)}`).join('・')],
    ['usage', '席位用途', '保留公關席、認購席、不開放座位，加裝 VIP 排', `保留／不開放 ${st.stats.reserved} 席`],
    ['links', '專屬購票連結', '發給受邀對象的購票連結與可購張數', `已發出 ${st.links.length} 條`],
    ['pre', '表單／收款', '依送單順序：核帳、勾入群，輪到時按「發出劃位連結」寄出', `${st.preorders.filter((x) => x.status === 'submitted').length} 張待發連結`],
    ['groups', '連座分組', '兩位一組、十位一組等連座；預設分組可修改，按一下套用', ''],
    ['orders', '劃位確認', '看暫存中與已送出劃位資料的人，核對後按確認，寄出劃位成功與 QR code', `${st.stats.newOrders ? `新訂單 ${st.stats.newOrders} 筆・` : ''}暫存 ${st.stats.held} 席・待確認 ${st.stats.pending} 席`],
    ['tickets', '紙本入場券', '依已確認的訂單產生實名入場券並列印', `已售 ${st.stats.sold} 席`],
  ];
  return (
    <div className="home">
      {items.map(([k, t, d, m], i) => (
        <button key={k} className={`hcard${i === 0 ? ' main' : ''}`} onClick={() => go(k)}><b>{t}</b><span>{d}</span><em>{m}</em></button>
      ))}
      {st.dirty && <div className="note warn" style={{ gridColumn: '1 / -1' }}>開放設定有尚未發布的變更，消費者目前還看不到。請到「價格設定」的「四、開放劃位」按「發布到購票頁」。</div>}
      {st.user.role === 'admin' && <UpdateCard />}
      <BackupCard />
      <AuditCard />
      <ResetCard />
    </div>
  );
}

/** 最近的操作紀錄：誰、幾點、做了什麼（改票種會列出座位） */
function AuditCard() {
  const { st } = useAdmin();
  const [q, setQ] = useState('');
  const list = st.audit.filter((a) => !q.trim() || `${a.action} ${a.what} ${a.actor}`.includes(q.trim()));
  return (
    <details className="card" style={{ gridColumn: '1 / -1' }}>
      <summary style={{ cursor: 'pointer' }}><b>最近的操作紀錄</b> <span className="small muted">誰、幾點、做了什麼；改票種、改席位用途會列出是哪幾個座位</span></summary>
      <input value={q} placeholder="搜尋，例：改票種、第 9 排" style={{ margin: '8px 0', width: 260 }} onChange={(e) => setQ(e.target.value)} />
      <div className="tbl"><table><tbody>
        {list.map((a) => <tr key={a.id}><td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tw(a.at)}</td><td className="small">{a.actor}</td><td className="small"><b>{a.action}</b>{a.what && <>　{a.what}</>}</td></tr>)}
        {!list.length && <tr><td className="muted small">沒有紀錄</td></tr>}
      </tbody></table></div>
    </details>
  );
}

/* 清除測試資料：回到未開賣，保留設定與志工席 */
type Preview = { links: { id: number; code: string; name: string; note: string; seats: number }[]; linkCount: number; orders: number; preorders: number;
  checkins: number; occupied: number; reserved: { name: string; seats: number }[]; saleOpen: boolean; preorderOpen: boolean };
function ResetCard() {
  const { act, busy, setMsg } = useAdmin();
  const [pv, setPv] = useState<Preview | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [close, setClose] = useState(true);
  const [word, setWord] = useState('');
  const load = async () => { const r = await act({ action: 'reset.preview' }) as Preview | null; if (r) { setPv(r); setKeep(new Set()); setWord(''); } };
  return (
    <details className="card" style={{ gridColumn: '1 / -1', borderColor: 'var(--red)' }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !pv) load(); }}>
      <summary style={{ cursor: 'pointer' }}><b style={{ color: 'var(--red)' }}>清除測試資料（回到未開賣）</b> <span className="small muted">刪除劃位連結、訂單、劃位與入場紀錄，座位全部釋放；設定與志工席保留</span></summary>
      {pv && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="bank">
            <span className="muted">會刪除</span>
            <span>劃位連結 {pv.links.length - keep.size} 條、訂單（預購單送出）{pv.preorders} 張、劃位 {pv.orders} 筆、入場紀錄 {pv.checkins} 筆、通知紀錄；釋放座位 {pv.occupied - pv.links.filter((l) => keep.has(l.id)).reduce((a, l) => a + l.seats, 0)} 席</span>
            <span className="muted">會保留</span>
            <span>場次資料、票種與票價、組合票、連座分組、驗票門口、Email 設定、後台帳號；
              席位用途{pv.reserved.length ? `（${pv.reserved.map((r) => `${r.name} ${r.seats} 席`).join('、')}）` : ''}</span>
          </div>
          {pv.links.some((l) => l.seats > 0) && <>
            <div className="small"><b>要保留的劃位連結</b>（例如志工是用連結訂下的座位，勾選後該連結與座位都會保留）：</div>
            <div className="tbl" style={{ maxHeight: 220, overflow: 'auto' }}><table><tbody>
              {pv.links.filter((l) => l.seats > 0).map((l) => (
                <tr key={l.id}><td><label className="switch small"><input type="checkbox" checked={keep.has(l.id)}
                  onChange={(e) => { const n = new Set(keep); if (e.target.checked) n.add(l.id); else n.delete(l.id); setKeep(n); }} />保留</label></td>
                  <td>{l.name}</td><td className="mono small">{l.code}</td><td className="small muted">{l.note}</td><td className="mono">{l.seats} 席</td></tr>
              ))}
            </tbody></table></div>
          </>}
          <label className="switch small"><input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} />
            同時關閉預購單與購票頁（未開賣）{pv.saleOpen || pv.preorderOpen ? '' : '（目前已是關閉）'}</label>
          <p className="small" style={{ margin: 0, color: 'var(--red)' }}>刪除後無法復原。已寄出的測試 QR code 會全部失效。</p>
          <div className="row">
            <input value={word} placeholder="輸入「清除」確認" style={{ width: 160 }} onChange={(e) => setWord(e.target.value)} />
            <button className="btn danger" disabled={busy || word.trim() !== '清除'} onClick={async () => {
              const r = await act({ action: 'reset.run', confirm: word.trim(), keepLinkIds: [...keep], close }) as { links: number; orders: number; seats: number; preorders: number; kept: number; closed: boolean } | null;
              if (r) { setMsg({ kind: 'ok', text: `已清除：劃位連結 ${r.links} 條、劃位 ${r.orders} 筆、訂單 ${r.preorders} 張，釋放 ${r.seats} 席${r.kept ? `；保留 ${r.kept} 條連結` : ''}${r.closed ? '；已關閉預購單與購票頁' : ''}。` }); await load(); }
            }}>清除</button>
            <button className="btn" disabled={busy} onClick={load}>重新整理數字</button>
          </div>
        </div>
      )}
    </details>
  );
}

/* ---------- 席位用途 ---------- */
function Usage() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const [brush, setBrush] = useState(st.usages.find((u) => u.code === 'hold-pr')?.id ?? st.usages[0].id);
  const count = (id: number) => st.seats.filter((s) => s.installed && s.usageId === id).length;
  const look = (s: Seat): SeatLook => {
    const u = usageById[s.usageId];
    const kind = s.status === 'free' ? (u?.code === 'closed' ? 'blocked' : 'free') : (s.status as SeatLook['kind']);
    return { kind, bg: USAGE_COLOR[u?.code ?? 'sale'], ink: '#18213a', title: `${s.label}・${s.code}・${s.status === 'free' ? u?.name : STATUS[st.orders.find((o) => o.id === s.orderId)?.status ?? ''] ?? '已有訂單'}` };
  };
  return (
    <div className="grid2">
      <AdminMap seats={st.seats} vipInstalled={st.event.vipInstalled} look={look} caption="實心＝已售出、斜紋＝暫存或待確認"
        onPaint={(ids) => act({ action: 'usage.assignSeats', usageId: brush, seatIds: ids }, `已設定 ${ids.length} 席為「${usageById[brush]?.name}」`)} />
      <div className="side">
        <div className="card">
          <h2>設定席位用途</h2>
          <p className="small muted" style={{ marginTop: 0 }}>先選類別，再在座位圖上點按或拖曳。</p>
          <div className="brushes">
            {st.usages.map((u) => (
              <button key={u.id} className={`brush${brush === u.id ? ' on' : ''}`} onClick={() => setBrush(u.id)}>
                <i style={{ background: USAGE_COLOR[u.code] ?? '#ddd', borderStyle: u.code === 'closed' ? 'dashed' : undefined }} />{u.name}<span className="c">{count(u.id)}</span>
              </button>
            ))}
          </div>
          <h3>VIP 排</h3>
          <label className="switch"><input type="checkbox" checked={st.event.vipInstalled} disabled={busy}
            onChange={(e) => act({ action: 'event.update', values: { vipInstalled: e.target.checked } })} />本場加裝 VIP 排（21 席，需另付裝拆費）</label>
        </div>
      </div>
    </div>
  );
}

/* ---------- 價格設定 ---------- */
function Price() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const [brush, setBrush] = useState(st.zones[0]?.id ?? 0);
  const [rows, setRows] = useState<Set<number>>(new Set());
  const [blks, setBlks] = useState<Set<string>>(new Set());
  const [rowText, setRowText] = useState('');
  const [ruleNote, setRuleNote] = useState<{ err: boolean; text: string } | null>(null);
  const zoneName = (id: number) => zoneById[id]?.name || '（未命名）';
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  const look = (s: Seat): SeatLook => {
    const z = zoneById[s.zoneId];
    const u = usageById[s.usageId];
    return { kind: 'free', bg: z?.color, ink: z ? inkFor(z.color) : undefined, dim: !u?.sellable || s.status !== 'free',
      title: `${s.label}・${s.code}・${z?.name || '未命名'} ${money(z?.price ?? 0)}${s.status !== 'free' ? '・已有訂單' : ''}` };
  };

  async function applyRule() {
    const r = await act({ action: 'zone.assignRule', zoneId: brush, rows: [...rows], blocks: [...blks] });
    if (r) {
      const d = r as { updated: number; skipped: number };
      setRuleNote(d.updated
        ? { err: false, text: `已將 ${d.updated} 席設為「${zoneName(brush)}」（第 ${rowsText(rows)} 排，${blks.size ? [...blks].join('、') : '全部區塊'}）${d.skipped ? `，略過 ${d.skipped} 席已有訂單` : ''}` }
        : { err: true, text: '沒有符合條件、可以修改的座位' });
      if (d.updated) { setRows(new Set()); setBlks(new Set()); setRowText(''); } // 套用後回到白底
    }
  }

  const pub = st.published;
  return (
    <div className="pstack">
      {/* 一、票種與票價 */}
      <div className="card">
        <h2>一、票種與票價 <span className="small muted">名稱、票價、座位底色自行設定，修改後立即儲存</span></h2>
        <div className="tbl"><table>
          <thead><tr><th>座位底色</th><th>票種名稱</th><th>票價（NT$）</th><th>座位數</th><th></th></tr></thead>
          <tbody>
            {st.zones.map((z) => (
              <tr key={z.id}>
                <td><div className="swrow">
                  {COLOR_PRESETS.map((h) => (
                    <button key={h} className={`sw${z.color.toLowerCase() === h ? ' on' : ''}`} style={{ background: h }} aria-label={`底色 ${h}`}
                      onClick={() => act({ action: 'zone.update', id: z.id, values: { color: h } })} />
                  ))}
                  <label className="swpick" title="自訂顏色"><input type="color" defaultValue={z.color} key={z.color} aria-label="自訂底色"
                    onBlur={(e) => e.target.value !== z.color && act({ action: 'zone.update', id: z.id, values: { color: e.target.value } })} /></label>
                </div></td>
                <td><input key={`n${z.id}-${z.name}`} defaultValue={z.name} placeholder="例：A區、學生票" className={z.name ? '' : 'need'}
                  onBlur={(e) => e.target.value.trim() !== z.name && act({ action: 'zone.update', id: z.id, values: { name: e.target.value.trim() } })} /></td>
                <td><input key={`p${z.id}-${z.price}`} defaultValue={z.price} placeholder="請填票價" inputMode="numeric" className="mono" style={{ width: 110 }}
                  onBlur={(e) => { const v = parseInt(e.target.value.replace(/[^\d]/g, '')) || 0; if (v !== z.price) act({ action: 'zone.update', id: z.id, values: { price: v } }); }} />
                  {z.price === 0 && <div className="small muted">0＝贈票，只能透過組合票</div>}</td>
                <td className="mono">{z.seatCount}</td>
                <td><button className="btn small danger" disabled={busy} onClick={() => confirm2(`zdel${z.id}`, () => act({ action: 'zone.delete', id: z.id }, '已刪除票種'))}>{sure === `zdel${z.id}` ? '再按一次確認' : '刪除'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <button className="btn small" style={{ marginTop: 8 }} disabled={busy} onClick={() => act({ action: 'zone.create' }, '已新增一個空白票種，請填名稱與票價')}>＋ 新增票種</button>
      </div>

      {/* 二、指定座位的票種 */}
      <div className="grid2">
        <AdminMap seats={st.seats} vipInstalled={st.event.vipInstalled} look={look} caption="座位顏色＝所屬票種；半透明＝保留或已有訂單"
          onPaint={(ids) => act({ action: 'zone.assignSeats', zoneId: brush, seatIds: ids }, `已將 ${ids.length} 席設為「${zoneName(brush)}」`)} />
        <div className="side"><div className="card">
          <h2>二、指定座位的票種</h2>
          <label className="f">要設定成哪個票種
            <select value={brush} onChange={(e) => setBrush(+e.target.value)}>
              {st.zones.map((z) => <option key={z.id} value={z.id}>{z.name || '（未命名）'}・{money(z.price)}</option>)}
            </select>
          </label>
          <h3>排（點選，或直接輸入）</h3>
          <div className="chips">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1].map((r) => (
              <button key={r} className={`chip${rows.has(r) ? ' on' : ''}`} onClick={() => { const n = toggle(rows, r); setRows(n); setRowText(rowsText(n)); setRuleNote(null); }}>
                {r === 0 ? 'VIP' : r === -1 ? '輪椅' : r}
              </button>
            ))}
          </div>
          <input value={rowText} placeholder="例：1-6, 9, VIP" style={{ marginTop: 6 }} onChange={(e) => setRowText(e.target.value)}
            onBlur={() => { const p = parseRows(rowText); setRows(p.set); setRuleNote(p.bad.length ? { err: true, text: `看不懂「${p.bad.join('、')}」，請填 1–12 的排數、VIP 或 輪椅，例如 1-6, 9` } : null); }} />
          <h3>區塊 <span className="small muted">（不選＝全部區塊）</span></h3>
          <div className="chips">
            {BLOCKS.map(([b, n]) => <button key={b} className={`chip${blks.has(b) ? ' on' : ''}`} onClick={() => { setBlks(toggle(blks, b)); setRuleNote(null); }}>{b} {n}</button>)}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn pri" disabled={busy || !rows.size} onClick={applyRule}>套用到這些座位</button>
            <button className="btn" onClick={() => { setRows(new Set()); setBlks(new Set()); setRowText(''); setRuleNote(null); }}>清除</button>
          </div>
          {ruleNote && <div className={`note ${ruleNote.err ? 'err' : 'ok'}`} style={{ marginTop: 8 }}>{ruleNote.text}</div>}
          <p className="small muted">也可以直接在座位圖上點按或拖曳，把座位改成上面選的票種。</p>
          <h3>連座分組（按一下選整組）</h3>
          <p className="small" style={{ margin: '0 0 6px' }}>兩位一組、十位一組等設定，請到「<a href="#groups" onClick={(e) => { e.preventDefault(); go('groups'); }}>連座分組</a>」頁。</p>
          <h3>座位編號（排-席次-區）</h3>
          <p className="small" style={{ margin: 0 }}>例：<b className="mono">03-15-L1</b> 是第3排15號、左區。VIP 排的排號為 V，輪椅席為 WC。區塊：L2 左側區、L1 左區、C0 中區、R1 右區、R2 右側區。</p>
        </div></div>
      </div>

      {/* 三、組合票 */}
      <div className="card">
        <h2>三、組合票 <span className="small muted">由票種與張數組成，可跨票種；套票價格自行填寫</span></h2>
        <details className="ced" style={{ marginBottom: 10 }} open={st.gifts.length > 0}>
          <summary><b>贈品項目</b> <span className="small muted">書、披肩等實物（不是座位）。先在這裡建立，再到各方案填每份送幾個</span></summary>
          {st.gifts.length > 0 && (
            <div className="tbl" style={{ marginTop: 6 }}><table className="small"><thead><tr><th>贈品</th><th>單位</th><th>已登記需備</th><th>已匯款需備</th><th></th></tr></thead><tbody>
              {st.gifts.map((g) => (
                <tr key={g.id}>
                  <td><input key={`gn${g.id}-${g.name}`} defaultValue={g.name} placeholder="例：書" className={g.name ? '' : 'need'} style={{ width: 110 }}
                    onBlur={(e) => e.target.value.trim() !== g.name && act({ action: 'gift.update', id: g.id, values: { name: e.target.value.trim() } })} /></td>
                  <td><input key={`gu${g.id}-${g.unit}`} defaultValue={g.unit} style={{ width: 50 }}
                    onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.unit && act({ action: 'gift.update', id: g.id, values: { unit: e.target.value.trim() } })} /></td>
                  <td>{g.registered} {g.unit}</td><td><b>{g.paid}</b> {g.unit}</td>
                  <td><button className="btn small danger" disabled={busy} onClick={() => confirm2(`gdel${g.id}`, () => act({ action: 'gift.delete', id: g.id }, '已刪除贈品'))}>{sure === `gdel${g.id}` ? '再按一次確認' : '刪除'}</button></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
          <button className="btn small" style={{ marginTop: 6 }} disabled={busy} onClick={() => act({ action: 'gift.create' }, '已新增贈品，請填名稱與單位')}>＋ 新增贈品</button>
          <div style={{ marginTop: 8 }}>
            <div className="small"><b>給買方看的位置</b>（不勾＝驚喜，買方看不到；後台統計一律顯示）</div>
            <label className="switch small"><input type="checkbox" checked={!!st.giftShow.buy} disabled={busy} onChange={(e) => act({ action: 'gift.show', values: { buy: e.target.checked } })} />認購頁的方案說明</label>
            <label className="switch small"><input type="checkbox" checked={!!st.giftShow.invoice} disabled={busy} onChange={(e) => act({ action: 'gift.show', values: { invoice: e.target.checked } })} />電子發票品項備註（已開立的不會改）</label>
          </div>
        </details>
        <div className="combogrid">
          {st.combos.filter((c) => !c.isSingle).map((c) => {
            const list = c.items.reduce((a, i) => a + (zoneById[i.zoneId]?.price ?? 0) * i.qty, 0);
            const save = (values: Record<string, unknown>) => act({ action: 'combo.update', id: c.id, values });
            return (
              <div key={c.id} className="ced">
                <div className="row">
                  <input key={`cn${c.id}-${c.name}`} defaultValue={c.name} placeholder="組合名稱，例：買一A送二B" className={c.name ? '' : 'need'} style={{ flex: 1, minWidth: 140 }}
                    onBlur={(e) => e.target.value.trim() !== c.name && save({ name: e.target.value.trim() })} />
                  <button className="btn small danger" disabled={busy} onClick={() => confirm2(`cdel${c.id}`, () => act({ action: 'combo.delete', id: c.id }, '已刪除組合'))}>{sure === `cdel${c.id}` ? '再按一次確認' : '刪除'}</button>
                </div>
                <span className="small muted">內容（哪個票種、幾張）</span>
                {c.items.map((it, j) => (
                  <div key={j} className="row">
                    <select value={it.zoneId} style={{ width: 'auto', flex: 1 }}
                      onChange={(e) => save({ items: c.items.map((x, k) => (k === j ? { ...x, zoneId: +e.target.value } : x)) })}>
                      {st.zones.map((z) => <option key={z.id} value={z.id}>{z.name || '（未命名）'}</option>)}
                    </select>
                    <span>×</span>
                    <input key={`q${c.id}-${j}-${it.qty}`} defaultValue={it.qty} inputMode="numeric" style={{ width: 56 }}
                      onBlur={(e) => { const q = Math.max(1, parseInt(e.target.value) || 1); if (q !== it.qty) save({ items: c.items.map((x, k) => (k === j ? { ...x, qty: q } : x)) }); }} />
                    <span className="small">張</span>
                    <button className="btn small" aria-label="移除這一項" disabled={c.items.length <= 1}
                      onClick={() => save({ items: c.items.filter((_, k) => k !== j) })}>×</button>
                  </div>
                ))}
                <div><button className="btn small" onClick={() => save({ items: [...c.items, { zoneId: st.zones.find((z) => !c.items.some((i) => i.zoneId === z.id))?.id ?? st.zones[0].id, qty: 1 }] })}>＋ 加一個票種</button></div>
                <div className="fields">
                  <label className="f">套票價格（NT$）<input key={`cp${c.id}-${c.price}`} defaultValue={c.price || ''} placeholder="請填套票價" inputMode="numeric" className={c.price ? '' : 'need'}
                    onBlur={(e) => { const v = parseInt(e.target.value.replace(/[^\d]/g, '')) || 0; if (v !== c.price) save({ price: v }); }} /></label>
                  <label className="f">限量組數（0＝不限）<input key={`cl${c.id}-${c.limitSets}`} defaultValue={c.limitSets} inputMode="numeric"
                    onBlur={(e) => { const v = parseInt(e.target.value) || 0; if (v !== c.limitSets) save({ limitSets: v }); }} /></label>
                </div>
                <label className="f">方案內容（預購單上買方看到的說明；留空會自動產生）
                  <input key={`cd${c.id}-${c.description}`} defaultValue={c.description} maxLength={200} placeholder="例：認購尊榮區 1 席，尊榮親友專屬席 2 席（座位相連）"
                    onBlur={(e) => e.target.value.trim() !== c.description && save({ description: e.target.value.trim() })} /></label>
                <label className="switch small">
                  <input type="checkbox" checked={c.autoHolders} disabled={busy} onChange={(e) => save({ autoHolders: e.target.checked })} />
                  持票人自動帶入：第 1 張為購票人本名，之後為「姓名02、03…」，購票人可以逐張改成別人的名字（不填身分證）
                </label>
                <label className="switch small">
                  <input type="checkbox" checked={c.hidden} disabled={busy} onChange={(e) => save({ hidden: e.target.checked })} />
                  隱藏方案：公開認購頁看不到，只有登入後台的人員能代填（到「四、訂單核帳」按「代填認購單」）。請先勾好再發布。
                </label>
                {st.gifts.length > 0 && (
                  <div className="row small" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <span>每份贈品：</span>
                    {st.gifts.map((g) => {
                      const q = c.gifts.find((x) => x.giftId === g.id)?.qty ?? 0;
                      return (
                        <label key={g.id}>{g.name || '（未命名）'}
                          <input key={`cg${c.id}-${g.id}-${q}`} type="number" min={0} max={999} defaultValue={q} style={{ width: 56, marginLeft: 4 }}
                            onBlur={(e) => {
                              const n = Math.max(0, Math.min(999, Math.floor(Number(e.target.value) || 0)));
                              if (n === q) return;
                              save({ gifts: [...c.gifts.filter((x) => x.giftId !== g.id), ...(n ? [{ giftId: g.id, qty: n }] : [])] });
                            }} /> {g.unit}
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="small muted" style={{ margin: 0 }}>
                  {comboDesc(c, zoneName)}，共 {comboQty(c)} 張・原價合計 {money(list)}{c.price && list ? `・約 ${(c.price / list * 10).toFixed(1)} 折` : ''}{c.limitSets ? `・已售 ${c.usedSets} 組` : ''}
                </p>
              </div>
            );
          })}
        </div>
        <button className="btn small" style={{ marginTop: 10 }} disabled={busy} onClick={() => act({ action: 'combo.create' }, '已新增一個空白組合，請填名稱、內容與套票價格')}>＋ 新增組合</button>
        <p className="small muted">「單張購票」固定提供，依各票種票價計算，可在下方設定是否開放。</p>
      </div>

      {/* 四、開放劃位 */}
      <div className="card">
        <h2>四、開放劃位 <span className="small muted">管拿到劃位連結的人能不能選座位（認購登記頁 /buy 另在「四、訂單核帳」開關）。勾選要開放的項目，按「發布到購票頁」後才生效</span></h2>
        <div className="pubgrid">
          <div><h3>總開關</h3>
            <label className="switch"><input type="checkbox" checked={st.event.saleOpen} disabled={busy} onChange={(e) => act({ action: 'event.update', values: { saleOpen: e.target.checked } })} />開放劃位</label>
          </div>
          <div><h3>開放的票種</h3><div className="checks">
            {st.zones.map((z) => (
              <label key={z.id} className="switch"><input type="checkbox" checked={z.open} disabled={busy} onChange={(e) => act({ action: 'zone.update', id: z.id, values: { open: e.target.checked } })} />
                <i className="dot" style={{ background: z.color }} />{z.name || '（未命名）'} <span className="muted small">{money(z.price)}・{z.seatCount} 席</span></label>
            ))}
          </div></div>
          <div><h3>開放的購票方式</h3><div className="checks">
            {st.combos.map((c) => (
              <label key={c.id} className="switch"><input type="checkbox" checked={c.active} disabled={busy} onChange={(e) => act({ action: 'combo.update', id: c.id, values: { active: e.target.checked } })} />
                {c.name || '（未命名組合）'} <span className="muted small">{c.isSingle ? '依票價' : money(c.price)}</span></label>
            ))}
          </div></div>
        </div>
        <div className={`pubbar${st.dirty ? ' dirty' : ''}`}>
          <div className="small">
            <b>購票頁目前：</b>{pub?.open ? '開放劃位中' : '未開放'}｜票種：{pub ? pub.zoneIds.map((id) => zoneById[id]?.name).filter(Boolean).join('、') || '無' : '無'}｜購票方式：{pub ? st.combos.filter((c) => pub.comboIds.includes(c.id)).map((c) => c.name).join('、') || '無' : '無'}
            <br /><span className="muted">最後發布：{pub ? tw(pub.at) : '尚未發布'}</span>
            {st.dirty && <><br /><b style={{ color: 'var(--warn)' }}>有尚未發布的變更，消費者目前還看不到</b></>}
          </div>
          <button className="btn pri" disabled={busy || !st.dirty} onClick={() => act({ action: 'publish' }, '已發布到購票頁')}>發布到購票頁</button>
        </div>
        <Settings />
      </div>
    </div>
  );
}

function Settings() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const e = st.event;
  const [v, setV] = useState({
    name: e.name, showAt: toLocalInput(e.showAt), saleStart: toLocalInput(e.saleStart), saleEnd: toLocalInput(e.saleEnd), maxPerOrder: String(e.maxPerOrder),
    holdMinutes: String(e.holdMinutes), bankName: e.bankName, bankAccount: e.bankAccount, accountName: e.accountName,
  });
  const f = (k: keyof typeof v, label: string, type = 'text') => (
    <label className="f">{label}<input type={type} value={v[k]} onChange={(x) => setV({ ...v, [k]: x.target.value })} /></label>
  );
  return (
    <>
      <h3>時間、限制與匯款帳戶</h3>
      <div className="fields">
        {f('name', '演出名稱')}{f('showAt', '演出時間（台北）', 'datetime-local')}
        {f('maxPerOrder', '每筆訂單上限（張）')}
        {f('saleStart', '開始時間（台北）', 'datetime-local')}{f('saleEnd', '截止時間（台北）', 'datetime-local')}
        {f('holdMinutes', '選位暫存（分鐘）')}
        {f('bankName', '銀行（含代碼）')}{f('bankAccount', '帳號')}{f('accountName', '戶名')}
      </div>
      <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={() => act({ action: 'event.update', values: {
        name: v.name, ...(v.showAt ? { showAt: fromLocalInput(v.showAt) } : {}), saleStart: fromLocalInput(v.saleStart), saleEnd: fromLocalInput(v.saleEnd),
        maxPerOrder: parseInt(v.maxPerOrder) || 21, holdMinutes: parseInt(v.holdMinutes) || 20,
        bankName: v.bankName, bankAccount: v.bankAccount, accountName: v.accountName,
      } }, '已儲存。時間與匯款帳戶立即生效，不需發布。')}>儲存這些設定</button>
    </>
  );
}

/* ---------- 專屬連結 ---------- */
function Links() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const [f, setF] = useState({ name: '', phone: '', note: '', quota: '21', expiresAt: toDateInput(st.event.showAt) });
  const [made, setMade] = useState<{ name: string; code: string; note: string } | null>(null);
  const base = typeof window !== 'undefined' ? location.origin : '';
  return (
    <div className="pstack">
    <div className="card" style={{ paddingBottom: 8 }}><h2 style={{ margin: 0 }}>五、劃位專屬連結 <span className="small muted">依送單順序發出，一次服務一位</span></h2></div>
    <NextUp />
    <Queue />
    <h3 style={{ margin: '8px 0 0' }}>所有劃位連結</h3>
    <p className="small muted" style={{ margin: 0 }}>上面「發出劃位連結」建立的連結都列在這裡。特殊狀況（例如貴賓、沒填預購單直接匯款）可用右側「手動發劃位連結」。</p>
    <div className="grid2">
      <div className="card">
        <h2>已發出的劃位連結</h2>
        <div className="tbl"><table>
          <thead><tr><th>代碼</th><th>對象</th><th>手機／來帳備註</th><th>可劃／已劃</th><th>有效至</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {st.links.filter((l) => l.kind !== 'public' && l.kind !== 'vip').map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.code}</td><td>{l.name}</td><td className="small"><span className="mono">{l.phone || '—'}</span>{l.note && <div className="muted">{l.note}</div>}</td>
                <td className="small">{l.paid
                  ? <span className={l.paid.over ? 'err-text' : ''}>{l.paid.text}{l.paid.over && <b>（超過付款內容）</b>}</span>
                  : <span className="mono">{l.quota || '不限'} / {l.used}</span>}</td><td className="small">{tw(l.expiresAt)}</td>
                <td>{l.status === 'active' ? <span className="pill p-paid">使用中</span> : <span className="pill p-cancelled">已停用</span>}</td>
                <td><div className="row">
                  <button className="btn small" onClick={() => navigator.clipboard?.writeText(`${base}/t/${l.code}`).then(() => setMsg({ kind: 'ok', text: `已複製 ${base}/t/${l.code}` }), () => setMsg({ kind: 'ok', text: `${base}/t/${l.code}` }))}>複製連結</button>
                  <a className="btn small" href={`/t/${l.code}`} target="_blank" rel="noreferrer">開啟購票頁</a>
                  <button className="btn small" disabled={busy} onClick={() => {
                    const v = window.prompt(`${l.name} 的可購張數（0＝不限）`, String(l.quota));
                    if (v === null) return;
                    const n = parseInt(v.trim());
                    if (!Number.isInteger(n) || n < 0 || n > 200) { setMsg({ kind: 'err', text: '張數請填 0–200 的整數' }); return; }
                    act({ action: 'link.update', id: l.id, values: { quota: n } }, `已將 ${l.name} 的可購張數改為 ${n || '不限'}`);
                  }}>改張數</button>
                  <button className="btn small" disabled={busy} onClick={() => {
                    const v = window.prompt(`${l.name} 的有效期限（格式 2026-12-31，當天 23:59 止）`, toDateInput(l.expiresAt));
                    if (v === null) return;
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { setMsg({ kind: 'err', text: '日期格式請填 2026-12-31' }); return; }
                    act({ action: 'link.update', id: l.id, values: { expiresAt: v.trim() } }, `已將 ${l.name} 的連結期限改為 ${v.trim()}`);
                  }}>改期限</button>
                  <button className="btn small" disabled={busy} onClick={() => act({ action: 'link.update', id: l.id, values: { status: l.status === 'active' ? 'disabled' : 'active' } })}>{l.status === 'active' ? '停用' : '啟用'}</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="small muted">每個連結綁定一位對象與可購張數。之後會加上開啟時的手機簡訊驗證碼，避免連結被轉傳使用。</p>
      </div>
      <div className="side"><details className="card">
        <summary style={{ cursor: 'pointer' }}><b>手動發劃位連結</b> <span className="small muted">備用：貴賓、未填預購單直接匯款</span></summary>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const miss = [!f.name.trim() && '姓名', !f.expiresAt && '有效期限'].filter(Boolean);
          if (miss.length) { setMsg({ kind: 'err', text: `請填寫：${miss.join('、')}` }); return; }
          const pp = f.phone.trim() ? phoneProblem(f.phone) : null;
          if (pp) { setMsg({ kind: 'err', text: pp }); document.getElementById('l-phone')?.focus(); return; }
          const digits = f.phone.replace(/\D/g, '');
          const q = parseInt(f.quota.trim() || '0');
          if (!Number.isInteger(q) || q < 0 || q > 200) { setMsg({ kind: 'err', text: '可購張數請填 0–200 的整數（0＝不限）' }); return; }
          const r = await act({ action: 'link.create', name: f.name.trim(), phone: digits, quota: q, expiresAt: f.expiresAt, note: f.note.trim() }) as { code: string; delivery?: Delivery } | null;
          if (r) {
            setMade({ name: f.name.trim(), code: r.code, note: f.note.trim() });
            navigator.clipboard?.writeText(`${base}/t/${r.code}`).catch(() => undefined);
            const d = deliveryText(r.delivery);
            setMsg({ kind: d.bad ? 'err' : 'ok', text: `已為 ${f.name.trim()} 產生劃位連結，並已複製，可直接貼給當事人。${digits && d.text ? `簡訊：${d.text}。` : ''}` });
          }
          if (r) setF({ name: '', phone: '', note: '', quota: f.quota, expiresAt: f.expiresAt });
        }}>
          <label className="f">姓名（依來帳）<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="f" style={{ marginTop: 8 }}>來帳備註（選填，例：末五碼 12345、NT$32,000）<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <div className="fields" style={{ marginTop: 8 }}>
            <label className="f">手機（選填，填了會發簡訊）<input id="l-phone" value={f.phone} inputMode="tel" maxLength={13} placeholder="09xx-xxx-xxx" aria-invalid={!!phoneProblem(f.phone)}
              style={phoneProblem(f.phone) ? { borderColor: 'var(--red)' } : undefined} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              {phoneProblem(f.phone) && <span className="small" style={{ color: 'var(--red)' }}>{phoneProblem(f.phone)}</span>}</label>
            <label className="f">可購張數（0＝不限）<input value={f.quota} inputMode="numeric" onChange={(e) => setF({ ...f, quota: e.target.value })} /></label>
          </div>
          <label className="f" style={{ marginTop: 8 }}>有效期限（當天 23:59 止）<input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
          <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy}>{busy ? '處理中…' : '產生劃位連結'}</button>
        </form>
        {made && (
          <div className="note ok" style={{ marginTop: 12 }}>
            <div><b>{made.name}</b> 的劃位連結{made.note ? `（${made.note}）` : ''}</div>
            <div className="mono small" style={{ wordBreak: 'break-all', margin: '4px 0 8px' }}>{base}/t/{made.code}</div>
            <div className="row">
              <button className="btn pri" onClick={() => navigator.clipboard?.writeText(`${base}/t/${made.code}`).then(() => setMsg({ kind: 'ok', text: '已複製連結，貼到 LINE 或簡訊給當事人' }), () => undefined)}>複製連結</button>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(`${made.name} 您好，已收到您的款項。請點以下連結選位並填寫資料：\n${base}/t/${made.code}`).then(() => setMsg({ kind: 'ok', text: '已複製連結與說明文字' }), () => undefined)}>複製連結＋說明文字</button>
            </div>
          </div>
        )}
      </details></div>
    </div>
    </div>
  );
}

/* ---------- 訂單 ---------- */
const ORDER_RANK: Record<string, number> = { pending: 0, held: 1, paid: 2, cancelled: 3, expired: 4 };
function Orders() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const list = st.orders.filter((o) => filter === 'all' || o.status === filter)
    .sort((a, b) => (ORDER_RANK[a.status] ?? 9) - (ORDER_RANK[b.status] ?? 9) || (a.status === 'pending' ? Date.parse(a.submittedAt ?? a.createdAt) - Date.parse(b.submittedAt ?? b.createdAt) : b.id - a.id));
  const o = st.orders.find((x) => x.id === openId) ?? null;
  const [modal, setModal] = useState<number | null>(() => (st.orders.find((x) => x.id === openId)?.status === 'pending' ? openId : null));
  const [after, setAfter] = useState<string | null>(null);
  const mo = st.orders.find((x) => x.id === modal && x.status === 'pending') ?? null;
  const next = (() => {
    const waiting = st.preorders.filter((p) => !p.waitlist && p.status !== 'cancelled' && unreleased(p).length > 0).sort(bySeq);
    return waiting.find((p) => unreleased(p).every((i) => readyFor(p, ik(i)))) ?? null;
  })();
  return (
    <div className="pstack">
      <div className="card" style={{ paddingBottom: 8 }}>
        <h2 style={{ margin: 0 }}>六、劃位確認 <span className="small muted">核對座位與持票人，確認後寄出 QR code。「等你確認」的排在最上面。</span></h2>
        {typeof window !== 'undefined' && window.innerWidth < 760 && <div className="note warn small" style={{ marginTop: 6 }}>建議用電腦核定，看座位比較清楚。</div>}
      </div>
      {after && (
        <div className="note ok" style={{ fontSize: 16 }}>✅ {after}
          {next ? <> 下一位：<b>第 {next.seq} 位 {next.name}</b> {next.phone && <a className="btn small" href={`tel:${next.phone}`}>📞 {next.phone}</a>}　<button className="btn small pri" onClick={() => go('links')}>到五發連結 →</button></> : ' 目前沒有已核好、等著發連結的人。'}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={() => setAfter(null)}>知道了</button>
        </div>
      )}
      {mo && <ConfirmModal o={mo} onClose={() => setModal(null)} onDone={(text) => { setModal(null); setAfter(text); }} />}
    <div className="grid2">
      <div className="card">
        <h2>劃位
          <select value={filter} style={{ width: 'auto' }} onChange={(e) => setFilter(e.target.value)}>
            {[['all', '全部'], ['held', '選位中'], ['pending', '待確認劃位'], ['paid', '劃位成功'], ['cancelled', '已取消'], ['expired', '逾時取消']].map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </h2>
        <div className="tbl"><table>
          <thead><tr><th>劃位編號</th><th>姓名</th><th>座位</th><th>金額</th><th>狀態</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} className={`click${o?.id === x.id ? ' cur' : ''}`} style={x.status === 'pending' ? { background: '#fff6e0' } : undefined} onClick={() => { openOrder(x); if (x.status === 'pending') setModal(x.id); }}>
                <td className="mono">{x.orderNo}</td><td>{x.buyerName}{x.linkNote && <><br /><span className="small muted">{x.linkNote}</span></>}
                  {st.paidByLink[x.linkId]?.over && <><br /><b className="small err-text">⚠ 劃的座位超過付款內容</b></>}</td>
                <td className="small">{x.seats.map((s) => s.code).join('、')}</td>
                <td className="mono">{money(x.amount)}</td>
                <td><span className={`pill p-${x.status}`}>{x.status === 'pending' ? '等你確認' : STATUS[x.status]}</span>{x.vip && <span className="pill" style={{ background: '#ecdffb', color: '#3b1d63', marginLeft: 4 }}>招待</span>}{x.isNew && <span className="badge">新</span>}
                  {x.status === 'held' && x.holdUntil && <><br /><span className="small muted">剩 {mmss(Date.parse(x.holdUntil) - now)}</span></>}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={5} className="muted">沒有符合的劃位</td></tr>}
          </tbody>
        </table></div>
      </div>
      <div className="side">{o ? <OrderDetail o={o} onOpen={() => setModal(o.id)} /> : <div className="card"><p className="muted small" style={{ margin: 0 }}>點「等你確認」的那一筆，會打開核定畫面。</p></div>}</div>
    </div>
    </div>
  );
}

/** 劃位核定：整張座位圖＋他的資料＋兩個必勾，確認後寄 QR code */
function ConfirmModal({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: (text: string) => void }) {
  const { st, act, busy, sure, confirm2, zoneById } = useAdmin();
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const mine = new Set(o.seats.map((x) => x.seatId));
  const pre = st.preorders.find((p) => p.linkCode && p.linkCode === o.linkCode);
  const paid = st.paidByLink[o.linkId];
  const look = (s: Seat): SeatLook => {
    const z = zoneById[s.zoneId];
    if (mine.has(s.id)) return { kind: 'free', bg: z?.color ?? '#f5c242', ink: z ? inkFor(z.color) : '#000', sel: true, title: `${s.label}（他選的）` };
    if (s.status !== 'free') return { kind: 'sold', bg: '#9aa3b2', ink: '#fff', title: `${s.label}・已有人` };
    return { kind: 'free', bg: z?.color, ink: z ? inkFor(z.color) : undefined, dim: true, title: `${s.label}・空位` };
  };
  const ok = c1 && c2;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)', zIndex: 60, overflow: 'auto', padding: 16 }} onClick={onClose}>
      <div className="card" style={{ maxWidth: 1280, margin: '0 auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>核定劃位 {o.orderNo}</h2>
          <button className="btn" onClick={onClose}>關閉</button>
        </div>
        <div className="grid2" style={{ marginTop: 8 }}>
          <AdminMap seats={st.seats} vipInstalled={st.event.vipInstalled} look={look} caption="紅框＝他選的；灰色＝別人已劃或待確認；淡色＝空位" />
          <div className="side">
            <div style={{ fontSize: 18 }}><b>{pre?.seq ? `第 ${pre.seq} 位　` : ''}{o.buyerName}</b></div>
            <div className="row" style={{ margin: '6px 0' }}>
              {o.buyerPhone && <a className="btn small" href={`tel:${o.buyerPhone}`}>📞 {o.buyerPhone}</a>}
              {pre?.lineName && <span className="small">LINE：{pre.lineName}</span>}
            </div>
            {paid && <div className={`note ${paid.over ? 'err' : 'ok'} small`}>{paid.over ? '⚠ 劃的座位超過付款內容，請核對' : '✅ 付款內容與劃位相符（系統已檢查）'}<br />{paid.text}</div>}
            <h3>座位</h3>
            <div style={{ fontSize: 16 }}>{o.seats.map((x) => x.label).join('、')}</div>
            <h3>持票人</h3>
            <div className="tbl"><table><tbody>
              {o.seats.map((x) => <tr key={x.seatId}><td className="small">{x.label}</td><td>{x.holderName ?? <span className="muted">未填</span>}</td></tr>)}
            </tbody></table></div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={CHK}><input type="checkbox" style={CHKI} checked={c1} onChange={(e) => setC1(e.target.checked)} />座位已和他確認</label>
              <label style={CHK}><input type="checkbox" style={CHKI} checked={c2} onChange={(e) => setC2(e.target.checked)} />持票人名字已確認</label>
            </div>
            {!st.notify.email.ready && <div className="note err small" style={{ marginTop: 8 }}>尚未設定 Gmail：確認後<b>不會寄出 Email</b>，QR code 只會顯示在他的劃位頁。</div>}
            <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy || !ok} onClick={() => confirm2(`cf${o.id}`, async () => {
              const r = await act({ action: 'order.confirm', id: o.id }) as { delivery?: Delivery } | null;
              if (r) { const d = deliveryText(r.delivery); onDone(`已確認 ${o.buyerName} 的劃位${d.bad ? `（${d.text}）` : '，已寄出 QR code'}。`); }
            })}>{!ok ? '請先勾上面兩項' : sure === `cf${o.id}` ? '再按一次：確認劃位，寄出 QR code' : '確認劃位，寄出 QR code'}</button>
            <ReasonCancel full label="退回讓他重選" go="確定退回並通知他" hint="原因會寫在寄給買方的通知裡。" onGo={async (reason) => {
              const r = await act({ action: 'order.cancel', id: o.id, reason }) as { delivery?: Delivery } | null;
              if (r) onDone(`已退回 ${o.buyerName} 的劃位，座位已釋放，他可以用同一個連結重選。`);
            }} />
          </div>
        </div>
      </div>
    </div>, document.body);
}


function OrderDetail({ o, onOpen }: { o: Order; onOpen?: () => void }) {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  return (
    <div className="card">
      <h2>劃位 {o.orderNo} <span className={`pill p-${o.status}`}>{STATUS[o.status]}</span></h2>
      <div className="bank">
        <span className="muted">購票人</span><span>{o.buyerName}</span>
        <span className="muted">手機</span><span className="mono">{o.buyerPhone || '—'}</span>
        <span className="muted">Email</span><span>{o.buyerEmail || '—'}</span>
        <span className="muted">連結</span><span><span className="mono">{o.linkCode}</span>{o.linkName && o.linkKind !== 'public' ? `・${o.linkName}` : ''}</span>
        {o.linkNote && <><span className="muted">來帳備註</span><span>{o.linkNote}</span></>}
        <span className="muted">購票方式</span><span>{o.comboName}</span>
        {st.paidByLink[o.linkId] && <><span className="muted">付款／已劃</span><span className={st.paidByLink[o.linkId].over ? 'err-text' : ''}>
          {st.paidByLink[o.linkId].text}（訂單 {st.paidByLink[o.linkId].preorderNo}）{st.paidByLink[o.linkId].over && <b><br />⚠ 劃的座位超過付款內容，請核對</b>}</span></>}
        <span className="muted">應付</span><span className="mono">{money(o.amount)}</span>
        <span className="muted">暫存時間</span><span>{tw(o.createdAt)}</span>
        {o.submittedAt && <><span className="muted">送出時間</span><span>{tw(o.submittedAt)}</span></>}
      </div>
      <h3>座位與實名</h3>
      <div className="tbl"><table><tbody>
        {o.seats.map((s) => <tr key={s.seatId}><td>{s.label}</td><td className="mono small">{s.code}</td><td>{s.holderName ?? <span className="muted">尚未填寫</span>}</td><td className="mono">{s.holderId4 ?? ''}</td></tr>)}
      </tbody></table></div>


      {o.status === 'held' && <>
        <div className="note" style={{ marginTop: 12 }}>對方正在填寫持票人資料，<b>尚未送出</b>。座位已先保留，剩 {mmss(Date.parse(o.holdUntil ?? '') - now)}，逾時自動釋放。</div>
        <ReasonCancel label="取消暫存（釋放座位）" go="確定取消暫存" hint="不會通知買方；原因記在操作紀錄。" onGo={(reason) => act({ action: 'order.cancel', id: o.id, reason }, '已取消暫存，座位已釋放')} />
      </>}

      {o.status === 'pending' && onOpen && <button className="btn pri" style={{ width: '100%', marginTop: 12 }} onClick={onOpen}>打開核定畫面（座位圖＋核對）</button>}
      {o.status === 'pending' && !onOpen && <>
        <h3>確認劃位</h3>
        {!st.notify.email.ready && <div className="note err" style={{ margin: '0 0 8px' }}>尚未設定 Gmail：按下後<b>不會寄出 Email</b>，只會顯示在對方的購票頁。請先到「八、通知設定」設定。</div>}
        <p className="small muted" style={{ margin: '0 0 6px' }}>款項已在預購單收訖。核對座位與持票人無誤後按下方按鈕：座位改為已售出，Email 寄出劃位成功通知並附每張票的入場 QR code，劃位頁也會顯示。{st.einvoice.enabled && st.einvoice.timing === 'auto' && ' 這筆訂單的電子發票已開立時，號碼會一併寫在信裡。'}</p>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn pri" style={{ flex: 1 }} disabled={busy} onClick={async () => {
            const r = await act({ action: 'order.confirm', id: o.id }) as { delivery?: Delivery } | null;
            if (r) { const d = deliveryText(r.delivery); setMsg({ kind: d.bad ? 'err' : 'ok', text: `已確認，劃位成功。${d.text}` }); }
          }}>確認劃位，寄出劃位成功與 QR code</button>
          <ReasonCancel label="取消劃位" go="確定取消並通知他" hint="原因會寫在寄給買方的通知裡。" onGo={async (reason) => { const r = await act({ action: 'order.cancel', id: o.id, reason }) as { delivery?: Delivery } | null; if (r) { const d = deliveryText(r.delivery); setMsg({ kind: d.bad ? 'err' : 'ok', text: `已取消劃位，座位已釋放。${d.text}` }); } }} />
        </div>
      </>}

      {o.status === 'paid' && o.payment && <>
        <h3>到帳紀錄</h3>
        <p className="small" style={{ margin: 0 }}>{o.payment.confirmedDate} 到帳 {money(o.payment.confirmedAmount ?? 0)}・確認人 {o.payment.confirmedBy}{o.payment.note ? `・${o.payment.note}` : ''}</p>
      </>}

      <div className="row" style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <button className="btn danger" disabled={busy} onClick={() => confirm2(`del${o.id}`, async () => { await act({ action: 'order.delete', id: o.id }, '已刪除訂單，座位已釋放'); setOpenId(null); })}>{sure === `del${o.id}` ? '再按一次確認刪除' : '刪除這筆訂單'}</button>
        <span className="small muted">座位會釋放，無法復原（操作紀錄會保留）</span>
      </div>
    </div>
  );
}

/* ---------- 入場券 ---------- */
function Tickets() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const paid = st.orders.filter((o) => o.status === 'paid');
  const [pick, setPick] = useState<Set<number>>(new Set(paid.map((o) => o.id)));
  const n = paid.filter((o) => pick.has(o.id)).reduce((a, o) => a + o.seats.length, 0);
  return (
    <div className="card">
      <h2>依劃位資料產生紙本入場券（備用） <span className="small muted">已選 {pick.size} 筆劃位・{n} 張</span></h2>
      <div className="row">
        {paid.map((o) => (
          <label key={o.id} className="switch small" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px' }}>
            <input type="checkbox" checked={pick.has(o.id)} onChange={(e) => { const s = new Set(pick); if (e.target.checked) s.add(o.id); else s.delete(o.id); setPick(s); }} />
            {o.orderNo} {o.buyerName}（{o.seats.length} 張）
          </label>
        ))}
        {!paid.length && <span className="muted">尚無已確認的劃位</span>}
      </div>
      <a className={`btn pri${pick.size ? '' : ' disabled'}`} style={{ marginTop: 12, display: 'inline-block' }}
        href={pick.size ? `/admin/tickets?ids=${[...pick].join(',')}` : undefined} target="_blank" rel="noreferrer">開啟列印頁</a>
      <p className="small muted">列印頁為 A4 每頁 4 張，每張含唯一序號與 QR code。用瀏覽器的列印功能列印，或另存成 PDF。</p>
    </div>
  );
}

/* ---------- 八、通知設定 ---------- */
function Notify() {
  const { st, act, busy, setMsg } = useAdmin();
  const ne = st.notify.email, ns = st.notify.sms;
  const [e, setE] = useState({ user: ne.user, pass: '', fromName: ne.fromName, host: ne.host, port: String(ne.port) });
  const [m, setM] = useState({ user: ns.user, pass: '', url: ns.url });
  const [adv, setAdv] = useState(ne.host !== 'smtp.gmail.com');
  const [to, setTo] = useState({ email: '', phone: '' });
  const [show, setShow] = useState<'all' | 'bad'>('all');
  const list = st.notifications.filter((x) => show === 'all' || x.status === 'failed' || x.status === 'simulated');
  const ok = (b: boolean) => b ? <span className="pill p-paid">已設定，會真的寄出</span> : <span className="pill p-cancelled">尚未設定，只存紀錄</span>;
  const test = async (channel: 'sms' | 'email') => {
    const r = await act({ action: 'notify.test', channel, to: channel === 'sms' ? to.phone : to.email });
    if (r) setMsg({ kind: 'ok', text: channel === 'sms' ? `測試簡訊已送出到 ${to.phone}，請看手機是否收到。` : `測試信已寄到 ${to.email}，請看信箱（也看看垃圾郵件匣）。` });
  };
  return (
    <div className="pstack">
      <div className="card">
        <h2>通知寄送狀態</h2>
        <div className="bank">
          <span className="muted">Email</span><span>{ok(ne.ready)}{ne.ready && <span className="small muted">　寄件：{ne.user}</span>}</span>
          <span className="muted">簡訊</span><span>{ok(ns.ready)}{ns.ready && <span className="small muted">　三竹帳號：{ns.user}</span>}</span>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>買方送出預購單、確認收訖（寄劃位連結）、送出劃位、確認劃位（寄 QR code）、取消時，系統會自動寄出。失敗會自動重試 3 次，下方「通知紀錄」可看結果與原因，也可以重寄。</p>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Email（Gmail）</h2>
          <form onSubmit={async (ev) => {
            ev.preventDefault();
            if (!e.user.trim()) { setMsg({ kind: 'err', text: '請填寫寄件 Email' }); return; }
            if (!ne.passSet && !e.pass.trim()) { setMsg({ kind: 'err', text: '請填寫應用程式密碼' }); return; }
            const values: Record<string, string> = { 'email.user': e.user.trim(), 'email.pass': e.pass.replace(/\s/g, ''), 'email.fromName': e.fromName.trim(),
              'email.host': adv ? e.host.trim() : 'smtp.gmail.com', 'email.port': adv ? e.port.trim() : '465' };
            if (await act({ action: 'notify.save', values }, '已儲存 Email 設定，建議寄一封測試信確認')) setE({ ...e, pass: '' });
          }}>
            <label className="f">寄件 Email<input value={e.user} placeholder="例：ticket.yourname@gmail.com" autoComplete="off" onChange={(x) => setE({ ...e, user: x.target.value })} /></label>
            <label className="f" style={{ marginTop: 8 }}>應用程式密碼（16 碼）<input type="password" value={e.pass} autoComplete="new-password"
              placeholder={ne.passSet ? '已設定；要更換才需要填' : 'Google 帳戶 → 安全性 → 應用程式密碼'} onChange={(x) => setE({ ...e, pass: x.target.value })} /></label>
            <label className="f" style={{ marginTop: 8 }}>寄件人名稱（消費者看到的）<input value={e.fromName} placeholder="例：主辦單位名稱" onChange={(x) => setE({ ...e, fromName: x.target.value })} /></label>
            <label className="switch small" style={{ marginTop: 8 }}><input type="checkbox" checked={adv} onChange={(x) => setAdv(x.target.checked)} />不是用 Gmail（自訂寄信伺服器）</label>
            {adv && <div className="fields" style={{ marginTop: 6 }}>
              <label className="f">SMTP 主機<input value={e.host} onChange={(x) => setE({ ...e, host: x.target.value })} /></label>
              <label className="f">連接埠<input value={e.port} inputMode="numeric" onChange={(x) => setE({ ...e, port: x.target.value })} /></label>
            </div>}
            <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy}>儲存 Email 設定</button>
          </form>
          <h3>寄測試信</h3>
          <div className="row">
            <input style={{ flex: 1 }} value={to.email} placeholder="收件 Email" onChange={(x) => setTo({ ...to, email: x.target.value })} />
            <button className="btn" disabled={busy || !ne.ready} onClick={() => test('email')}>寄測試信</button>
          </div>
        </div>

        <div className="card">
          <h2>簡訊（三竹 Mitake）</h2>
          <form onSubmit={async (ev) => {
            ev.preventDefault();
            if (!m.user.trim()) { setMsg({ kind: 'err', text: '請填寫三竹帳號' }); return; }
            if (!ns.passSet && !m.pass.trim()) { setMsg({ kind: 'err', text: '請填寫三竹密碼' }); return; }
            if (!/^https:\/\/\S+$/.test(m.url.trim())) { setMsg({ kind: 'err', text: 'API 網址應以 https:// 開頭' }); return; }
            if (await act({ action: 'notify.save', values: { 'sms.user': m.user.trim(), 'sms.pass': m.pass, 'sms.url': m.url.trim() } }, '已儲存簡訊設定，建議發一則測試簡訊確認')) setM({ ...m, pass: '' });
          }}>
            <label className="f">三竹帳號<input value={m.user} autoComplete="off" onChange={(x) => setM({ ...m, user: x.target.value })} /></label>
            <label className="f" style={{ marginTop: 8 }}>三竹密碼<input type="password" value={m.pass} autoComplete="new-password"
              placeholder={ns.passSet ? '已設定；要更換才需要填' : ''} onChange={(x) => setM({ ...m, pass: x.target.value })} /></label>
            <label className="f" style={{ marginTop: 8 }}>API 網址（三竹開通時提供；一般不用改）<input value={m.url} onChange={(x) => setM({ ...m, url: x.target.value })} /></label>
            <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy}>儲存簡訊設定</button>
          </form>
          <h3>發測試簡訊</h3>
          <div className="row">
            <input style={{ flex: 1 }} value={to.phone} inputMode="tel" maxLength={13} placeholder="手機 09xxxxxxxx" onChange={(x) => setTo({ ...to, phone: x.target.value })} />
            <button className="btn" disabled={busy || !ns.ready} onClick={() => test('sms')}>發測試簡訊</button>
          </div>
          {to.phone && phoneProblem(to.phone) && <div className="small" style={{ color: 'var(--red)' }}>{phoneProblem(to.phone)}</div>}
          <p className="small muted">每則簡訊依字數計費，70 字以內算 1 則；劃位成功通知約 2–3 則。</p>
        </div>
      </div>

      <div className="card">
        <h2>通知紀錄 <span className="small muted">最近 100 則</span></h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="switch small"><input type="radio" checked={show === 'all'} onChange={() => setShow('all')} />全部</label>
          <label className="switch small"><input type="radio" checked={show === 'bad'} onChange={() => setShow('bad')} />只看沒寄出的（{st.notifications.filter((x) => x.status === 'failed' || x.status === 'simulated').length}）</label>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>時間</th><th>內容</th><th>管道</th><th>收件人</th><th>結果</th><th></th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id}>
                <td className="small">{tw(x.createdAt)}</td>
                <td><span title={x.content}>{N_TEMPLATE[x.template] ?? x.template}</span></td>
                <td>{CH[x.channel] ?? x.channel}</td>
                <td className="mono small">{x.recipient || '—'}</td>
                <td>
                  <span className={`pill ${x.status === 'sent' ? 'p-paid' : x.status === 'queued' ? 'p-pending' : 'p-cancelled'}`}>{x.status === 'queued' && x.sendAfter && Date.parse(x.sendAfter) > Date.now() ? `排定 ${tw(x.sendAfter)} 寄出` : nStatus(x.channel, x.status)}</span>
                  {x.error && x.status !== 'sent' && <div className="small" style={{ color: 'var(--red)' }}>{x.error}</div>}
                </td>
                <td>{(x.status === 'failed' || (x.status === 'simulated' && x.channel !== 'push')) && x.recipient &&
                  <button className="btn small" disabled={busy} onClick={async () => {
                    const r = await act({ action: 'notify.resend', id: x.id }) as { status: string; error: string | null } | null;
                    if (r) setMsg({ kind: r.status === 'sent' ? 'ok' : 'err', text: r.status === 'sent' ? '已重寄成功' : `重寄結果：${N_STATUS[r.status] ?? r.status}${r.error ? `（${r.error}）` : ''}` });
                  }}>重寄</button>}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={6} className="muted">沒有通知</td></tr>}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

/* ---------- 連座分組 ---------- */
type Scope = { rows: number[]; blocks: string[] };
type Ask = { title: string; groups: number; manual: number; run: () => Promise<void> };
const GROUP_COLORS = ['#9fd8c8', '#c9c2f0', '#ffd29d', '#b8ccf3', '#f5c4c4', '#d9e7a8'];

function Groups() {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Set<number>>(new Set());
  const [blks, setBlks] = useState<Set<string>>(new Set());
  const [rowText, setRowText] = useState('');
  const [size, setSize] = useState('10');
  const [shape, setShape] = useState<'row' | 'band2' | 'band3'>('band2');
  const [cross, setCross] = useState(true);
  const [useSkip, setUseSkip] = useState(true);
  const [note, setNote] = useState<{ err: boolean; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  const { groups } = bundleIndex(st.seats);
  /** 這些範圍裡現有幾組、其中幾組是手工設的（套用前提醒用） */
  const affected = (scopes: Scope[]) => {
    const keys = new Set<string>();
    for (const s of st.seats) {
      if (s.bundle && scopes.some((sc) => sc.rows.includes(s.row) && (!sc.blocks.length || sc.blocks.includes(s.block)))) keys.add(s.bundle);
    }
    return { groups: keys.size, manual: [...keys].filter((k) => k.includes('-m-')).length };
  };
  const unsaved = groups.size > 0 && !st.bundleSaved?.same;
  const confirmChange = (title: string, scopes: Scope[], run: () => Promise<void>) => setAsk({ title, ...affected(scopes), run });
  // 依位置編號（前排、左邊優先），相鄰組用不同顏色
  const ordered = [...groups.entries()].sort((a, b) => Math.min(...a[1].map((s) => s.y)) - Math.min(...b[1].map((s) => s.y)) || Math.min(...a[1].map((s) => s.x)) - Math.min(...b[1].map((s) => s.x)));
  const info = new Map(ordered.map(([k, g], i) => [k, { no: i + 1, size: g.length, color: GROUP_COLORS[i % GROUP_COLORS.length] }]));
  const sizes = new Map<number, number>();
  ordered.forEach(([, g]) => sizes.set(g.length, (sizes.get(g.length) ?? 0) + 1));
  const sizeText = [...sizes].sort((a, b) => b[0] - a[0]).map(([n, c]) => `${n} 位 × ${c} 組`).join('、');
  const selSeats = st.seats.filter((s) => sel.has(s.id));

  const look = (s: Seat): SeatLook => {
    const g = s.bundle ? info.get(s.bundle) : undefined;
    return {
      kind: 'free', bg: g ? g.color : '#ffffff', ink: '#18213a', dim: s.status !== 'free', sel: pairMode ? pending === s.id : sel.has(s.id),
      title: `${s.label}・${s.code}・${g ? `第 ${g.no} 組（${g.size} 位）` : '單人'}${s.status !== 'free' ? '・已有訂單' : ''}`,
    };
  };
  // 快速配對：點一席、再點一席，馬上成一組
  const [pairMode, setPairMode] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const labelOf = (id: string) => st.seats.find((x) => x.id === id)?.label ?? id;
  const paint = async (ids: string[]) => {
    setNote(null);
    if (pairMode) {
      const id = ids[ids.length - 1];
      const s = st.seats.find((x) => x.id === id);
      if (!s) return;
      if (s.status !== 'free') { setMsg({ kind: 'err', text: `${s.label} 已有訂單，不能改分組` }); return; }
      if (!pending) { setPending(id); return; }
      if (pending === id) { setPending(null); return; }
      const a = pending;
      setPending(null);
      const r = await act({ action: 'bundle.manual', seatIds: [a, id] }) as { size: number } | null;
      if (r) setMsg({ kind: 'ok', text: `已配對：${labelOf(a)} ＋ ${labelOf(id)}` });
      return;
    }
    setSel((p) => { const n = new Set(p); const allOn = ids.every((i) => n.has(i)); ids.forEach((i) => (allOn ? n.delete(i) : n.add(i))); return n; });
  };
  const selectWholeGroups = () => {
    const keys = new Set(selSeats.map((s) => s.bundle).filter(Boolean));
    setSel(new Set(st.seats.filter((s) => s.bundle && keys.has(s.bundle)).map((s) => s.id)));
  };

  async function auto() {
    const r = await act({ action: 'bundle.auto', rows: [...rows], blocks: [...blks], size: parseInt(size) || 0, shape, crossAisle: cross, skip: useSkip ? [...sel] : [] }) as
      { groups: number; leftovers: string[]; skipped: number; crossAisle: number } | null;
    if (!r) return;
    setNote({ err: r.leftovers.length > 0, text: `已建立 ${r.groups} 組（每組 ${size} 位）${r.crossAisle ? `，其中 ${r.crossAisle} 組跨走道` : ''}${r.skipped ? `；略過 ${r.skipped} 席維持單人` : ''}${r.leftovers.length ? `；湊不滿一組、維持單人 ${r.leftovers.length} 席：${r.leftovers.slice(0, 12).join('、')}${r.leftovers.length > 12 ? '…' : ''}` : ''}` });
    setSel(new Set());
  }

  return (
    <div className="grid2">
      <AdminMap seats={st.seats} vipInstalled={st.event.vipInstalled} look={look} onPaint={paint}
        caption="同一顏色＝同一組；白色＝單人。點按或拖曳可選取座位（紅框），再按一次取消" />
      <div className="side">
        {ask && createPortal(
          <div className="ask-overlay" onClick={() => setAsk(null)}>
            <div className="card ask-box" onClick={(e) => e.stopPropagation()}>
              <h2>確定要{ask.title}嗎？</h2>
              <p style={{ margin: '0 0 8px' }}>這個範圍內現有的 <b>{ask.groups} 組</b>會先全部拆掉，再依規則重新分。</p>
              {ask.manual > 0 && <div className="note err" style={{ marginBottom: 8 }}>其中有 <b>{ask.manual} 組是手工設定的</b>，套用後會消失。</div>}
              {unsaved
                ? <div className="note warn" style={{ marginBottom: 8 }}>目前的分組<b>還沒儲存</b>。建議先按「先儲存，再套用」，以後可以用「還原到存檔」找回來。</div>
                : <p className="small muted" style={{ margin: '0 0 8px' }}>目前的分組已經儲存過，之後可以用「還原到存檔」找回來。</p>}
              <p className="small muted" style={{ margin: '0 0 10px' }}>就算直接套用，也可以馬上按「復原上一次」回到套用前的樣子。</p>
              <div className="row">
                {unsaved && <button className="btn pri" disabled={busy} onClick={async () => { const a = ask; setAsk(null); if (await act({ action: 'bundle.snapshot.save' })) await a.run(); }}>先儲存，再套用</button>}
                <button className={`btn${unsaved ? '' : ' pri'}`} disabled={busy} onClick={async () => { const a = ask; setAsk(null); await a.run(); }}>{unsaved ? '不儲存，直接套用' : '確定套用'}</button>
                <button className="btn" onClick={() => setAsk(null)}>取消</button>
              </div>
            </div>
          </div>, document.body,
        )}

        <div className="card">
          <h2>分組存檔</h2>
          {st.bundleSaved
            ? <p style={{ margin: 0 }}>上次儲存：{tw(st.bundleSaved.at)}（{st.bundleSaved.groups} 組，{st.bundleSaved.by}）<br />
                {st.bundleSaved.same ? <span className="ok-text">✓ 目前分組和存檔相同</span> : <b className="err-text">目前分組有變更，還沒儲存</b>}</p>
            : <p style={{ margin: 0 }}><b className="err-text">還沒儲存過。</b>手工調整完，請按「儲存目前分組」。</p>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn pri" disabled={busy || !groups.size} onClick={async () => {
              const r = await act({ action: 'bundle.snapshot.save' }) as { groups: number } | null;
              if (r) setMsg({ kind: 'ok', text: `已儲存目前分組（${r.groups} 組）` });
            }}>儲存目前分組</button>
            <button className="btn" disabled={busy || !st.bundleSaved || st.bundleSaved.same} onClick={() => confirm2('snap-restore', async () => {
              const r = await act({ action: 'bundle.snapshot.restore', which: 'saved' }) as { seats: number } | null;
              if (r) setMsg({ kind: 'ok', text: `已還原到存檔（調整了 ${r.seats} 席）` });
            })}>{sure === 'snap-restore' ? '再按一次確認還原' : '還原到存檔'}</button>
            <button className="btn" disabled={busy || !st.bundleUndo || st.bundleUndo.same} title="回到上一次「自動分組／套用預設／取消分組」之前的樣子" onClick={() => confirm2('snap-undo', async () => {
              const r = await act({ action: 'bundle.snapshot.restore', which: 'undo' }) as { seats: number } | null;
              if (r) setMsg({ kind: 'ok', text: `已復原（調整了 ${r.seats} 席）；再按一次「復原上一次」可回到剛才` });
            })}>{sure === 'snap-undo' ? '再按一次確認復原' : '復原上一次'}</button>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>「還原到存檔」回到你最後一次按「儲存目前分組」的樣子。「復原上一次」回到最近一次自動分組、套用預設或取消分組之前的樣子。</p>
        </div>

        <Presets sel={sel} setSel={setSel} confirmChange={confirmChange} />
        <div className="card">
          <h2>目前分組</h2>
          <p style={{ margin: 0 }}>{sizeText || <span className="muted">尚未分組</span>}</p>
          <p className="small muted" style={{ margin: '4px 0 0' }}>消費者按組內任一位，就會選到整組；只能整組一起訂。游標停在座位上可看第幾組。</p>
        </div>

        <div className="card">
          <h2>手工設定分組 <span className="small muted">已選取 <b>{sel.size}</b> 位</span></h2>
          <label className="switch" style={{ margin: '0 0 6px' }}><input type="checkbox" checked={pairMode} onChange={(e) => { setPairMode(e.target.checked); setPending(null); setSel(new Set()); }} /><b>快速配對（兩位一組）</b></label>
          {pairMode && (
            <div className="note ok" style={{ marginBottom: 8 }}>
              {pending ? <>已點 <b>{labelOf(pending)}</b>，請點要和他同一組的座位（再點一次取消）。</> : <>點第一席，再點旁邊那一席，兩席馬上成一組。可以一直點下去。</>}
              <div className="small" style={{ marginTop: 4 }}>點到已經在別組的座位，會把它移到新的這一組（原組只剩一人時自動改回單人）。全部配好後記得按「儲存目前分組」。</div>
            </div>
          )}
          {!pairMode && <>
          <ol className="steps">
            <li>在左邊座位圖上，<b>點選要放在同一組的座位</b>（出現紅框＝已選）。可以按住拖曳一次選多位；座位不必相鄰，也可以分在走道兩邊。點錯再點一次就取消。</li>
            <li>看上面「已選取 <b>{sel.size}</b> 位」，確認人數正確。</li>
            <li>按 <b>「設為一組」</b>。這些座位原本屬於哪一組，會自動從那組移出。</li>
            <li>檢查被拆到的組：點那一組的任一位，按「選取整組」，看人數對不對；不對就重選後再「設為一組」。</li>
            <li>全部弄好後，到上方「分組存檔」按 <b>「儲存目前分組」</b>。</li>
          </ol>
          <div className="row">
            <button className="btn pri" disabled={busy || sel.size < 2} onClick={async () => {
              const r = await act({ action: 'bundle.manual', seatIds: [...sel] }) as { size: number } | null;
              if (r) { setMsg({ kind: 'ok', text: `已把 ${r.size} 位設為一組。全部調整好後，記得按「儲存目前分組」。` }); setSel(new Set()); }
            }}>設為一組</button>
            <button className="btn" disabled={busy || !sel.size} onClick={async () => {
              const r = await act({ action: 'bundle.remove', seatIds: [...sel] }) as { removed: number } | null;
              if (r) { setMsg({ kind: 'ok', text: `已把 ${r.removed} 位改回單人` }); setSel(new Set()); }
            }}>改回單人</button>
            <button className="btn" disabled={!selSeats.some((s) => s.bundle)} onClick={selectWholeGroups}>選取整組</button>
            <button className="btn" disabled={!sel.size} onClick={() => setSel(new Set())}>清除選取</button>
          </div>
          {selSeats.length > 0 && <p className="small" style={{ margin: '6px 0 0' }}>已選：{selSeats.slice(0, 20).map((s) => s.label).join('、')}{selSeats.length > 20 ? `…共 ${selSeats.length} 位` : ''}</p>}
          <p className="small muted" style={{ margin: '6px 0 0' }}>其他用法：要讓某幾席<b>不分組</b>（單人購買），選取後按「改回單人」。游標停在座位上可看它是第幾組、幾位。</p>
          </>}
        </div>

        <div className="card">
          <h2>自動分組</h2>
          <h3>排（點選，或直接輸入）</h3>
          <div className="chips">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1].map((r) => (
              <button key={r} className={`chip${rows.has(r) ? ' on' : ''}`} onClick={() => { const n = toggle(rows, r); setRows(n); setRowText(rowsText(n)); }}>
                {r === 0 ? 'VIP' : r === -1 ? '輪椅' : r}
              </button>
            ))}
          </div>
          <input value={rowText} placeholder="例：4-12" style={{ marginTop: 6 }} onChange={(e) => setRowText(e.target.value)}
            onBlur={() => { const p = parseRows(rowText); setRows(p.set); setNote(p.bad.length ? { err: true, text: `看不懂「${p.bad.join('、')}」，例如 4-12` } : null); }} />
          <h3>區塊 <span className="small muted">（不選＝全部區塊）</span></h3>
          <div className="chips">
            {BLOCKS.map(([b, n]) => <button key={b} className={`chip${blks.has(b) ? ' on' : ''}`} onClick={() => setBlks(toggle(blks, b))}>{b} {n}</button>)}
          </div>
          <div className="fields" style={{ marginTop: 8 }}>
            <label className="f">每組人數<input value={size} inputMode="numeric" onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))} /></label>
            <label className="f">形狀
              <select value={shape} onChange={(e) => setShape(e.target.value as typeof shape)}>
                <option value="row">同一排左右（例：兩位一組）</option>
                <option value="band2">兩排一起（例：5 位寬 × 2 排）</option>
                <option value="band3">三排一起</option>
              </select>
            </label>
          </div>
          <label className="switch small" style={{ marginTop: 8 }}><input type="checkbox" checked={cross} onChange={(e) => setCross(e.target.checked)} />可跨走道（座位數不是人數的倍數時，才能全部分完）</label>
          <label className="switch small"><input type="checkbox" checked={useSkip} onChange={(e) => setUseSkip(e.target.checked)} />略過座位圖上選取的 {sel.size} 位（維持單人）</label>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn pri" disabled={busy || !rows.size} onClick={() => confirmChange('自動分組', [{ rows: [...rows], blocks: [...blks] }], auto)}>自動分組</button>
            <button className="btn" disabled={busy || !rows.size} onClick={() => confirmChange('取消這些排的分組', [{ rows: [...rows], blocks: [...blks] }], async () => {
              const r = await act({ action: 'bundle.clear', rows: [...rows], blocks: [...blks] }) as { cleared: number } | null;
              if (r) setNote({ err: false, text: r.cleared ? `已取消 ${r.cleared} 組，這些排改回單人選位` : '這些座位原本就沒有分組' });
            })}>取消這些排的分組</button>
          </div>
          {note && <div className={`note ${note.err ? 'warn' : 'ok'}`} style={{ marginTop: 8 }}>{note.text}</div>}
          <p className="small muted" style={{ margin: '8px 0 0' }}>選定範圍原有的分組會先拆掉再重新分；已有訂單的座位不能改。自動分完可再用「手動調整」微調。</p>
        </div>
      </div>
    </div>
  );
}

/* 預設分組：系統先放好常用規則，主辦方可修改、新增、刪除，按一下套用 */
type Preset = State['bundlePresets'][number];
const SHAPE_NAME: Record<string, string> = { row: '同一排左右', band2: '兩排一起', band3: '三排一起' };

function Presets({ sel, setSel, confirmChange }: { sel: Set<string>; setSel: (s: Set<string>) => void; confirmChange: (title: string, scopes: Scope[], run: () => Promise<void>) => void }) {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const [list, setList] = useState<Preset[]>(st.bundlePresets);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const label = Object.fromEntries(st.seats.map((s) => [s.id, s.label]));
  const upd = (i: number, v: Partial<Preset>) => { setList(list.map((p, k) => (k === i ? { ...p, ...v } : p))); setDirty(true); };
  const save = async () => {
    const r = await act({ action: 'bundle.presets.save', presets: list }, '已儲存預設分組') as Preset[] | null;
    if (r) { setList(r); setDirty(false); }
    return !!r;
  };
  const apply = async (index?: number) => {
    if (dirty && !(await save())) return;
    const r = await act({ action: 'bundle.presets.apply', ...(index === undefined ? {} : { index }) }) as
      { name: string; groups: number; size: number; leftovers: number; skipped: number; crossAisle: number }[] | null;
    if (r) setMsg({ kind: r.some((x) => x.leftovers) ? 'warn' : 'ok', text: '已套用：' + r.map((x) => `${x.name} ${x.groups} 組（${x.size} 位一組${x.crossAisle ? `，${x.crossAisle} 組跨走道` : ''}${x.skipped ? `，略過 ${x.skipped} 席` : ''}${x.leftovers ? `，${x.leftovers} 席湊不滿維持單人` : ''}）`).join('；') });
  };
  const blockChip = (i: number, p: Preset, b: string) => (
    <button key={b} className={`chip${p.blocks.includes(b) ? ' on' : ''}`} style={{ padding: '2px 8px' }}
      onClick={() => upd(i, { blocks: p.blocks.includes(b) ? p.blocks.filter((x) => x !== b) : [...p.blocks, b] })}>{b}</button>
  );
  return (
    <div className="card">
      <h2>預設分組 <span className="small muted">可修改，按一下套用</span></h2>
      {list.map((p, i) => (
        <div key={i} className="note" style={{ marginBottom: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{p.name || '（未命名）'}</b>
            <span className="row">
              <button className="btn small pri" disabled={busy} onClick={() => confirmChange(`套用「${p.name}」`, [p], () => apply(i))}>套用</button>
              <button className="btn small" onClick={() => setOpen(open === i ? null : i)}>{open === i ? '收起' : '修改'}</button>
            </span>
          </div>
          <div className="small muted">
            第 {rowsText(new Set(p.rows))} 排・{p.blocks.length ? p.blocks.join('、') : '全部區塊'}・{p.size} 位一組・{SHAPE_NAME[p.shape]}{p.crossAisle ? '・可跨走道' : ''}{p.skip.length ? `・略過 ${p.skip.length} 席` : ''}
          </div>
          {open === i && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="f">名稱<input value={p.name} onChange={(e) => upd(i, { name: e.target.value })} /></label>
              <label className="f">排（例：4-12）<input key={`r${i}-${p.rows.join()}`} defaultValue={rowsText(new Set(p.rows))}
                onBlur={(e) => { const q = parseRows(e.target.value); if (q.bad.length) setMsg({ kind: 'err', text: `看不懂「${q.bad.join('、')}」` }); else upd(i, { rows: [...q.set].sort((a, b) => a - b) }); }} /></label>
              <div><span className="small muted">區塊（不選＝全部）</span><div className="chips">{BLOCKS.map(([b]) => blockChip(i, p, b))}</div></div>
              <div className="fields">
                <label className="f">每組人數<input value={p.size} inputMode="numeric" onChange={(e) => upd(i, { size: parseInt(e.target.value.replace(/\D/g, '')) || 0 })} /></label>
                <label className="f">形狀<select value={p.shape} onChange={(e) => upd(i, { shape: e.target.value as Preset['shape'] })}>
                  {Object.entries(SHAPE_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                </select></label>
              </div>
              <label className="switch small"><input type="checkbox" checked={p.crossAisle} onChange={(e) => upd(i, { crossAisle: e.target.checked })} />可跨走道</label>
              <div className="small">略過（維持單人）：{p.skip.length ? p.skip.map((id) => label[id] ?? id).join('、') : <span className="muted">無</span>}</div>
              <div className="row">
                <button className="btn small" disabled={!sel.size} onClick={() => { upd(i, { skip: [...sel] }); setSel(new Set()); }}>改成圖上選取的 {sel.size} 位</button>
                <button className="btn small" disabled={!p.skip.length} onClick={() => setSel(new Set(p.skip))}>在圖上顯示</button>
                <button className="btn small" disabled={!p.skip.length} onClick={() => upd(i, { skip: [] })}>清空略過</button>
                <button className="btn small danger" onClick={() => confirm2(`pdel${i}`, () => { setList(list.filter((_, k) => k !== i)); setDirty(true); setOpen(null); })}>{sure === `pdel${i}` ? '再按一次確認' : '刪除這條'}</button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="row">
        <button className="btn pri" disabled={busy || !list.length} onClick={() => confirmChange('全部套用預設分組', list, () => apply())}>全部套用</button>
        {dirty && <button className="btn" disabled={busy} onClick={save}>儲存修改</button>}
        <button className="btn" onClick={() => { setList([...list, { name: `新的分組 ${list.length + 1}`, rows: [], blocks: [], size: 2, shape: 'row', crossAisle: false, skip: [] }]); setOpen(list.length); setDirty(true); }}>＋新增一條</button>
        <button className="btn" disabled={busy} onClick={() => confirm2('preset-reset', async () => { const r = await act({ action: 'bundle.presets.save', presets: null }, '已恢復系統預設') as Preset[] | null; if (r) { setList(r); setDirty(false); setOpen(null); } })}>{sure === 'preset-reset' ? '再按一次確認' : '恢復預設'}</button>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>套用時，該條範圍原有的分組（包含手工設定的）會先拆掉重分，按下後會再問一次；已有訂單的座位不能改。修改這裡的規則記得按「儲存修改」（按「套用」也會先自動儲存）。</p>
    </div>
  );
}

/* ---------- 訂單 ---------- */
/** Google 表單連接：Apps Script 安裝步驟 */
function FormCard() {
  const { st, setMsg } = useAdmin();
  const url = `${st.form.base}/api/form-in?key=${st.form.key}`;
  const n = st.preorders.filter((p) => p.source === 'form').length;
  const wait = st.preorders.filter((p) => p.source === 'form' && p.status === 'submitted').length;
  return (
    <div className="card">
      <h2>Google 表單報名 <span className="small muted">已收到 {n} 筆，待確認 {wait} 筆</span></h2>
      <p className="small" style={{ marginTop: 0 }}>老闆的 Google 表單每有人送出（以及每 5 分鐘），會自動出現在下面「待確認」。
        點開那一筆 → <b>設定他可以劃的內容與數量</b> → 勾「已匯款」「已入群」→ 輪到時按「發出劃位連結」。</p>
      <details>
        <summary style={{ cursor: 'pointer' }}><b>第一次設定（只做一次，約 3 分鐘）</b>{n > 0 && <span className="small muted">　已連接完成</span>}</summary>
        <ol className="small" style={{ lineHeight: 1.9 }}>
          <li>用<b>能編輯這份表單的 Google 帳號</b>打開表單的編輯畫面（不是填寫畫面）。</li>
          <li>右上角「⋮」→「<b>Apps Script</b>」（或「指令碼編輯器」），會開一個程式頁面。</li>
          <li>把裡面原有的字全部刪掉，按下面「複製程式碼」，貼上，按上方的磁碟圖示儲存。</li>
          <li>上方函式選單選「<b>install</b>」→ 按「<b>執行</b>」→ 跳出授權時選你的帳號 →「進階」→「前往（不安全）」→「允許」。<br />
            （這是你自己的程式，Google 一律這樣提醒，是正常的。）</li>
          <li>回到這裡重新整理，已經填過表單的人會全部出現在下面。</li>
        </ol>
        <div className="row">
          <button className="btn pri" onClick={() => navigator.clipboard?.writeText(appsScript(url)).then(() => setMsg({ kind: 'ok', text: '已複製程式碼，貼到 Apps Script' }), () => setMsg({ kind: 'err', text: '無法複製，請手動選取下面的程式碼' }))}>複製程式碼</button>
        </div>
        <textarea readOnly value={appsScript(url)} rows={6} className="mono small" style={{ width: '100%', marginTop: 8 }} onFocus={(e) => e.currentTarget.select()} />
        <p className="small muted" style={{ marginBottom: 0 }}>程式碼裡的網址含密碼，請只貼在表單的 Apps Script，不要轉傳。</p>
      </details>
    </div>
  );
}

/** 給買方的認購登記邀請文字（貼 LINE 用）：開頭取自「預購單開頭文字」第一段 */
function inviteText(st: State, url: string) {
  const first = st.preorderSettings.intro.split(/\n\s*\n/)[0].split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('##'));
  return [`【${st.event.name}】認購登記`, '', ...first, '',
    '👉 請點以下連結，選擇認購方案並完成登記：', url, '',
    '・依登記的先後順序安排劃位',
    '・完成匯款後，我們會依序通知您劃位',
    '・有任何問題，歡迎直接與我們聯繫 🙏'].join('\n');
}

/** 預購單的流程說明圖（選用）：上傳後顯示在預購單說明下方，買方點圖可放大 */
function FlowImageSetting() {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const upload = (file: File) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      // 縮到寬 1800 以內、轉成 JPG，檔案小、手機開得快
      const k = Math.min(1, 1800 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      act({ action: 'preorder.flowImage', dataUrl: c.toDataURL('image/jpeg', 0.86) }, '已上傳流程說明圖，預購單重新整理就會看到');
    };
    img.onerror = () => setMsg({ kind: 'err', text: '讀不到這張圖，請用 JPG 或 PNG' });
    img.src = url;
  };
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>流程說明圖（選用）</h3>
      <p className="small muted" style={{ margin: '0 0 6px' }}>上傳後顯示在預購單說明下方，買方點圖可放大。不上傳就不顯示。</p>
      {st.flowImage && <img src={`/api/buy/flow-image?v=${st.flowImage}`} alt="流程說明圖" style={{ width: '100%', maxWidth: 480, borderRadius: 8, border: '1px solid var(--line)', display: 'block', marginBottom: 6 }} />}
      <div className="row">
        <label className="btn small" style={{ cursor: 'pointer' }}>{st.flowImage ? '換一張圖' : '上傳圖片'}
          <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>
        {st.flowImage && <button className="btn small danger" disabled={busy} onClick={() => confirm2('flowdel', () => act({ action: 'preorder.flowImage', dataUrl: null }, '已移除流程說明圖'))}>{sure === 'flowdel' ? '再按一次確認移除' : '移除'}</button>}
      </div>
    </div>
  );
}

/** 預購單的系統設定：開頭文字、候補數量、送單上限 */
function PreorderSettings() {
  const { st, act, busy } = useAdmin();
  const ps = st.preorderSettings;
  const [intro, setIntro] = useState(ps.intro);
  const [wait, setWait] = useState(String(ps.waitlistCap));
  const [rate, setRate] = useState(String(ps.rateLimit));
  return (
    <div style={{ marginTop: 14 }}>
      <FlowImageSetting />
      <h3 style={{ margin: '14px 0 4px' }}>預購單開頭文字</h3>
      <p className="small muted" style={{ margin: '0 0 6px' }}>顯示在預購單最上面。「## 」開頭的一行是小標題，「1. 」開頭是步驟，空一行就分段。</p>
      <textarea value={intro} rows={12} style={{ width: '100%' }} onChange={(e) => setIntro(e.target.value)} />
      <button className="btn small" style={{ marginTop: 4 }} onClick={() => setIntro(ps.defaultIntro)}>恢復系統預設文字（按了還要按下方「儲存」）</button>
      <div className="fields" style={{ marginTop: 8 }}>
        <label className="f">每個方案可候補幾份（0＝不開放候補）<input value={wait} inputMode="numeric" onChange={(e) => setWait(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="f">同一網路 10 分鐘內最多送出幾張（防灌單）<input value={rate} inputMode="numeric" onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <button className="btn pri" style={{ marginTop: 8 }} disabled={busy} onClick={() => act({ action: 'preorder.settings', intro, waitlistCap: parseInt(wait || '0'), rateLimit: Math.max(1, parseInt(rate || '100')) }, '已儲存預購單設定')}>儲存預購單設定</button>
    </div>
  );
}

/** 預購單的 LINE 群：可設多個群，每個選購項目指定要加入哪個群 */
function LineUrlSetting() {
  const { st, act, busy, setMsg } = useAdmin();
  const [groups, setGroups] = useState(st.line.groups.length ? st.line.groups : [{ name: '功德群', url: '' }, { name: '金群', url: '' }]);
  const [map, setMap] = useState<Record<string, number>>(st.line.map);
  const save = () => {
    const keep = groups.map((g, i) => ({ ...g, i })).filter((g) => g.name.trim() || g.url.trim());
    for (const g of keep) {
      if (!g.name.trim()) { setMsg({ kind: 'err', text: '請填寫群組名稱' }); return; }
      if (!/^https:\/\/\S+$/.test(g.url.trim())) { setMsg({ kind: 'err', text: `「${g.name}」的連結應為 https:// 開頭的網址` }); return; }
    }
    const newIdx = new Map(keep.map((g, n) => [g.i, n]));
    const m: Record<string, number> = {};
    for (const [k, v] of Object.entries(map)) if (newIdx.has(v)) m[k] = newIdx.get(v)!;
    act({ action: 'preorder.line', groups: keep.map((g) => ({ name: g.name.trim(), url: g.url.trim() })), map: m }, '已儲存 LINE 群設定');
  };
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ margin: '0 0 4px' }}>LINE 群（買方必須先加入才能送出）</h3>
      <p className="small muted" style={{ margin: '0 0 8px' }}>先填各群的邀請連結，再指定每個項目要加入哪個群。買方選了哪些項目，就要加入對應的群（兩種都買就兩個群都要加入）。項目選「不需要」就不要求。</p>
      {groups.map((g, i) => (
        <div key={i} className="fields" style={{ marginTop: 6 }}>
          <label className="f">群組名稱<input value={g.name} maxLength={20} onChange={(e) => setGroups(groups.map((x, n) => n === i ? { ...x, name: e.target.value } : x))} /></label>
          <label className="f">邀請連結<input value={g.url} placeholder="https://line.me/R/ti/g/…" onChange={(e) => setGroups(groups.map((x, n) => n === i ? { ...x, url: e.target.value } : x))} /></label>
        </div>
      ))}
      <button className="btn small" style={{ marginTop: 6 }} disabled={groups.length >= 8} onClick={() => setGroups([...groups, { name: '', url: '' }])}>＋再加一個群</button>
      <div className="tbl" style={{ marginTop: 10 }}><table>
        <thead><tr><th>選購項目</th><th>要加入的 LINE 群</th></tr></thead>
        <tbody>{st.preMenu.map((m) => {
          const k = `${m.kind}:${m.id}`;
          return <tr key={k}><td>{m.name}</td><td>
            <select value={map[k] ?? -1} style={{ width: 'auto' }} onChange={(e) => { const v = parseInt(e.target.value); const n = { ...map }; if (v < 0) delete n[k]; else n[k] = v; setMap(n); }}>
              <option value={-1}>不需要</option>
              {groups.map((g, i) => <option key={i} value={i}>{g.name || `（第 ${i + 1} 個群）`}</option>)}
            </select></td></tr>;
        })}
        {!st.preMenu.length && <tr><td colSpan={2} className="muted">還沒有已發布的項目</td></tr>}</tbody>
      </table></div>
      {(() => {
        const none = st.preMenu.filter((m) => st.line.map[`${m.kind}:${m.id}`] === undefined);
        return st.line.groups.length > 0 && none.length > 0 && <div className="note warn small" style={{ marginTop: 8 }}>目前<b>不需要</b>加 LINE 群的項目：{none.map((m) => m.name).join('、')}。買這些的人不會被要求入群，後台也不會出現「已入群」可以勾。如果應該要，請在上表選好群再儲存。</div>;
      })()}
      <button className="btn pri" style={{ marginTop: 8 }} disabled={busy} onClick={save}>儲存 LINE 群設定</button>
    </div>
  );
}

/* ---------- 四、依序發劃位連結 ---------- */
const ik = (i: { kind: string; id: number }) => `${i.kind}:${i.id}`;
const unreleased = (p: Pre) => p.items.filter((i) => !p.released.includes(ik(i)));
const readyFor = (p: Pre, k: string) => !!p.paidOkAt && (p.needGroups[k] ?? []).every((g) => p.lineOk.includes(g));
const allGroups = (p: Pre) => [...new Set(Object.values(p.needGroups).flat())];
const inProgress = (p: Pre) => !!p.progress && (p.progress.left > 0 || p.progress.held > 0 || p.progress.pending > 0);
const bySeq = (a: Pre, b: Pre) => (a.seq ?? 1e9) - (b.seq ?? 1e9);
/** 四、訂單核帳：還沒核好（沒設定內容、沒勾已匯款或入群）且還有沒發的 */
const needsCheck = (p: Pre) => p.status !== 'cancelled' && (unreleased(p).length > 0 || !p.items.length)
  && (!p.items.length || !p.paidOkAt || !allGroups(p).every((g) => p.lineOk.includes(g)));
const isReady = (p: Pre) => !p.waitlist && p.status !== 'cancelled' && p.items.length > 0 && unreleased(p).length > 0 && unreleased(p).every((i) => readyFor(p, ik(i)));
const progressText = (p: Pre) => !p.progress ? '' : p.progress.pending > 0 ? '已送出，等你確認' : p.progress.held > 0 ? '選位中' : p.progress.left > 0 ? (p.progress.paid + p.progress.pending > 0 ? '還沒劃完' : '還沒開始劃') : '✅ 完成';
const linkText = (st: State, p: Pre, base: string) => {
  const rel = p.items.filter((i) => p.released.includes(ik(i))).map((i) => `${i.name} × ${i.qty} ${i.kind === 'combo' ? '組' : '張'}`).join('、');
  return [`【${st.event.name}】劃位通知`, '', `${p.name} 您好：`, '輪到您劃位了 🙏', rel ? `劃位內容：${rel}` : '', '',
    '👉 請點以下連結選座位、確認持票人：', `${base}/t/${p.linkCode}`, '',
    '・這是您專屬的連結，請勿轉傳', '・送出後我們確認，會再寄入場 QR code', '・操作上有任何問題，直接回覆我就好'].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
};

/** 發出劃位連結（第三顆鈕）：按兩次才寄。前面還有人沒發時，第二次的按鈕會提醒 */
function ReleaseButton({ p, keys, label }: { p: Pre; keys: string[]; label: string }) {
  const { st, act, busy, sure, confirm2, setMsg } = useAdmin();
  const ok = keys.every((k) => readyFor(p, k));
  const ahead = st.preorders.filter((x) => x.status !== 'cancelled' && x.id !== p.id && (x.seq ?? 0) < (p.seq ?? 0)
    && keys.some((k) => unreleased(x).some((i) => ik(i) === k) && readyFor(x, k)));
  const key = `rel${p.id}${keys.join()}`;
  const why = !p.paidOkAt ? '請先勾「已匯款」' : !ok ? `請先勾「已入 ${keys.flatMap((k) => p.needGroups[k] ?? []).filter((g) => !p.lineOk.includes(g)).join('、')}」` : '';
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn pri" disabled={busy || !ok} title={why} onClick={(e) => {
        e.stopPropagation();
        confirm2(key, async () => {
          const r = await act({ action: 'preorder.release', id: p.id, keys }) as { code: string; email: string; items: string; rest: string; delivery?: Delivery } | null;
          if (r) {
            const d = deliveryText(r.delivery);
            setMsg({ kind: d.bad || !r.email ? 'err' : 'ok', text: `已發出 ${p.name} 的劃位連結（${r.items}）${r.email ? (d.bad ? '' : `，已寄到 ${r.email}`) : '。他沒有 Email'}。建議同時用 LINE 傳給他：在「劃位中」按「複製連結＋說明」。${d.text}${r.rest ? `　${r.rest} 之後再發。` : ''}` });
          }
        });
      }}>{sure === key ? (ahead.length ? `前面還有 ${ahead.length} 位沒發，確定先發 ${p.name}？再按一次` : `再按一次：寄給 ${p.name}`) : label}</button>
      {why && <span className="small muted">{why}</span>}
    </span>
  );
}

const CHK = { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' as const, cursor: 'pointer' };
const CHKI = { width: 18, height: 18, margin: 0, flex: 'none' };
/** 已匯款、已入 LINE 群：勾了只記錄，不寄東西 */
type CheckDone = { id: number; text: string; undo: Record<string, unknown> };
function Checks({ p, onDone }: { p: Pre; onDone?: (d: CheckDone) => void }) {
  const { act, busy } = useAdmin();
  if (p.status === 'cancelled') return null;
  const groups = allGroups(p);
  const tick = async (body: Record<string, unknown>, text: string, undo: Record<string, unknown>) => {
    const r = await act({ action: 'preorder.check', id: p.id, ...body }, text);
    if (r) onDone?.({ id: p.id, text, undo: { action: 'preorder.check', id: p.id, ...undo } });
  };
  return (
    <div className="small" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label style={CHK}><input type="checkbox" style={CHKI} checked={!!p.paidOkAt} disabled={busy}
        onChange={(e) => tick({ paid: e.target.checked }, e.target.checked ? `${p.name}：已匯款` : `${p.name}：取消已匯款`, { paid: !e.target.checked })} /> 已匯款</label>
      {groups.map((g) => (
        <label key={g} style={CHK}><input type="checkbox" style={CHKI} checked={p.lineOk.includes(g)} disabled={busy}
          onChange={(e) => tick({ line: e.target.checked ? [...p.lineOk, g] : p.lineOk.filter((x) => x !== g) }, `${p.name}：${e.target.checked ? '已入' : '取消已入'} ${g}`, { line: p.lineOk })} /> 已入{g}</label>
      ))}
    </div>
  );
}

/** 劃位中的人＋下一位（四、六 都顯示） */
function NextUp() {
  const { st, go, setMsg, openOrder } = useAdmin();
  const base = typeof window !== 'undefined' ? location.origin : '';
  const [day, setDay] = useState<string>(() => { try { return localStorage.getItem('ticc.releaseKey') || 'all'; } catch { return 'all'; } });
  const pick = (v: string) => { setDay(v); try { localStorage.setItem('ticc.releaseKey', v); } catch { /* 忽略 */ } };
  const live = st.preorders.filter((p) => p.status === 'confirmed' && inProgress(p)).sort(bySeq);
  const keysOf = (p: Pre) => unreleased(p).map(ik).filter((k) => day === 'all' || k === day);
  const waiting = st.preorders.filter((p) => !p.waitlist && p.status !== 'cancelled' && keysOf(p).length > 0).sort(bySeq);
  const next = waiting.find((p) => keysOf(p).every((k) => readyFor(p, k)));
  const skipped = next ? waiting.filter((p) => (p.seq ?? 0) < (next.seq ?? 0)) : waiting;
  if (!st.preorders.length) return null;
  const who = (p: Pre) => <>
    <b style={{ fontSize: 17 }}>第 {p.seq} 位　{p.name}</b>
    {p.phone && <a className="btn small" href={`tel:${p.phone}`} style={{ marginLeft: 8 }}>📞 {p.phone}</a>}
    {p.lineName && <span className="small">　LINE：{p.lineName}</span>}
  </>;
  return (
    <div className="card" style={{ borderLeft: '4px solid var(--accent, #2b4c8c)' }}>
      <h2 style={{ marginTop: 0 }}>依序劃位</h2>
      {live.map((p) => (
        <div key={p.id} className="note" style={{ marginBottom: 8 }}>
          <div>⏳ <b>劃位中</b>　{who(p)}</div>
          <div className="small" style={{ margin: '4px 0' }}>{p.items.filter((i) => p.released.includes(ik(i))).map((i) => `${i.name} × ${i.qty}`).join('、')}　
            {p.progress!.left > 0 && <>還有 <b>{p.progress!.left}</b> 組／張沒劃　</>}{p.progress!.held > 0 && <>選位中 {p.progress!.held} 筆　</>}{p.progress!.pending > 0 && <b className="err-text">已送出 {p.progress!.pending} 筆，等你「劃位確認」</b>}</div>
          <div className="row">
            <a className="btn small" href={`/t/${p.linkCode}`} target="_blank" rel="noreferrer">開他的劃位頁（電話中幫他劃）</a>
            <button className="btn small" onClick={() => navigator.clipboard?.writeText(linkText(st, p, base)).then(() => setMsg({ kind: 'ok', text: '已複製連結＋說明，可貼到 LINE' }), () => undefined)}>複製連結＋說明</button>
            {p.progress!.pending > 0 && <button className="btn small pri" onClick={() => { const o = st.orders.find((x) => x.linkCode === p.linkCode && x.status === 'pending'); if (o) openOrder(o); go('orders'); }}>到六確認他的座位 →</button>}
          </div>
        </div>
      ))}
      <div className="row" style={{ margin: '4px 0 8px' }}>
        <span className="small">今天發：</span>
        <select value={day} style={{ width: 'auto' }} onChange={(e) => pick(e.target.value)}>
          <option value="all">全部項目</option>
          {st.preMenu.map((m) => <option key={ik(m)} value={ik(m)}>{m.name}</option>)}
        </select>
      </div>
      {next ? (
        <div className="note ok">
          <div>👉 <b>下一位</b>　{who(next)}</div>
          <div className="small" style={{ margin: '4px 0 6px' }}>{unreleased(next).filter((i) => keysOf(next).includes(ik(i))).map((i) => `${i.name} × ${i.qty}`).join('、')}
            {live.length > 0 && <span className="err-text">　（上面還有人劃位中，關心完再發）</span>}</div>
          <ReleaseButton p={next} keys={keysOf(next)} label="發出劃位連結" />
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>{waiting.length ? '還沒有勾好「已匯款」「已入 LINE 群」的人。' : '這個項目都發完了。'}</p>}
      {skipped.length > 0 && <p className="small muted" style={{ margin: '8px 0 0' }}>排在前面、還沒核好的：{skipped.slice(0, 8).map((p) => `第 ${p.seq} 位 ${p.name}（${!p.items.length ? '未設定內容' : !p.paidOkAt ? '未勾已匯款' : '未勾入群'}）`).join('、')}{skipped.length > 8 ? '…' : ''}　<button className="btn small" onClick={() => go('pre')}>到四核帳</button></p>}
    </div>
  );
}

/** 改 Email；已發連結的可順便補寄 */
function EmailEdit({ p }: { p: Pre }) {
  const { act, busy, setMsg } = useAdmin();
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(p.email);
  if (!edit) return <span onClick={(e) => e.stopPropagation()}><span className="mono">{p.email || <b className="err-text">沒有 Email</b>}</span>
    <button className="btn small" style={{ marginLeft: 8 }} onClick={() => { setV(p.email); setEdit(true); }}>改 Email{p.linkCode ? '／補寄連結' : ''}</button>
    {p.email && p.status !== 'cancelled' && <button className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={async () => {
      if (!confirm(`補寄「已收到您的認購登記」確認信（含匯款帳戶）到 ${p.email}？`)) return;
      const r = await act({ action: 'preorder.resendReceived', id: p.id }) as { email: string; status?: string; error?: string | null } | null;
      if (r) setMsg({ kind: r.status === 'sent' ? 'ok' : 'err', text: r.status === 'sent' ? `已補寄登記確認信到 ${r.email}` : `補寄結果：${N_STATUS[r.status ?? ''] ?? r.status}${r.error ? `（${r.error}）` : ''}` });
    }}>補寄登記確認信</button>}</span>;
  const save = async (resend: boolean) => {
    const r = await act({ action: 'preorder.email', id: p.id, email: v.trim(), resend }) as { resent: boolean; delivery?: Delivery } | null;
    if (r) { const d = deliveryText(r.delivery); setMsg({ kind: d.bad ? 'err' : 'ok', text: `已改為 ${v.trim()}${r.resent ? `，並補寄劃位連結。${d.text}` : ''}` }); setEdit(false); }
  };
  return (
    <span className="row" onClick={(e) => e.stopPropagation()}>
      <input value={v} type="email" style={{ width: 240 }} onChange={(e) => setV(e.target.value)} />
      <button className="btn small" disabled={busy} onClick={() => save(false)}>儲存</button>
      {p.linkCode && <button className="btn small pri" disabled={busy} onClick={() => save(true)}>儲存並補寄劃位連結</button>}
      <button className="btn small" onClick={() => setEdit(false)}>取消</button>
    </span>
  );
}

/** 五：排隊名單與已發出名單 */
function Queue() {
  const { st, go } = useAdmin();
  const waiting = st.preorders.filter((p) => p.status !== 'cancelled' && (unreleased(p).length > 0 || !p.items.length)).sort(bySeq);
  const sent = st.preorders.filter((p) => p.status === 'confirmed').sort(bySeq);
  if (!waiting.length && !sent.length) return null;
  return (
    <div className="card">
      <h2>排隊名單 <span className="small muted">還沒發連結的人，依送單順序</span></h2>
      <div className="tbl"><table>
        <thead><tr><th>順位</th><th>姓名／電話</th><th>要發的項目</th><th>核帳</th><th></th></tr></thead>
        <tbody>
          {waiting.map((p) => {
            const ready = isReady(p);
            return (
              <tr key={p.id} style={ready ? undefined : { opacity: 0.55 }}>
                <td className="mono"><b>{p.seq}</b></td>
                <td>{p.name}{p.lineName && <span className="small muted">（LINE：{p.lineName}）</span>}<br />{p.phone && <a className="small mono" href={`tel:${p.phone}`}>{p.phone}</a>}</td>
                <td className="small">{p.items.length ? unreleased(p).map((i) => `${i.name} × ${i.qty}`).join('、') : '未設定內容'}</td>
                <td className="small">{ready ? <span style={{ color: 'var(--ok)' }}>✓ 已核好</span> : p.waitlist ? <b style={{ color: '#9a6700' }}>候補（到四轉正取）</b> : !p.items.length ? '未設定內容' : !p.paidOkAt ? '未勾已匯款' : '未勾入群'}</td>
                <td>{ready
                  ? <ReleaseButton p={p} keys={unreleased(p).map(ik)} label="發出劃位連結" />
                  : <button className="btn small" onClick={() => go('pre')}>到四核帳</button>}</td>
              </tr>
            );
          })}
          {!waiting.length && <tr><td colSpan={5} className="muted">都發完了</td></tr>}
        </tbody>
      </table></div>
      {sent.length > 0 && <>
        <h3>已發出</h3>
        <div className="tbl"><table>
          <thead><tr><th>順位</th><th>姓名</th><th>已發的項目</th><th>進度</th></tr></thead>
          <tbody>{sent.map((p) => (
            <tr key={p.id}><td className="mono">{p.seq}</td><td>{p.name}</td>
              <td className="small">{p.items.filter((i) => p.released.includes(ik(i))).map((i) => `${i.name} × ${i.qty}`).join('、')}{unreleased(p).length > 0 && <span className="muted">（{unreleased(p).map((i) => i.name).join('、')} 未發）</span>}</td>
              <td className="small">{progressText(p)}</td></tr>
          ))}</tbody>
        </table></div>
      </>}
    </div>
  );
}

/** 設定／修改訂單的內容與份數：表單來的（沒有數量）先設定；買方誤填可以改（已發連結的，劃位上限立刻跟著變） */
function FormItems({ p }: { p: Pre }) {
  const { st, act, busy, setMsg } = useAdmin();
  const editing = p.items.length > 0;
  const [open, setOpen] = useState(!editing);
  const init = () => Object.fromEntries(p.items.map((i) => [`${i.kind}${i.id}`, String(i.qty)]));
  const [qty, setQty] = useState<Record<string, string>>(init);
  // 菜單上沒有、但訂單裡有的舊項目也要能改
  const menu = [...st.preMenu, ...p.items.filter((i) => !st.preMenu.some((m) => m.kind === i.kind && m.id === i.id))
    .map((i) => ({ kind: i.kind as 'combo' | 'zone', id: i.id, name: i.name, price: i.price, desc: '', unit: i.kind === 'combo' ? '份' : '席' }))];
  const items = menu.map((m) => ({ m, n: Math.max(0, parseInt(qty[`${m.kind}${m.id}`] || '0') || 0) })).filter((x) => x.n > 0);
  const total = items.reduce((a, x) => a + x.m.price * x.n, 0);
  if (!open) return <button className="btn" onClick={() => { setQty(init()); setOpen(true); }}>修改內容／份數</button>;
  return (
    <div style={{ width: '100%' }}>
      <div className="small" style={{ marginBottom: 6 }}>
        {editing
          ? <><b>修改內容／份數</b>（買方填錯時用；依實際匯款改）{p.linkCode && <><br />已發劃位連結：存檔後他的劃位上限<b>立刻</b>跟著變；不能改得比他已劃的少。</>}</>
          : <><b>先設定他可以劃的內容與數量</b>（依你們確認的款項；設定後才能發劃位連結）</>}
      </div>
      {!menu.length && <div className="note err">還沒有可選的項目：請先到「二、價格設定」發布組合票或票種。</div>}
      <div className="fields">
        {menu.map((m) => (
          <label key={`${m.kind}${m.id}`} className="f">{m.name}<span className="small muted">　{money(m.price)}／{m.unit}</span>
            <input inputMode="numeric" value={qty[`${m.kind}${m.id}`] ?? ''} placeholder="0"
              onChange={(e) => setQty({ ...qty, [`${m.kind}${m.id}`]: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></label>
        ))}
      </div>
      {p.source !== 'form' && items.length > 0 && <div className="small" style={{ marginTop: 6 }}>改後應付 {money(total)}・他匯 {money(p.paidAmount)}
        {total === p.paidAmount ? <b style={{ color: 'var(--ok)' }}>　✓ 相符</b> : <b style={{ color: 'var(--red)' }}>　⚠ {total > p.paidAmount ? `少 ${money(total - p.paidAmount)}` : `多 ${money(p.paidAmount - total)}`}</b>}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn pri" disabled={busy || !items.length} onClick={async () => {
          if (!items.length) { setMsg({ kind: 'err', text: '請先填數量' }); return; }
          const text = items.map((x) => `${x.m.name} × ${x.n}`).join('、');
          const r = await act({ action: 'preorder.items', id: p.id, items: items.map((x) => ({ kind: x.m.kind, id: x.m.id, qty: x.n })) });
          if (!r) return;
          const warn = typeof r === 'object' && 'warn' in r ? String((r as { warn: string }).warn) : '';
          setMsg({ kind: warn ? 'warn' : 'ok', text: `已${editing ? '改為' : '設定'} ${p.name}：${text}${warn ? `。注意：${warn}` : ''}` });
          if (editing) setOpen(false);
        }}>{editing ? '儲存修改' : '儲存內容'}</button>
        {editing && <button className="btn" disabled={busy} onClick={() => setOpen(false)}>不改了</button>}
      </div>
    </div>
  );
}

const PRE_STATUS: Record<string, string> = { submitted: '待發連結', confirmed: '已發連結', cancelled: '已取消' };

/** 網銀對帳：上傳明細 → 依後五碼加總比對 → 對上的一次勾「已匯款」，其餘列出來人工看 */
type Rec = ReturnType<typeof reconcile>;
function BankRecon({ rec }: { rec: Rec }) {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const [paste, setPaste] = useState('');
  const [show, setShow] = useState<string>('');
  const [undo, setUndo] = useState<number[] | null>(null);
  const byId = new Map(st.preorders.map((p) => [p.id, p]));
  const dep = new Map(st.bank.map((d) => [d.id, d]));
  const live = st.preorders.filter((p) => p.status !== 'cancelled');
  const stOf = (p: Pre) => rec.state.get(p.id)?.state;
  const okTodo = live.filter((p) => stOf(p) === 'ok' && !p.paidOkAt);
  const okDone = live.filter((p) => stOf(p) === 'ok' && p.paidOkAt);
  const diffGroups = rec.groups.filter((g) => g.deposits.length && g.got !== g.due);
  const waiting = live.filter((p) => stOf(p) === 'waiting' && !p.paidOkAt);
  const nolast5 = live.filter((p) => stOf(p) === 'nolast5' && !p.paidOkAt);
  const unknown = rec.unknown.map((id) => dep.get(id)!).filter(Boolean);
  const ignored = st.bank.filter((d) => d.ignored);
  const total = st.bank.filter((d) => !d.ignored).reduce((a, d) => a + d.amount, 0);
  const lastAt = st.bank.length ? st.bank[0].at : null;

  async function sendGrid(grid: unknown[][]) {
    const r = await act({ action: 'bank.import', grid }) as { rows: number; added: number; dup: number; noCode: number } | null;
    if (r) { setMsg({ kind: r.noCode ? 'warn' : 'ok', text: `讀到 ${r.rows} 筆入帳：新增 ${r.added} 筆${r.dup ? `，${r.dup} 筆之前已匯入（略過）` : ''}${r.noCode ? `；${r.noCode} 筆看不到對方帳號` : ''}` }); setPaste(''); }
  }
  async function onFile(f: File) {
    try {
      const X = await import('xlsx');
      const wb = X.read(new Uint8Array(await f.arrayBuffer()), { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const grid = X.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, dateNF: 'yyyy/mm/dd', defval: '' });
      await sendGrid(grid.slice(0, 5000).map((r) => r.slice(0, 40).map((c) => String(c ?? '').slice(0, 200))));
    } catch { setMsg({ kind: 'err', text: '讀不到這個檔案。請用網銀下載的 Excel（.xls／.xlsx），或改用下方「貼上」。' }); }
  }
  const pre = (p: Pre) => <div key={p.id} className="small"><b className="mono">{p.seq ?? '—'}</b> {p.name}・{p.items.map((i) => `${i.name}×${i.qty}`).join('、')}・應付 {money(p.amount)}・後五碼 <span className="mono">{p.last5 || '（未填）'}</span>{p.paidOkAt && <span className="pill" style={{ marginLeft: 4 }}>已勾</span>}</div>;
  const dp = (d: Bank) => <div key={d.id} className="small mono">{tw(d.at)}　{money(d.amount)}　{d.last5 || '—'}</div>;
  const sec = (k: string, title: React.ReactNode, n: number, body: React.ReactNode) => n > 0 && (
    <div style={{ marginTop: 8 }}>
      <button className={`chip${show === k ? ' on' : ''}`} onClick={() => setShow(show === k ? '' : k)}>{title}（{n}）{show === k ? '▲' : '▼'}</button>
      {show === k && <div style={{ marginTop: 6, paddingLeft: 4 }}>{body}</div>}
    </div>
  );
  return (
    <div className="card">
      <h3 style={{ margin: 0 }}>網銀對帳 <span className="small muted">上傳網銀「交易明細」，依匯款帳號後五碼自動比對（同一個後五碼的多筆入帳會加總）</span></h3>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="btn pri" style={{ cursor: 'pointer' }}>上傳網銀明細（Excel）
          <input type="file" accept=".xls,.xlsx,.csv" style={{ display: 'none' }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} /></label>
        <span className="small muted">{st.bank.length ? `已匯入 ${st.bank.length} 筆入帳，共 ${money(total)}・最新 ${tw(lastAt)}` : '還沒有匯入任何入帳。可以重複上傳，同一筆只算一次。'}</span>
      </div>
      <details style={{ marginTop: 6 }}><summary className="small">或從 Excel 複製幾列貼上</summary>
        <textarea value={paste} rows={4} style={{ width: '100%', marginTop: 6 }} placeholder="在 Excel 選取入帳那幾列（含日期、時間、金額、備註帳號）→ 複製 → 貼在這裡" onChange={(e) => setPaste(e.target.value)} />
        <button className="btn small" disabled={busy || !paste.trim()} onClick={() => sendGrid(pasteToGrid(paste).slice(0, 5000))}>匯入貼上的內容</button>
      </details>

      {st.bank.length > 0 && <>
        {undo && <div className="note ok" style={{ marginTop: 8 }}>已勾 {undo.length} 筆「已匯款」 ✓
          <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={async () => { if (await act({ action: 'preorder.checkMany', ids: undo, paid: false }, `已復原 ${undo.length} 筆`)) setUndo(null); }}>復原</button></div>}
        <div className="note ok" style={{ marginTop: 8 }}>
          ✅ <b>對上，還沒勾 {okTodo.length} 筆</b>（已勾 {okDone.length} 筆）
          {okTodo.length > 0 && <button className="btn small pri" style={{ marginLeft: 8 }} disabled={busy} onClick={() => confirm2('bankAll', async () => {
            const ids = okTodo.map((p) => p.id);
            if (await act({ action: 'preorder.checkMany', ids, paid: true })) { setUndo(ids); setMsg({ kind: 'ok', text: `已勾 ${ids.length} 筆「已匯款」（不會寄信）` }); }
          })}>{sure === 'bankAll' ? `再按一次：勾這 ${okTodo.length} 筆已匯款` : '全部勾已匯款'}</button>}
        </div>
        {sec('ok', '✅ 對上，還沒勾', okTodo.length, okTodo.map(pre))}
        {sec('diff', <span style={{ color: 'var(--red)' }}>⚠ 有入帳但金額不符</span>, diffGroups.length, diffGroups.map((g, n) => (
          <div key={n} style={{ borderTop: n ? '1px solid var(--line)' : undefined, padding: '6px 0' }}>
            <div className="small"><b>後五碼 {g.codes.join('、')}</b>：實收 {money(g.got)}，應付 {money(g.due)}・<b style={{ color: 'var(--red)' }}>{g.got > g.due ? `多 ${money(g.got - g.due)}` : `少 ${money(g.due - g.got)}`}</b>
              {g.orders.length > 1 && <span className="muted">（{g.orders.length} 筆訂單用同一個後五碼，一起算）</span>}</div>
            {g.orders.map((id) => byId.get(id)).filter((p): p is Pre => !!p).map(pre)}
            <div style={{ paddingLeft: 12 }}>{g.deposits.map((id) => dep.get(id)).filter((d): d is Bank => !!d).map(dp)}</div>
          </div>
        )))}
        {sec('unknown', '❓ 有入帳，找不到訂單', unknown.length, <>
          <div className="small muted" style={{ marginBottom: 4 }}>多半是買方後五碼填錯或沒填。找到是誰後，在他的訂單按「補填／修改後五碼」；不是認購款的按「略過」。</div>
          {unknown.map((d) => {
            const cand = nolast5.filter((p) => p.amount === d.amount).slice(0, 3);
            return <div key={d.id} className="row" style={{ padding: '3px 0' }}>{dp(d)}
              {cand.map((p) => <button key={p.id} className="btn small" disabled={busy} title="這位沒填後五碼、應付金額相同" onClick={() => confirm2(`bk${d.id}-${p.id}`, () => act({ action: 'preorder.remits', id: p.id, remits: [{ last5: d.last5, amount: d.amount }] }, `已把 ${p.name} 的後五碼設為 ${d.last5}`))}>
                {sure === `bk${d.id}-${p.id}` ? `再按一次：是 ${p.name}` : `是 ${p.name}（${p.seq ?? p.no}）？`}</button>)}
              <button className="btn small" disabled={busy} onClick={() => act({ action: 'bank.ignore', id: d.id, on: true }, '已略過這筆入帳')}>略過（不是認購款）</button></div>;
          })}</>)}
        {sec('waiting', '⏳ 有訂單，還沒看到入帳', waiting.length, waiting.map(pre))}
        {sec('nolast5', '🔢 沒填後五碼', nolast5.length, <><div className="small muted" style={{ marginBottom: 4 }}>確認信裡有補填連結；也可以問到後在訂單裡補填。</div>{nolast5.map(pre)}</>)}
        {sec('ignored', '已略過的入帳', ignored.length, ignored.map((d) => <div key={d.id} className="row">{dp(d)}
          <button className="btn small" disabled={busy} onClick={() => act({ action: 'bank.ignore', id: d.id, on: false }, '已復原這筆入帳')}>復原</button></div>))}
        <div style={{ marginTop: 10 }}>
          <button className="btn small danger" disabled={busy} onClick={() => confirm2('bankClear', () => act({ action: 'bank.clear' }, '已清除所有匯入的入帳（訂單不受影響）'))}>
            {sure === 'bankClear' ? '再按一次：清除所有入帳' : '清除所有入帳（傳錯檔案時用）'}</button></div>
      </>}
    </div>
  );
}

/** 後台補填／修改後五碼（買方填錯、沒填，或分成多筆） */
function RemitsEdit({ p }: { p: Pre }) {
  const { act, busy, setMsg } = useAdmin();
  const cur = parseRemits(p.last5, p.paidAmount);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ last5: string; amount: string }[]>([]);
  if (!open) return <button className="btn" onClick={() => { setRows(cur.length ? cur.map((r) => ({ last5: r.last5, amount: String(r.amount) })) : [{ last5: '', amount: String(p.amount) }]); setOpen(true); }}>{cur.length ? '修改後五碼' : '補填後五碼'}</button>;
  return (
    <div style={{ width: '100%' }}>
      <div className="small"><b>{cur.length ? '修改' : '補填'}匯款帳號後五碼</b>（分多筆匯款就各填一筆）</div>
      {rows.map((r, n) => (
        <div key={n} className="row" style={{ marginTop: 4 }}>
          <input value={r.last5} maxLength={5} inputMode="numeric" placeholder="後五碼" style={{ width: 90 }} onChange={(e) => setRows(rows.map((x, m) => (m === n ? { ...x, last5: e.target.value.replace(/\D/g, '') } : x)))} />
          <input value={r.amount} inputMode="numeric" placeholder="這筆金額" style={{ width: 120 }} onChange={(e) => setRows(rows.map((x, m) => (m === n ? { ...x, amount: e.target.value.replace(/\D/g, '') } : x)))} />
          {rows.length > 1 && <button className="btn small" onClick={() => setRows(rows.filter((_, m) => m !== n))}>✕</button>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        {rows.length < 5 && <button className="btn small" onClick={() => setRows([...rows, { last5: '', amount: '' }])}>＋再加一筆</button>}
        <button className="btn small pri" disabled={busy} onClick={async () => {
          if (rows.some((r) => !/^\d{5}$/.test(r.last5) || !(Number(r.amount) > 0))) { setMsg({ kind: 'err', text: '每一筆都要填 5 位數字的後五碼和金額' }); return; }
          if (await act({ action: 'preorder.remits', id: p.id, remits: rows.map((r) => ({ last5: r.last5, amount: Number(r.amount) })) }, `已更新 ${p.name} 的後五碼：${rows.map((r) => r.last5).join('、')}`)) setOpen(false);
        }}>儲存</button>
        <button className="btn small" onClick={() => setOpen(false)}>不改了</button>
      </div>
    </div>
  );
}

/** 已匯款名單（Excel）：依席別分頁；入帳金額取網銀對帳（同後五碼加總），沒上傳網銀明細就空白 */
async function downloadPaid(st: State, rec: ReturnType<typeof reconcile>) {
  const X = await import('xlsx');
  const paid = st.preorders.filter((p) => p.status !== 'cancelled' && p.paidOkAt).sort(bySeq);
  const plans = [...new Map(paid.flatMap((p) => p.items.map((i) => [ik(i), i.name] as const))).entries()];
  const wb = X.utils.book_new();
  const shared = (p: Pre) => (rec.state.get(p.id)?.group?.orders.length ?? 0) > 1;
  for (const [k, name] of plans) {
    const rows = paid.filter((p) => p.items.some((i) => ik(i) === k));
    const data: (string | number)[][] = [['訂單號', '姓名', '認購量', '應匯金額', '入帳金額', '差額', '匯款帳號後五碼', '備註']];
    let q = 0, due = 0, got = 0;
    for (const p of rows) {
      const qty = p.items.filter((i) => ik(i) === k).reduce((a, i) => a + i.qty, 0);
      const g = rec.state.get(p.id)?.group;
      const inn = g && g.deposits.length && !shared(p) ? g.got : '';
      const other = p.items.filter((i) => ik(i) !== k);
      const note = [other.length ? `同一筆另含 ${other.map((i) => `${i.name}×${i.qty}`).join('、')}（應匯／入帳為整筆）` : '',
        g && shared(p) ? `後五碼與其他訂單相同，合計入帳 ${g.got}` : '', !st.bank.length ? '尚未上傳網銀明細' : g && !g.deposits.length ? '網銀尚未看到入帳' : ''].filter(Boolean).join('；');
      data.push([p.no, p.name, qty, p.amount, inn, inn === '' ? '' : (inn as number) - p.amount, p.last5, note]);
      q += qty; due += p.amount; if (inn !== '') got += inn as number;
    }
    data.push(['合計', `${rows.length} 筆`, q, due, got || '', '', '', '']);
    const ws = X.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 8 }, { wch: 12 }, { wch: 7 }, { wch: 11 }, { wch: 11 }, { wch: 9 }, { wch: 22 }, { wch: 40 }];
    X.utils.book_append_sheet(wb, ws, name.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || k);
  }
  if (!plans.length) X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['目前沒有已勾「已匯款」的訂單']]), '已匯款');
  const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
  X.writeFile(wb, `已匯款名單-${d}.xlsx`);
}

/** 風雲榜：依認購組數排名，畫成 LINE 用的直式圖片（只讀，不改資料） */
function Leaderboard({ st }: { st: State }) {
  const combos = st.combos.filter((c) => !c.isSingle);
  const [ids, setIds] = useState<number[]>(() => combos.filter((c) => c.name.includes('感恩')).map((c) => c.id));
  const [paidOnly, setPaidOnly] = useState(true);
  const [title, setTitle] = useState('感恩席風雲榜');
  const [sub, setSub] = useState('感恩有您，依認購組數排列');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [tip, setTip] = useState('');
  const rows = leaderboard(st.preorders, ids, paidOnly);
  const total = rows.reduce((a, r) => a + r.sets, 0);
  const draw = () => {
    const W = 1080, top = 360, rowH = 92, foot = 220;
    const H = top + Math.max(rows.length, 1) * rowH + foot;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d')!;
    const font = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif';
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#5b0f14'); bg.addColorStop(1, '#2a0609');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#d8b25a'; g.lineWidth = 6; g.strokeRect(28, 28, W - 56, H - 56);
    g.lineWidth = 2; g.strokeRect(44, 44, W - 88, H - 88);
    g.textAlign = 'center'; g.fillStyle = '#f3dfa2';
    g.font = `500 34px ${font}`; g.fillText(st.event.name, W / 2, 130);
    g.font = `700 76px ${font}`; g.fillText(title, W / 2, 225);
    g.font = `400 32px ${font}`; g.fillStyle = '#e9cf8c'; g.fillText(sub, W / 2, 290);
    g.fillStyle = 'rgba(216,178,90,.5)'; g.fillRect(140, 320, W - 280, 2);
    const medal = ['#f5d36b', '#d9dde3', '#d89a5b'];
    rows.forEach((r, i) => {
      const y = top + i * rowH + 62;
      if (i % 2 === 0) { g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(90, y - 58, W - 180, rowH - 8); }
      g.textAlign = 'center'; g.fillStyle = r.rank <= 3 ? medal[r.rank - 1] : '#e9cf8c';
      g.font = `700 ${r.rank <= 3 ? 46 : 38}px ${font}`; g.fillText(String(r.rank), 170, y);
      g.textAlign = 'left'; g.fillStyle = '#fff6e0'; g.font = `500 44px ${font}`;
      let nm = r.name; while (g.measureText(nm).width > 560 && nm.length > 1) nm = nm.slice(0, -1);
      g.fillText(nm === r.name ? nm : `${nm}…`, 250, y);
      g.textAlign = 'right'; g.fillStyle = '#f3dfa2'; g.font = `700 44px ${font}`; g.fillText(`${r.sets} 組`, W - 130, y);
    });
    if (!rows.length) { g.textAlign = 'center'; g.fillStyle = '#e9cf8c'; g.font = `400 36px ${font}`; g.fillText('目前沒有資料', W / 2, top + 60); }
    const fy = top + Math.max(rows.length, 1) * rowH + 70;
    g.fillStyle = 'rgba(216,178,90,.5)'; g.fillRect(140, fy - 50, W - 280, 2);
    g.textAlign = 'center'; g.fillStyle = '#f3dfa2'; g.font = `500 36px ${font}`;
    g.fillText(`共 ${rows.length} 位・${total} 組`, W / 2, fy + 10);
    g.font = `400 28px ${font}`; g.fillStyle = '#c9ad6b';
    g.fillText(`統計至 ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}`, W / 2, fy + 70);
    setUrl(cv.toDataURL('image/png')); setTip('');
    cv.toBlob((b) => setFile(b ? new File([b], `${title || '風雲榜'}.png`, { type: 'image/png' }) : null), 'image/png'); // 先備好檔案，分享時不用再等
  };
  const download = () => {
    const href = file ? URL.createObjectURL(file) : url;
    const a = document.createElement('a'); a.href = href; a.download = `${title || '風雲榜'}.png`; document.body.appendChild(a); a.click(); a.remove();
    if (file) setTimeout(() => URL.revokeObjectURL(href), 5000);
  };
  const share = () => {
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (!file || !nav.share || !nav.canShare?.({ files: [file] })) {
      download(); setTip('這個瀏覽器不能直接分享，已改為下載。也可以長按上面的圖片儲存，再從 LINE 傳。'); return;
    }
    // 必須在按下的當下直接叫出分享選單（中間不能等待），iPhone 才不會擋掉
    nav.share({ files: [file] }).then(() => setTip('')).catch((e: Error) => {
      if (e?.name === 'AbortError') setTip('已取消分享，沒有傳給任何人。');
      else { setTip('分享選單打不開（在 LINE 裡開後台時常見）。請改用 Safari 或 Chrome 開後台，或長按上面的圖片儲存後再從 LINE 傳。'); }
    });
  };
  return (
    <div className="note" style={{ marginTop: 8 }}>
      <b>風雲榜（LINE 圖片）</b> <span className="small muted">只讀取資料，不會改任何訂單。顯示全名，公告前請老大確認。</span>
      <div className="row small" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        <span>計入方案：</span>
        {combos.map((c) => (
          <label key={c.id}><input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => { setUrl(''); setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)); }} />{c.name || '未命名'}</label>
        ))}
      </div>
      <label className="switch small"><input type="checkbox" checked={paidOnly} onChange={(e) => { setUrl(''); setPaidOnly(e.target.checked); }} />只算已勾「已匯款」</label>
      <div className="fields" style={{ marginTop: 6 }}>
        <label className="f">標題<input value={title} maxLength={20} onChange={(e) => { setUrl(''); setFile(null); setTitle(e.target.value); }} /></label>
        <label className="f">副標<input value={sub} maxLength={30} onChange={(e) => { setUrl(''); setSub(e.target.value); }} /></label>
      </div>
      <div className="small" style={{ marginTop: 6 }}>共 {rows.length} 位、{total} 組{rows.length ? `：${rows.slice(0, 5).map((r) => `${r.name} ${r.sets}組`).join('、')}${rows.length > 5 ? '…' : ''}` : ''}</div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn pri small" disabled={!ids.length} onClick={draw}>產生圖片</button>
        {url && <button className="btn small" disabled={!file} onClick={share}>分享到 LINE 等</button>}
        {url && <button className="btn small" onClick={download}>下載圖片</button>}
      </div>
      {url && <div className="small muted" style={{ marginTop: 4 }}>按「分享」會跳出手機的分享選單，選 LINE 再選聊天室才會傳出；系統不會自動傳給任何人。也可以長按圖片儲存。</div>}
      {tip && <div className="note warn small" style={{ marginTop: 6 }}>{tip}</div>}
      {url && <img src={url} alt={title} style={{ width: '100%', maxWidth: 420, marginTop: 8, borderRadius: 6 }} />}
    </div>
  );
}

function Preorders() {
  const { st, act, busy, setMsg, sure, confirm2, go } = useAdmin();
  const [lb, setLb] = useState(false);
  const [filter, setFilter0] = useState('todo');
  // 剛勾好的先留在原位（不馬上消失、下一筆不會補上來），換分頁或按「收起」才收
  const [stick, setStick] = useState<number[]>([]);
  const [last, setLast] = useState<CheckDone | null>(null);
  const setFilter = (k: string) => { setFilter0(k); setStick([]); setLast(null); };
  const onDone = (d: CheckDone) => { setLast(d); setStick((x) => (x.includes(d.id) ? x : [...x, d.id])); };
  const [openId, setOpenId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const base = typeof window !== 'undefined' ? location.origin : '';
  // 網址後面加 ?v=…：活動名稱或開頭文字改了，數字就跟著變，LINE 會重新抓新的預覽（沒改就不變）
  const ver = (() => { let h = 0; for (const c of `${st.event.name}|${st.preorderSettings.intro.split(/\n\s*\n/)[0]}`) h = (h * 31 + c.charCodeAt(0)) % 9973; return h; })();
  const buyUrl = `${base}/buy?v=${ver}`;
  const mismatch = (p: Pre) => p.source !== 'form' && p.status !== 'cancelled' && p.items.length > 0 && p.paidAmount !== p.amount;
  // 依方案（席別）篩選：'combo:3'、'zone:5'；不含已取消
  const planKeys = [...new Map(st.preorders.filter((p) => p.status !== 'cancelled').flatMap((p) => p.items.map((i) => [ik(i), i.name] as const))).entries()];
  const planStat = (k: string) => {
    const rows = st.preorders.filter((p) => p.status !== 'cancelled' && p.items.some((i) => ik(i) === k));
    const qty = (w: boolean) => rows.filter((p) => p.waitlist === w).reduce((a, p) => a + p.items.filter((i) => ik(i) === k).reduce((b, i) => b + i.qty, 0), 0);
    return { people: rows.filter((p) => !p.waitlist).length, qty: qty(false), waitPeople: rows.filter((p) => p.waitlist).length, waitQty: qty(true) };
  };
  const shortName = (n: string) => n.split(/[(（]/)[0].trim() || n;
  const match = (p: Pre, k: string) => k.includes(':') ? p.status !== 'cancelled' && p.items.some((i) => ik(i) === k) : k === 'all' || (k === 'todo' ? needsCheck(p) : k === 'ready' ? isReady(p) : k === 'confirmed' ? p.status === 'confirmed' : p.status === k);
  const list = st.preorders.filter((p) => (match(p, filter) || (filter === 'todo' && stick.includes(p.id) && p.status !== 'cancelled'))
    && (!q.trim() || [p.no, p.name, p.phone, p.email, p.last5, p.lineName].some((x) => x.includes(q.trim())))).sort(bySeq);
  const cnt = (k: string) => st.preorders.filter((p) => match(p, k)).length;
  const stuckReady = stick.some((id) => { const x = st.preorders.find((y) => y.id === id); return !!x && !needsCheck(x); });
  const open = (p: Pre) => { setOpenId(openId === p.id ? null : p.id); if (p.isNew) act({ action: 'preorder.seen', id: p.id }); };
  const rec = reconcile(st.preorders.map((p) => ({ id: p.id, no: p.no, name: p.name, amount: p.amount, last5: p.last5, paidAmount: p.paidAmount, paidOk: !!p.paidOkAt, status: p.status, waitlist: p.waitlist })), st.bank);
  const recTag = (p: Pre) => {
    if (!st.bank.length || p.status === 'cancelled' || p.source === 'form') return null;
    const s0 = rec.state.get(p.id)?.state;
    return s0 === 'ok' ? <div className="small" style={{ color: 'var(--ok)', fontWeight: 700 }}>🏦 網銀已入帳</div>
      : s0 === 'diff' ? <div className="small" style={{ color: 'var(--red)', fontWeight: 700 }}>🏦 入帳金額不符</div>
      : s0 === 'nolast5' ? <div className="small muted">🔢 沒填後五碼</div>
      : <div className="small muted">⏳ 網銀還沒看到</div>;
  };
  return (
    <div className="pstack">
      <div className="card" style={{ paddingBottom: 8 }}>
        <h2 style={{ margin: 0 }}>四、訂單核帳 <span className="small muted">依送單順序。核對入帳、確認入群後打勾（只記錄，不會寄東西）</span></h2>
        <button className="btn small" style={{ float: 'right' }} onClick={() => downloadPaid(st, rec)}>下載已匯款名單（Excel）</button>
        <button className="btn small" style={{ float: 'right', marginRight: 6 }} onClick={() => setLb((x) => !x)}>{lb ? '收起風雲榜' : '風雲榜（LINE 圖片）'}</button>
        <a className="btn small" style={{ float: 'right', marginRight: 6 }} href="/buy" target="_blank" rel="noopener noreferrer">代填認購單</a>
        {lb && <div style={{ clear: 'both' }}><Leaderboard st={st} /></div>}
        <div style={{ marginTop: 6 }}>待核帳 <b>{cnt('todo')}</b> 筆・金額不符 <b className={st.preorders.some(mismatch) ? 'err-text' : ''}>{st.preorders.filter(mismatch).length}</b> 筆・已核好待發 <b>{cnt('ready')}</b> 筆　
          {cnt('ready') > 0 && <button className="btn small pri" onClick={() => go('links')}>到五依序發連結 →</button>}</div>
      </div>
      <BankRecon rec={rec} />
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            {[['todo', '待核帳'], ['ready', '已核好'], ['confirmed', '已發連結'], ['all', '全部'], ['cancelled', '已取消']].map(([k, n]) => (
              <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{n}（{cnt(k)}）</button>
            ))}
            {planKeys.length > 0 && <span className="small muted" style={{ margin: '0 2px 0 8px' }}>席別：</span>}
            {planKeys.map(([k, n]) => { const x = planStat(k); return (
              <button key={k} title={n} className={`chip${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>
                {shortName(n)}（{x.people} 人・{x.qty} 份{x.waitPeople ? `，另候補 ${x.waitPeople} 人` : ''}）</button>); })}
          </div>
          <input value={q} placeholder="搜尋姓名、手機、LINE、末五碼" style={{ width: 240 }} onChange={(e) => setQ(e.target.value)} />
        </div>

        {(last || (filter === 'todo' && stuckReady)) && (
          <div className="note ok" style={{ position: 'sticky', top: 0, zIndex: 5, marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {last && <><span>剛才：<b>{last.text}</b> ✓</span>
              <button className="btn small" disabled={busy} onClick={async () => { const u = last; const r = await act(u.undo, `已復原：${u.text}`); if (r) setLast(null); }}>復原</button></>}
            {filter === 'todo' && stuckReady &&
              <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => { setStick([]); setLast(null); }}>收起已核好的（綠底）</button>}
          </div>
        )}
        <div className="tbl" style={{ marginTop: 8 }}><table>
          <thead><tr><th>順位</th><th>姓名／電話</th><th>內容</th><th>匯款／末五碼</th><th>核對</th><th>狀態</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <Fragment key={p.id}>
                <tr onClick={() => open(p)} style={{ cursor: 'pointer', fontWeight: p.isNew ? 700 : undefined, ...(filter === 'todo' && !needsCheck(p) ? { background: '#e8f6ec' } : {}) }}>
                  <td className="mono"><b>{p.seq ?? '—'}</b>{p.isNew && <span className="badge">新</span>}<div className="small muted">{p.no}・{tw(p.createdAt)}</div></td>
                  <td>{p.waitlist && <span className="pill" style={{ background: '#fff3cd', color: '#7a5200', marginRight: 4 }}>候補</span>}{p.name}{p.lineName && <span className="small muted">（LINE：{p.lineName}）</span>}{/買方劃位時改 Email/.test(p.note) && <span className="pill" style={{ background: '#e7f0ff', color: '#1f4e78', marginLeft: 4 }} title={p.note}>買方已改信箱</span>}<br /><span className="mono small muted">{p.phone}</span></td>
                  <td className="small">{p.source === 'form' && <span className="pill" style={{ marginRight: 4 }}>表單</span>}
                    {p.items.length ? p.items.map((i) => <div key={ik(i)}>{p.released.includes(ik(i)) ? '✅ ' : '・'}{i.name} × {i.qty}</div>) : <span className="err-text">請點開設定內容</span>}</td>
                  {p.source === 'form'
                    ? <td className="small" style={{ maxWidth: 220 }}>{p.last5 || '—'}</td>
                    : <td className="mono">{money(p.paidAmount)}{p.paidAmount !== p.amount && <div className="small" style={{ color: 'var(--red)', fontWeight: 700 }}>⚠ 金額與數量不相當<br />應付 {money(p.amount)}，{p.paidAmount < p.amount ? `少 ${money(p.amount - p.paidAmount)}` : `多 ${money(p.paidAmount - p.amount)}`}</div>}<div className="small muted">{p.last5 || '（未填後五碼）'}</div>{recTag(p)}</td>}
                  <td><Checks p={p} onDone={onDone} />{filter === 'todo' && !needsCheck(p) && <div className="small" style={{ color: 'var(--ok)', fontWeight: 700, marginTop: 2 }}>✓ 已核好</div>}</td>
                  <td><span className={`pill ${p.status === 'confirmed' ? 'p-paid' : p.status === 'submitted' ? 'p-pending' : 'p-cancelled'}`}>{unreleased(p).length && p.status === 'confirmed' ? '部分已發' : PRE_STATUS[p.status]}</span>
                    {p.status === 'confirmed' && inProgress(p) && <div className="small err-text">劃位中</div>}</td>
                </tr>
                {openId === p.id && (
                  <tr><td colSpan={6}>
                    <div className="bank">
                      <span className="muted">Email</span><span><EmailEdit p={p} /></span>
                      {p.source === 'form' && p.answers.map((x, i) => <Fragment key={i}><span className="muted small">{x.q.length > 24 ? `${x.q.slice(0, 24)}…` : x.q}</span><span style={{ whiteSpace: 'pre-wrap' }}>{x.a}</span></Fragment>)}
                      {p.items.length > 0 && <><span className="muted">內容</span><span>{p.items.map((i) => `${i.name} × ${i.qty}（${money(i.price * i.qty)}）`).join('、')}・合計 {money(p.amount)}</span></>}
                      {p.source !== 'form' && <><span className="muted">發票</span><span>{p.invType === 'company' ? `三聯：${p.invTitle}（統編 ${p.invCode}）` : '二聯（個人）'}</span></>}
                      {p.paidOkAt && <><span className="muted">核帳</span><span>{tw(p.paidOkAt)}・{p.paidOkBy}</span></>}
                      {p.linkCode && <><span className="muted">劃位連結</span><span className="mono">{base}/t/{p.linkCode}</span></>}
                      {p.note && <><span className="muted">備註</span><span>{p.note}</span></>}
                    </div>
                    {p.status !== 'cancelled' && p.source !== 'form' && <div style={{ marginTop: 10 }}><RemitsEdit key={p.last5} p={p} /></div>}
                    {p.status !== 'cancelled' && <div style={{ marginTop: 10 }}><FormItems key={p.items.map((i) => `${ik(i)}x${i.qty}`).join()} p={p} /></div>}
                    {p.status !== 'cancelled' && p.items.length > 0 && !st.notify.email.ready && <div className="note err" style={{ marginTop: 10 }}>尚未設定 Gmail：發出後劃位連結<b>不會寄出</b>，請用「複製連結＋說明」傳給對方，或先到「八、通知設定」設定。</div>}
                    <div className="row" style={{ marginTop: 10 }}>
                      {p.waitlist && p.status !== 'cancelled' && <button className="btn pri" disabled={busy} onClick={() => confirm2(`pm${p.id}`, () => act({ action: 'preorder.promote', id: p.id }, `${p.name} 已轉為正取，會依登記順序排進劃位`))}>{sure === `pm${p.id}` ? '再按一次：轉為正取' : '候補轉正取'}</button>}
                      {isReady(p) && <button className="btn" onClick={() => go('links')}>已核好，到五依序發連結 →</button>}
                      {p.linkCode && <button className="btn" onClick={() => navigator.clipboard?.writeText(linkText(st, p, base)).then(() => setMsg({ kind: 'ok', text: '已複製連結＋說明，可貼到 LINE' }), () => undefined)}>複製連結＋說明</button>}
                      {p.linkCode && <a className="btn" href={`/t/${p.linkCode}`} target="_blank" rel="noreferrer">開他的劃位頁</a>}
                      {p.status === 'cancelled' && <>
                        <button className="btn pri" disabled={busy} onClick={() => confirm2(`rs${p.id}`, async () => { const r = await act({ action: 'preorder.restore', id: p.id, notify: true }) as { warn: string } | null; if (r) setMsg({ kind: r.warn ? 'warn' : 'ok', text: `已恢復 ${p.no}，並寄信告知「取消是誤發」${r.warn ? `。注意：${r.warn}` : ''}` }); })}>
                          {sure === `rs${p.id}` ? '再按一次：恢復並寄信道歉' : '恢復登記（寄信告知取消是誤發）'}</button>
                        <button className="btn" disabled={busy} onClick={() => confirm2(`rn${p.id}`, async () => { const r = await act({ action: 'preorder.restore', id: p.id, notify: false }) as { warn: string } | null; if (r) setMsg({ kind: r.warn ? 'warn' : 'ok', text: `已恢復 ${p.no}（沒寄信）${r.warn ? `。注意：${r.warn}` : ''}` }); })}>
                          {sure === `rn${p.id}` ? '再按一次：恢復，不寄信' : '恢復登記（不寄信）'}</button>
                      </>}
                      {p.status === 'submitted' && <ReasonCancel label="取消" go={p.source === 'form' ? '確定取消' : '確定取消並寄信'} hint={p.source === 'form' ? '原因記在備註。' : '會立刻寄「認購取消」信給買方，原因寫在信裡，寄出無法收回。'}
                        onGo={async (reason) => { if (await act({ action: 'preorder.cancel', id: p.id, reason }, `已取消 ${p.no}${p.source === 'form' ? '' : '，並寄信通知'}`)) setOpenId(null); }} />}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!list.length && <tr><td colSpan={6} className="muted">沒有訂單</td></tr>}
          </tbody>
        </table></div>
      </div>

      <details className="card">
        <summary style={{ cursor: 'pointer' }}><b>本站預購單（/buy）設定</b> <span className="small muted">{st.event.preorderOpen ? '開放中' : '關閉中：/buy 顯示「目前尚未開放認購登記」'}</span></summary>
        <label className="switch" style={{ marginTop: 8 }}><input type="checkbox" checked={st.event.preorderOpen} disabled={busy}
          onChange={(e) => act({ action: 'event.update', values: { preorderOpen: e.target.checked } }, e.target.checked ? '已開放預購單' : '已關閉預購單')} />開放本站預購單（認購登記頁 /buy 能不能送出）</label>
        <div className="row" style={{ marginTop: 8 }}>
          <span className="mono" style={{ fontSize: 15 }}>{buyUrl}</span>
          <button className="btn pri" onClick={() => navigator.clipboard?.writeText(inviteText(st, buyUrl)).then(() => setMsg({ kind: 'ok', text: '已複製「連結＋邀請文字」，可直接貼到 LINE' }), () => undefined)}>複製連結＋邀請文字（貼 LINE 用）</button>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(buyUrl).then(() => setMsg({ kind: 'ok', text: `已複製網址 ${buyUrl}` }), () => undefined)}>只複製網址</button>
          <a className="btn" href="/buy" target="_blank" rel="noreferrer">開啟預購單</a>
        </div>
        {!st.event.bankAccount && <div className="note err" style={{ marginTop: 8 }}>尚未填寫匯款帳戶，預購單會顯示空白，請到「二、價格設定」填寫。</div>}
        <PreorderSettings />
        <LineUrlSetting />
      </details>
      <FormCard />
    </div>
  );
}

/* ---------- 九、驗票 ---------- */
function Gates() {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const [name, setName] = useState('');
  const base = typeof window !== 'undefined' ? location.origin : '';
  const link = (g: Gate) => `${base}/scan/${g.token}`;
  const c = st.checkins;
  const pct = c.total ? Math.round((c.entered / c.total) * 100) : 0;
  const copy = (g: Gate, withText: boolean) => navigator.clipboard?.writeText(withText
    ? `【${st.event.name}】${g.name} 驗票連結（請用手機 Chrome 或 Safari 開啟，允許使用相機）：\n${link(g)}\n此連結只能驗票，請勿外流。`
    : link(g)).then(() => setMsg({ kind: 'ok', text: `已複製 ${g.name} 的驗票連結` }), () => undefined);
  return (
    <div className="pstack">
      <div className="stats">
        <div className="stat"><b style={{ color: 'var(--ok)' }}>{c.entered}</b><span>已入場</span></div>
        <div className="stat"><b>{c.total}</b><span>已售票數</span></div>
        <div className="stat"><b>{c.total - c.entered}</b><span>未入場</span></div>
        <div className="stat"><b>{pct}%</b><span>入場率</span></div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>驗票門口 <span className="small muted">每個門一條連結，傳給該門工作人員，用手機打開就能掃描</span></h2>
          {!st.gates.length && (
            <div className="note" style={{ marginBottom: 10 }}>
              尚未建立。會堂左右各 4 個門，可以一次建立：
              <button className="btn pri small" style={{ marginLeft: 8 }} disabled={busy} onClick={() => act({ action: 'gate.create', names: ['左1', '左2', '左3', '左4', '右1', '右2', '右3', '右4'] }, '已建立左1–左4、右1–右4 共 8 個門口')}>建立 左1–左4、右1–右4</button>
            </div>
          )}
          <div className="tbl"><table>
            <thead><tr><th>門口</th><th>已驗</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {st.gates.map((g) => (
                <tr key={g.id}>
                  <td><b>{g.name}</b></td>
                  <td className="mono">{g.count}</td>
                  <td>{g.active ? <span className="pill p-paid">使用中</span> : <span className="pill p-cancelled">已停用</span>}</td>
                  <td><div className="row">
                    <button className="btn small pri" disabled={!g.active} onClick={() => copy(g, true)}>複製連結＋說明</button>
                    <button className="btn small" disabled={!g.active} onClick={() => copy(g, false)}>只複製連結</button>
                    <a className={`btn small${g.active ? '' : ' disabled'}`} href={g.active ? `/scan/${g.token}` : undefined} target="_blank" rel="noreferrer">開啟</a>
                    <button className="btn small" disabled={busy} onClick={() => act({ action: 'gate.update', id: g.id, values: { active: !g.active } }, g.active ? `已停用 ${g.name}` : `已啟用 ${g.name}`)}>{g.active ? '停用' : '啟用'}</button>
                    <button className="btn small" disabled={busy} onClick={() => confirm2(`gr${g.id}`, () => act({ action: 'gate.update', id: g.id, values: { renewToken: true } }, `已更換 ${g.name} 的連結，舊連結立即失效，請把新連結傳給工作人員`))}>{sure === `gr${g.id}` ? '再按一次確認' : '換新連結'}</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <form className="row" style={{ marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await act({ action: 'gate.create', names: [name.trim()] }, `已新增 ${name.trim()}`)) setName(''); }}>
            <input value={name} placeholder="新增門口，例：大門、貴賓入口" style={{ flex: 1 }} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={busy || !name.trim()}>新增</button>
          </form>
          <p className="small muted" style={{ marginBottom: 0 }}>
            驗票連結只能驗票，看不到其他資料，也不需要後台帳號。手機遺失或連結外流時，按「換新連結」，舊連結立即失效。
            測試站的網址每次重新啟動都會改變，正式上線前請改用固定網址。
          </p>
        </div>
        <div className="side"><div className="card">
          <h2>最近入場 <span className="small muted">最近 50 筆，每 15 秒更新</span></h2>
          {c.recent.length ? c.recent.map((x) => (
            <div key={x.id} className="selitem">
              <span><b>{x.holder ?? ''}</b> <span className="mono small muted">{x.serial}</span><br /><span className="small muted">{tw(x.at)}・{x.gate}{x.manual ? '・手動' : ''}</span></span>
              <button className="btn small" disabled={busy} onClick={() => confirm2(`cu${x.id}`, () => act({ action: 'checkin.undo', id: x.id }, `已撤銷 ${x.serial} 的入場，這張票可以再掃一次`))}>{sure === `cu${x.id}` ? '確認撤銷' : '撤銷'}</button>
            </div>
          )) : <p className="small muted" style={{ margin: 0 }}>尚無入場紀錄</p>}
        </div></div>
      </div>
    </div>
  );
}

/* ---------- 十、電子發票 ---------- */
const taipeiDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const MODE_LABEL = { mock: '模擬（不連綠界）', test: '綠界測試環境', prod: '正式' } as const;
const INV_STATUS: Record<string, string> = { pending: '待開立', failed: '開立失敗', issued: '已開立', void: '已作廢' };

function EinvSettings() {
  const { st, act, busy, setMsg } = useAdmin();
  const c = st.einvoice;
  const init = { enabled: c.enabled ? '1' : '0', mode: c.mode, timing: c.timing, taxType: c.taxType, itemName: c.itemName, merchantId: c.merchantId, hashKey: '', hashIV: '' };
  const [f, setF] = useState(init);
  const [reason, setReason] = useState('');
  const important = f.enabled !== init.enabled || f.mode !== c.mode || f.timing !== c.timing || f.taxType !== c.taxType;
  const save = async () => {
    if (important && !reason.trim()) { setMsg({ kind: 'err', text: '啟用／停用、模式、開立時機、課稅別有變更，請填寫「依誰指示」' }); return; }
    const values: Record<string, string> = { enabled: f.enabled, mode: f.mode, timing: f.timing, taxType: f.taxType, itemName: f.itemName, merchantId: f.merchantId, hashKey: f.hashKey, hashIV: f.hashIV };
    if (await act({ action: 'einvoice.save', values, reason }, '已儲存電子發票設定')) { setReason(''); setF({ ...f, hashKey: '', hashIV: '' }); }
  };
  return (
    <div className="card">
      <h2>發票設定</h2>
      <div className="fields">
        <label className="f">電子發票<select value={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.value })}><option value="1">啟用</option><option value="0">停用</option></select></label>
        <label className="f">模式<select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as typeof f.mode })}>
          {(['mock', 'test', 'prod'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select></label>
      </div>
      <div className="fields" style={{ marginTop: 8 }}>
        <label className="f">開立時機<select value={f.timing} onChange={(e) => setF({ ...f, timing: e.target.value as typeof f.timing })}>
          <option value="review">核對後開（確認收訖後進待開清單，人工開立）</option><option value="auto">即開（確認收訖、核對無異常就開）</option></select></label>
        <label className="f">課稅別（本場）<select value={f.taxType} onChange={(e) => setF({ ...f, taxType: e.target.value })}><option value="1">應稅（5%，內含）</option><option value="3">免稅</option></select></label>
      </div>
      <label className="f" style={{ marginTop: 8 }}>發票品名（開頭整段）<input value={f.itemName} placeholder="萬變中 喚醒不變的力量 入場券" onChange={(e) => setF({ ...f, itemName: e.target.value })} /></label>
      <p className="small muted" style={{ margin: '4px 0 0' }}>發票上每一項＝「品名（方案）」，方案名會去掉括號、加「套票」，單位「套」，單價依「二、價格設定」。</p>
      <div className="small" style={{ marginTop: 4 }}>{st.preMenu.map((m) => <div key={`${m.kind}${m.id}`}>預覽：<b>{invItemName(invLabel(st.event.name, f.itemName), m.kind, m.name)}</b>　1 {m.kind === 'combo' ? '套' : '張'}　{money(m.price)}</div>)}</div>
      {f.mode === 'prod' && (
        <div className="fields" style={{ marginTop: 8 }}>
          <label className="f">特店編號（MerchantID）<input value={f.merchantId} placeholder="綠界廠商後台 → 系統介接設定" onChange={(e) => setF({ ...f, merchantId: e.target.value })} /></label>
          <label className="f">HashKey<input type="password" value={f.hashKey} autoComplete="new-password" placeholder={c.keySet ? '已設定；要更換才需要填' : ''} onChange={(e) => setF({ ...f, hashKey: e.target.value })} /></label>
          <label className="f">HashIV<input type="password" value={f.hashIV} autoComplete="new-password" placeholder={c.ivSet ? '已設定；要更換才需要填' : ''} onChange={(e) => setF({ ...f, hashIV: e.target.value })} /></label>
        </div>
      )}
      {f.mode === 'test' && <p className="small muted" style={{ margin: '6px 0 0' }}>綠界測試環境一律使用綠界公開的測試特店（2000132），不需要填公司的金鑰。</p>}
      {important && <label className="f" style={{ marginTop: 8 }}><b className="err-text">依誰指示（必填）</b><input value={reason} placeholder="例：王董 10/30 電話指示" onChange={(e) => setReason(e.target.value)} /></label>}
      <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={save}>儲存設定</button>
      {c.log.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>修改紀錄（最近 {c.log.length} 筆）</summary>
          <div className="small" style={{ marginTop: 6 }}>{c.log.map((l, i) => <div key={i}>{tw(l.at)}・{l.actor}：{l.detail}</div>)}</div>
        </details>
      )}
    </div>
  );
}

type Look = { invoiceNo: string; createdAt: string; amount: number; items: { name: string; qty: number; unit: string; price: number; amount: number; remark: string }[]; buyer: string; ubn: string; email: string; tax: string; status: string; uploaded: string; random: string; remark: string; match: boolean };
function InvoiceRow({ x, on, toggle }: { x: Inv; on: boolean; toggle: () => void }) {
  const { act, busy, sure, confirm2, setMsg } = useAdmin();
  const [open, setOpen] = useState(false);
  const [ed, setEd] = useState({ invType: x.invType, invCode: x.invCode, invTitle: x.invTitle });
  const [vr, setVr] = useState({ reason: '', reopen: true });
  const [look, setLook] = useState<Look | null>(null);
  const canPick = x.status === 'pending' || x.status === 'failed';
  return (
    <>
      <tr className={x.checks.length && canPick ? 'warnrow' : ''}>
        <td>{canPick && <input type="checkbox" aria-label={`選取 ${x.orderNo}`} checked={on} onChange={toggle} />}</td>
        <td className="mono">{x.orderNo}</td>
        <td>{x.name}<br /><span className="mono small muted">{x.phone}</span></td>
        <td className="small">{x.buyer}</td>
        <td className="mono">{money(x.amount)}</td>
        <td>
          <span className={`pill ${x.status === 'issued' ? 'p-paid' : x.status === 'void' ? 'p-cancelled' : 'p-pending'}`}>{INV_STATUS[x.status] ?? x.status}</span>
          {x.status === 'issued' && <div className="mono small">{x.invoiceNo}{x.env !== 'prod' && <span className="err-text">（{x.env === 'mock' ? '模擬' : '測試'}）</span>}</div>}
          {canPick && x.checks.length > 0 && <div className="small err-text">⚠ {x.checks.length} 項異常</div>}
          {canPick && x.confirmedAt && taipeiDay(x.confirmedAt) !== taipeiDay(new Date().toISOString()) && <div className="small err-text">{taipeiDay(x.confirmedAt).slice(5).replace('-', '/')} 收訖，現在開日期會是今天</div>}
          {x.status === 'failed' && <div className="small err-text">{x.error}</div>}
        </td>
        <td><button className="btn small" onClick={() => setOpen(!open)}>{open ? '收起' : '明細'}</button></td>
      </tr>
      {open && (
        <tr><td colSpan={7}>
          <div className="bank">
            <span className="muted">訂購人</span><span>{x.name}・{x.phone}・{x.email}</span>
            <span className="muted">金額</span><span className="mono">訂單 {money(x.amount)}{x.paidAmount !== null && x.paidAmount !== x.amount && <b className="err-text">（匯款 {money(x.paidAmount)}）</b>}</span>
            <span className="muted">發票內容</span><span>{x.lines.map((l, i) => <div key={i} className="small">{l.name}　{l.qty} {l.unit} × {money(l.price)} ＝ <b>{money(l.amount)}</b></div>)}
              {x.status === 'issued' && <div className="small muted">（依目前的品名設定顯示）</div>}</span>
            <span className="muted">發票對象</span><span>{x.buyer}<span className="small muted">（送綠界的買受人名稱：{x.invType === 'company' ? x.invTitle : '貴賓'}）</span></span>
            {x.checks.length > 0 && <><span className="muted">電腦核對</span><span className="err-text">{x.checks.map((c, i) => <div key={i}>⚠ {c}</div>)}</span></>}
            {x.status === 'issued' && <><span className="muted">發票</span><span><span className="mono">{x.invoiceNo}・{x.invoiceDate}・隨機碼 {x.randomNumber}・{x.issuedBy}</span>
              {x.env !== 'mock' && <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={async () => {
                const w = window.open('', '_blank'); // 先開視窗，避免被瀏覽器擋下
                const r = await act({ action: 'invoice.print', id: x.id }) as { url: string } | null;
                if (r && w) w.location.href = r.url; else if (r) location.href = r.url; else w?.close();
              }}>看發票</button>}
              {x.env !== 'mock' && <button className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={async () => {
                const r = await act({ action: 'invoice.lookup', id: x.id }) as Look | null; if (r) setLook(r);
              }}>向綠界查詢</button>}</span></>}
            {x.status === 'void' && <><span className="muted">作廢</span><span>{x.invoiceNo}：{x.voidReason}</span></>}
          </div>
          {look && (
            <div className="note" style={{ marginTop: 8, background: 'var(--bg2, #f4f6fa)' }}>
              <b>綠界端的資料</b>（{look.status}・{look.uploaded}）
              <div className="small" style={{ marginTop: 4 }}>發票 <span className="mono">{look.invoiceNo}</span>・{look.createdAt}・隨機碼 {look.random}・{look.tax}</div>
              <div className="small">買受人：{look.buyer || '—'}{look.ubn && `（統編 ${look.ubn}）`}{look.email && `・${look.email}`}</div>
              <table className="small" style={{ marginTop: 4 }}><tbody>{look.items.map((i, n) => <tr key={n}><td>{i.name}</td><td>{i.qty} {i.unit}</td><td className="mono">{money(i.price)}</td><td className="mono">{money(i.amount)}</td><td className="muted">{i.remark}</td></tr>)}</tbody></table>
              <div className="small" style={{ marginTop: 4 }}>總計 <b className="mono">{money(look.amount)}</b>　{look.match ? <b style={{ color: 'var(--ok)' }}>✓ 與本系統金額相符</b> : <b className="err-text">⚠ 與本系統金額 {money(x.amount)} 不同</b>}</div>
              {look.remark && <div className="small muted">備註：{look.remark}</div>}
              <button className="btn small" style={{ marginTop: 4 }} onClick={() => setLook(null)}>收起</button>
            </div>
          )}
          {canPick && (
            <div style={{ marginTop: 8 }}>
              <div className="fields">
                <label className="f">修改發票對象<select value={ed.invType} onChange={(e) => setEd({ invType: e.target.value, invCode: '', invTitle: '' })}>
                  {INV_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
                {ed.invType !== 'member' && <label className="f">{ed.invType === 'company' ? '統一編號' : ed.invType === 'donate' ? '愛心碼' : '號碼'}<input value={ed.invCode} onChange={(e) => setEd({ ...ed, invCode: e.target.value.toUpperCase() })} /></label>}
                {ed.invType === 'company' && <label className="f">公司抬頭<input value={ed.invTitle} onChange={(e) => setEd({ ...ed, invTitle: e.target.value })} /></label>}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn small" disabled={busy} onClick={() => act({ action: 'invoice.edit', id: x.id, ...ed }, '已修改並重新核對')}>儲存並重新核對</button>
                <button className="btn small" disabled={busy} onClick={() => act({ action: 'invoice.recheck', id: x.id }, '已重新核對')}>重新核對</button>
              </div>
            </div>
          )}
          {x.status === 'issued' && (
            <div className="row" style={{ marginTop: 8 }}>
              <input value={vr.reason} maxLength={20} placeholder="作廢原因（必填，20 字內）" style={{ maxWidth: 260 }} onChange={(e) => setVr({ ...vr, reason: e.target.value })} />
              <label className="switch small"><input type="checkbox" checked={vr.reopen} onChange={(e) => setVr({ ...vr, reopen: e.target.checked })} />作廢後重新建立待開發票</label>
              <button className="btn small danger" disabled={busy || !vr.reason.trim()} onClick={() => confirm2(`void${x.id}`, async () => { const r = await act({ action: 'invoice.void', id: x.id, ...vr }) as { reopened: boolean; why: string } | null; if (r) setMsg({ kind: vr.reopen && !r.reopened ? 'warn' : 'ok', text: `已作廢發票 ${x.invoiceNo}${vr.reopen ? (r.reopened ? '，已重新建立待開發票（在「待開立」）' : `；沒有重建待開發票：${r.why}`) : ''}` }); })}>
                {sure === `void${x.id}` ? '再按一次確認作廢' : '作廢這張發票'}</button>
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

function Invoices() {
  const { st, act, busy, setMsg, sure, confirm2 } = useAdmin();
  const [filter, setFilter] = useState<'todo' | 'issued' | 'void' | 'all'>('todo');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const c = st.einvoice;
  const list = st.invoices.filter((x) => filter === 'all' || (filter === 'todo' ? x.status === 'pending' || x.status === 'failed' : x.status === filter));
  const todo = st.invoices.filter((x) => x.status === 'pending' || x.status === 'failed');
  const chosen = st.invoices.filter((x) => sel.has(x.id));
  const flagged = chosen.filter((x) => x.checks.length);
  const toggle = (id: number) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const missing = st.preorders.filter((p) => (p.status === 'confirmed' || (p.status === 'submitted' && !!p.paidOkAt)) && p.amount > 0 && (!p.invoiceState || p.invoiceState.status === 'void')).length;
  const issue = async (force: boolean) => {
    const r = await act({ action: 'invoice.issue', ids: [...sel], force }) as { orderNo: string; status: string; invoiceNo: string; error: string | null }[] | null;
    if (!r) return;
    const ok = r.filter((x) => x.status === 'issued');
    const bad = r.filter((x) => x.status !== 'issued');
    setMsg({ kind: bad.length ? 'err' : 'ok', text: `已開立 ${ok.length} 張${bad.length ? `；${bad.length} 張沒有開出：${bad.map((x) => `${x.orderNo} ${x.error ?? ''}`).join('；')}` : ''}` });
    setSel(new Set());
  };
  return (
    <div className="pstack">
      {!c.enabled ? <div className="note warn">電子發票<b>未啟用</b>。確認收訖時不會建立發票。</div>
        : c.mode !== 'prod' ? <div className="note warn">目前是<b>{MODE_LABEL[c.mode]}</b>，開出的<b>不是正式發票</b>。</div>
        : <div className="note ok">正式模式：開出的是真的發票。開立時機：<b>{c.timing === 'auto' ? '即開' : '核對後開'}</b>・課稅別：<b>{c.taxType === '3' ? '免稅' : '應稅'}</b></div>}
      <div className="grid2">
        <div className="card">
          <h2>發票
            <select value={filter} style={{ width: 'auto' }} onChange={(e) => { setFilter(e.target.value as typeof filter); setSel(new Set()); }}>
              <option value="todo">待開立（{todo.length}）</option><option value="issued">已開立</option><option value="void">已作廢</option><option value="all">全部</option>
            </select>
          </h2>
          <p className="small muted" style={{ margin: '0 0 8px' }}>一筆訂單（收款）開一張。確認收訖時建立，電腦先核對金額與發票對象；有異常的紅底標出，人工確認後才能開。<b>發票日期是開立當天</b>，建議每天收工前把當天收訖的開完。</p>
          {c.enabled && missing > 0 && (
            <div className="note warn" style={{ marginBottom: 8 }}>有 {missing} 筆已匯款（或已發連結）的訂單還沒有發票。
              <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={() => act({ action: 'invoice.backfill' }, '已建立待開發票')}>建立待開發票</button></div>
          )}
          {filter === 'todo' && todo.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn small" onClick={() => setSel(new Set(todo.filter((x) => !x.checks.length).map((x) => x.id)))}>選取全部無異常的（{todo.filter((x) => !x.checks.length).length}）</button>
              <button className="btn small" disabled={!sel.size} onClick={() => setSel(new Set())}>清除選取</button>
              {flagged.length === 0
                ? <button className="btn pri small" disabled={busy || !sel.size} onClick={() => issue(false)}>開立選取的 {sel.size} 張</button>
                : <button className="btn danger small" disabled={busy} onClick={() => confirm2('inv-force', () => issue(true))}>
                    {sure === 'inv-force' ? `再按一次：已人工核對，開立 ${sel.size} 張` : `選取中有 ${flagged.length} 張有異常，確認後開立`}</button>}
            </div>
          )}
          <div className="tbl"><table>
            <thead><tr><th></th><th>訂單</th><th>訂購人</th><th>發票對象</th><th>金額</th><th>狀態</th><th></th></tr></thead>
            <tbody>
              {list.map((x) => <InvoiceRow key={x.id} x={x} on={sel.has(x.id)} toggle={() => toggle(x.id)} />)}
              {!list.length && <tr><td colSpan={7} className="muted">沒有發票</td></tr>}
            </tbody>
          </table></div>
        </div>
        <div className="side"><EinvSettings /></div>
      </div>
    </div>
  );
}

/* ---------- 十一、招待（VIP） ---------- */
type VipRow = State['vips']['list'][number];
const VIP_MODE: Record<string, string> = { scheduled: '演出前自動寄', now: '立即寄出', none: '不寄（紙本親手交）' };
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

/** 取消類按鈕：先按出原因欄，原因必填（至少 2 個字）才能按確認 */
function ReasonCancel({ label, go, hint, full, onGo }: { label: string; go: string; hint?: string; full?: boolean; onGo: (reason: string) => Promise<unknown> | void }) {
  const { busy } = useAdmin();
  const [open, setOpen] = useState(false);
  const [r, setR] = useState('');
  if (!open) return <button className="btn danger" style={full ? { width: '100%', marginTop: 8 } : undefined} disabled={busy} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="note warn" style={{ marginTop: 8, width: '100%', maxWidth: 'min(100%, calc(100vw - 72px))', boxSizing: 'border-box', whiteSpace: 'normal' }}>
      <label className="f">取消原因（必填）<input value={r} autoFocus maxLength={100} placeholder="例：買方要求取消" style={{ width: '100%', boxSizing: 'border-box' }} onChange={(e) => setR(e.target.value)} /></label>
      {hint && <div className="small" style={{ marginTop: 2 }}>{hint}</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn danger" disabled={busy || r.trim().length < 2} onClick={async () => { await onGo(r.trim()); setOpen(false); setR(''); }}>{go}</button>
        <button className="btn" onClick={() => { setOpen(false); setR(''); }}>不取消</button>
      </div>
    </div>
  );
}

/** 推薦人：預設空白，點用過的名字帶入（Email 空白時一併帶入上次的 Email）；沒有推薦人點「無」 */
function RefPick({ v, set, refs }: { v: { referrer: string; email: string }; set: (p: { referrer?: string; email?: string }) => void; refs: { name: string; email: string }[] }) {
  return (
    <div style={{ marginTop: 6 }}>
      <label className="f">推薦人（必填）<input value={v.referrer} placeholder="輸入，或點下方名字" onChange={(e) => set({ referrer: e.target.value })} /></label>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
        {refs.slice(0, 12).map((r) => (
          <button key={r.name} type="button" className={`btn small${v.referrer === r.name ? ' pri' : ''}`}
            onClick={() => set({ referrer: r.name, ...(!v.email.trim() && r.email ? { email: r.email } : {}) })}>{r.name}</button>
        ))}
        <button type="button" className={`btn small${v.referrer === '無' ? ' pri' : ''}`} onClick={() => set({ referrer: '無' })}>無</button>
      </div>
      {refs.length > 0 && <div className="small muted" style={{ marginTop: 2 }}>點名字帶入；Email 空白時會一起帶入他上次用的 Email，請確認。</div>}
    </div>
  );
}

function Vips() {
  const { st, act, busy, setMsg, sure, confirm2, zoneById } = useAdmin();
  const v = st.vips;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<VipRow | null>(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', mode: 'scheduled' as 'scheduled' | 'now' | 'none', note: '', referrer: '' });
  const [info, setInfo] = useState<{ id: number; name: string; phone: string; email: string; referrer: string; note: string } | null>(null);
  const [days, setDays] = useState(String(v.days));
  if (st.user.role !== 'admin') return <div className="note err">招待由主管或網管安排，這個帳號沒有權限。</div>;

  const vipOf = new Map<string, VipRow>();
  v.list.filter((x) => x.status === 'paid').forEach((x) => x.seats.forEach((s) => vipOf.set(s.id, x)));
  const mine = new Set(editing?.seats.map((s) => s.id) ?? []);
  const look = (s: Seat): SeatLook => {
    const vip = vipOf.get(s.id);
    const z = zoneById[s.zoneId];
    if (vip && !mine.has(s.id)) return { kind: 'free', bg: '#5b2a86', ink: '#ffffff', sel: sel.has(s.id), title: `${s.label}・招待：${vip.name}` };
    if (s.status !== 'free' && !mine.has(s.id)) return { kind: 'sold', dim: true, title: `${s.label}・已有訂單` };
    return { kind: 'free', bg: z?.color ?? '#fff', ink: z ? inkFor(z.color) : '#18213a', sel: sel.has(s.id), title: `${s.label}・${s.code}・${z?.name ?? ''}${usageNote(s)}${s.bundle ? '・連座（招待會拆成單人）' : ''}` };
  };
  function usageNote(s: Seat) { const u = st.usages.find((x) => x.id === s.usageId); return u && !u.sellable ? `・${u.name}` : ''; }
  const paint = (ids: string[]) => {
    const ok = ids.filter((id) => { const s = st.seats.find((x) => x.id === id); return s && (s.status === 'free' || mine.has(id)); });
    setSel((p) => { const n = new Set(p); const allOn = ok.every((i) => n.has(i)); ok.forEach((i) => (allOn ? n.delete(i) : n.add(i))); return n; });
  };
  const selLabels = st.seats.filter((s) => sel.has(s.id)).map((s) => s.label);

  async function create() {
    if (!f.name.trim()) { setMsg({ kind: 'err', text: '請填寫姓名' }); return; }
    if (!sel.size) { setMsg({ kind: 'err', text: '請在座位圖上選取座位' }); return; }
    if (!f.referrer.trim()) { setMsg({ kind: 'err', text: '請選推薦人；沒有請點「無」' }); return; }
    const r = await act({ action: 'vip.create', ...f, seatIds: [...sel] }) as { orderNo: string; sendAt: string | null; brokeBundles: number; delivery?: Delivery } | null;
    if (!r) return;
    const when = f.mode === 'none' ? '不寄出，請到「七、紙本入場券」列印' : f.mode === 'now' || !r.sendAt ? `已寄出。${deliveryText(r.delivery).text}` : `將於 ${fmtDay(r.sendAt)} 自動寄出`;
    setMsg({ kind: 'ok', text: `已保留 ${sel.size} 席給 ${f.name}（${r.orderNo}），${when}${r.brokeBundles ? `；有 ${r.brokeBundles} 組連座已改回單人` : ''}` });
    setSel(new Set()); setF({ name: '', phone: '', email: '', mode: f.mode, note: '', referrer: '' }); // 推薦人不自動沿用，避免順手按出
  }

  return (
    <div className="grid2">
      <AdminMap seats={st.seats} vipInstalled={st.event.vipInstalled} look={look} onPaint={paint}
        caption="深紫色＝已安排的招待。點按或拖曳選取座位（紅框）；灰色已有訂單不能選。保留席（例如公關）也可以安排。" />
      <div className="side">
        {editing ? (
          <div className="card">
            <h2>改座位：{editing.name}</h2>
            <p className="small" style={{ margin: '0 0 6px' }}>在座位圖上點選新的座位（原座位已預先選取）。已選 <b>{sel.size}</b> 席：{selLabels.slice(0, 12).join('、')}{selLabels.length > 12 ? '…' : ''}</p>
            <div className="row">
              <button className="btn pri" disabled={busy || !sel.size} onClick={async () => { if (await act({ action: 'vip.seats', id: editing.id, seatIds: [...sel] }, `已更新 ${editing.name} 的座位`)) { setEditing(null); setSel(new Set()); } }}>儲存座位</button>
              <button className="btn" onClick={() => { setEditing(null); setSel(new Set()); }}>取消</button>
            </div>
          </div>
        ) : (
          <div className="card">
            <h2>新增招待 <span className="small muted">已選 {sel.size} 席</span></h2>
            {selLabels.length > 0 && <p className="small" style={{ margin: '0 0 6px' }}>{selLabels.slice(0, 12).join('、')}{selLabels.length > 12 ? '…' : ''}</p>}
            <label className="f">姓名<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="f">手機（選填）<input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
              <label className="f">Email（選填）<input value={f.email} type="email" onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            </div>
            <h3>劃位資料什麼時候寄給對方</h3>
            {(['scheduled', 'now', 'none'] as const).map((m) => (
              <label key={m} className="check" style={{ marginBottom: 4 }}>
                <input type="radio" name="vipmode" checked={f.mode === m} onChange={() => setF({ ...f, mode: m })} />
                <span>{m === 'scheduled' ? <>演出前 {v.days} 天自動寄出{v.defaultSendAt ? `（${fmtDay(v.defaultSendAt)}）` : '（已過，會立即寄出）'}</> : VIP_MODE[m]}</span>
              </label>
            ))}
            <RefPick v={f} set={(p) => setF({ ...f, ...p })} refs={v.referrers} />
            <label className="f" style={{ marginTop: 6 }}>備註（選填，只有後台看得到）<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy || !sel.size} onClick={create}>保留 {sel.size} 席給這位貴賓</button>
            <p className="small muted" style={{ margin: '6px 0 0' }}>招待不收費、不開發票，不算進售票收入。寄出前都可以改座位、改寄送方式或取消。</p>
          </div>
        )}

        <div className="card">
          <h2>招待名單 <span className="small muted">{v.list.filter((x) => x.status === 'paid').length} 位・{st.stats.vipSeats} 席</span></h2>
          {v.list.filter((x) => x.status === 'paid').map((x) => (
            <div key={x.id} className="note" style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>{x.name}</b><span className="mono small">{x.orderNo}</span></div>
              <div className="small">{x.seats.map((s) => s.label).join('、')}</div>
              <div className="small muted">{x.phone}{x.phone && x.email ? '・' : ''}{x.email}</div>
              <div className="small">推薦人：{x.referrer || <span className="muted">（未填）</span>}{x.note ? <span className="muted">・{x.note}</span> : null}</div>
              {info?.id === x.id && (
                <div style={{ marginTop: 6 }}>
                  <label className="f">姓名<input value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} /></label>
                  <div className="fields" style={{ marginTop: 6 }}>
                    <label className="f">手機<input value={info.phone} inputMode="tel" onChange={(e) => setInfo({ ...info, phone: e.target.value })} /></label>
                    <label className="f">Email<input value={info.email} type="email" onChange={(e) => setInfo({ ...info, email: e.target.value })} /></label>
                  </div>
                  <RefPick v={info} set={(p) => setInfo({ ...info, ...p })} refs={v.referrers} />
                  <label className="f" style={{ marginTop: 6 }}>備註<input value={info.note} onChange={(e) => setInfo({ ...info, note: e.target.value })} /></label>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn pri small" disabled={busy} onClick={async () => {
                      if (!info.referrer.trim()) { setMsg({ kind: 'err', text: '請選推薦人；沒有請點「無」' }); return; }
                      const { id: vid, ...rest } = info;
                      if (await act({ action: 'vip.update', id: vid, ...rest }, x.sentAt ? `已更新 ${info.name}。之前寄出的信不會改，要重寄請把寄送方式改成「立即寄」` : `已更新 ${info.name}`)) setInfo(null);
                    }}>儲存</button>
                    <button className="btn small" onClick={() => setInfo(null)}>取消</button>
                  </div>
                </div>
              )}
              <div className="small" style={{ marginTop: 4 }}>
                {x.sentAt ? <span className="ok-text">✓ 已寄出（{fmtDay(x.sentAt)}）</span>
                  : x.sendAt === 'now' ? <span>寄送中</span>
                  : x.sendAt ? <span>排定 <b>{fmtDay(x.sendAt)}</b> 自動寄出</span>
                  : <span className="muted">不寄出（紙本親手交）</span>}
                {x.failed && !x.sentAt && <b className="err-text">・寄送失敗，請看「八、通知設定」通知紀錄</b>}
              </div>
              <div className="row" style={{ marginTop: 6 }}>
                <select value={x.mode} style={{ width: 'auto' }} disabled={busy} onChange={async (e) => {
                  const m = e.target.value;
                  const r = await act({ action: 'vip.mode', id: x.id, mode: m }) as { sendAt: string | null; delivery?: Delivery } | null;
                  if (r) setMsg({ kind: 'ok', text: m === 'none' ? `${x.name}：不寄出` : m === 'now' || !r.sendAt ? `${x.name}：已寄出。${deliveryText(r.delivery).text}` : `${x.name}：將於 ${fmtDay(r.sendAt)} 自動寄出` });
                }}>
                  {(['scheduled', 'now', 'none'] as const).map((m) => <option key={m} value={m}>{VIP_MODE[m]}</option>)}
                </select>
                <button className="btn small" onClick={() => setInfo({ id: x.id, name: x.name, phone: x.phone, email: x.email, referrer: x.referrer, note: x.note })}>改資料</button>
                <button className="btn small" onClick={() => { setEditing(x); setSel(new Set(x.seats.map((s) => s.id))); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>改座位</button>
                <button className="btn small danger" disabled={busy} onClick={() => confirm2(`vipc${x.id}`, () => act({ action: 'vip.cancel', id: x.id }, `已取消 ${x.name} 的招待，座位已釋放`))}>
                  {sure === `vipc${x.id}` ? '再按一次確認取消' : '取消招待'}</button>
              </div>
            </div>
          ))}
          {!v.list.some((x) => x.status === 'paid') && <p className="muted small" style={{ margin: 0 }}>還沒有安排招待。</p>}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small">演出前</span>
            <input value={days} inputMode="numeric" style={{ width: 60 }} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
            <span className="small">天自動寄出</span>
            <button className="btn small" disabled={busy || String(v.days) === days} onClick={() => act({ action: 'vip.days', days: parseInt(days) || 0 }, '已更新，尚未寄出的排程一起改了')}>儲存</button>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>自動寄出要系統當天開著；電腦關機的話，開機後會補寄。紙本入場券在「七、紙本入場券」列印。</p>
        </div>
      </div>
    </div>
  );
}
