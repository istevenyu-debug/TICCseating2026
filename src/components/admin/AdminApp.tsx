'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AdminState } from '@/lib/admin';
import { inkFor } from '@/lib/color';
import { comboDesc, comboQty } from '@/lib/pricing';
import AdminMap, { type SeatLook } from './AdminMap';

type State = AdminState & { user: { username: string; displayName: string; role: string } };
type Seat = State['seats'][number];
type Order = State['orders'][number];
type Tab = 'home' | 'usage' | 'price' | 'links' | 'orders' | 'tickets';

const TABS: [Tab, string][] = [
  ['home', '首頁'], ['usage', '一、席位用途'], ['price', '二、價格設定'], ['links', '三、專屬連結'], ['orders', '三、訂單與到帳'], ['tickets', '四、紙本入場券'],
];
const COLOR_PRESETS = [
  '#b8ccf3', '#c4e5cf', '#f0dbb1', '#e6c3e5', '#bde2ea', '#f5c4c4', '#d9e7a8', '#c9c2f0', '#ffd29d',
  '#ffadad', '#9fd8c8', '#d3d3d3', '#4f7bd8', '#2f9a62', '#d9822b', '#c0392b', '#8e44ad', '#555e70',
];
const USAGE_COLOR: Record<string, string> = { sale: '#dfe5f1', 'hold-pr': '#f5c6a5', 'hold-sponsor': '#cdbdf2', closed: '#ffffff' };
const STATUS: Record<string, string> = { held: '暫存中・填寫資料', pending: '待確認到帳', paid: '劃位成功', cancelled: '已取消', expired: '逾時取消' };
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
const todayTW = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

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
  setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void;
  zoneById: Record<number, State['zones'][number]>; usageById: Record<number, State['usages'][number]>; now: number;
  filter: string; setFilter: (v: string) => void; openId: number | null; setOpenId: (id: number | null) => void; openOrder: (o: Order) => void;
}
const AdminCtx = createContext<Ctx | null>(null);
const useAdmin = () => useContext(AdminCtx)!;

export default function AdminApp() {
  const [st, setSt] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => { if (msg?.kind !== 'ok') return; const id = setTimeout(() => setMsg(null), 6000); return () => clearTimeout(id); }, [msg]);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState<string | null>(null); // 二次確認的按鈕
  const [, tick] = useState(0);
  const [filter, setFilter] = useState('all');
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/state', { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (!r) { setMsg({ kind: 'err', text: '網路連線異常，請稍後再試。' }); return; }
    if (!r.ok) { if (r.code === 'UNAUTHORIZED') location.reload(); else setMsg({ kind: 'err', text: r.message }); return; }
    setSt(r.data);
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
          <div className="small muted">{st.event.name}・{tw(st.event.showAt)}・{st.user.displayName}</div>
        </div>
        <div className="row">
          <a className="btn" href="/" target="_blank" rel="noreferrer">網站首頁</a>
          <button className="btn" onClick={async () => { await fetch('/api/admin/logout', { method: 'POST' }); location.reload(); }}>登出</button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map(([k, n]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {n}{k === 'orders' && st.stats.newOrders ? <span className="badge">{st.stats.newOrders}</span> : null}
          </button>
        ))}
      </nav>

      {msg && <div className={`note ${msg.kind}`} role="status" onClick={() => setMsg(null)}
        style={{ position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 50, maxWidth: 'min(560px, calc(100vw - 32px))', boxShadow: '0 6px 24px rgba(0,0,0,.18)', cursor: 'pointer' }}>{msg.text}</div>}

      {st.stats.newOrders > 0 && (
        <div className="alertbar">
          <span><b>有 {st.stats.newOrders} 筆新訂單已送出</b>，消費者已填好匯款資料，請核對入帳後按「確認到帳」。</span>
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
        <div className="stat"><b style={{ color: 'var(--warn)' }}>{st.stats.pending}</b><span>待確認到帳</span></div>
        <div className="stat"><b style={{ color: 'var(--ok)' }}>{st.stats.sold}</b><span>已售出</span></div>
        <div className="stat"><b>{st.stats.reserved}</b><span>保留／不開放</span></div>
        <div className="stat"><b>{money(st.stats.revenue)}</b><span>已到帳金額</span></div>
      </div>

      {tab === 'home' && <Home />}
      {tab === 'usage' && <Usage />}
      {tab === 'price' && <Price />}
      {tab === 'links' && <Links />}
      {tab === 'orders' && <Orders />}
      {tab === 'tickets' && <Tickets />}
    </main>
    </AdminCtx.Provider>
  );

}

/* ---------- 首頁 ---------- */
function Home() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const items: [Tab, string, string, string][] = [
    ['price', '價格設定', '票種名稱、票價與座位底色，依排數和區塊指定座位，組合票，開放訂購與發布', st.zones.slice(0, 3).map((z) => `${z.name || '未命名'} ${money(z.price)}`).join('・')],
    ['usage', '席位用途', '保留公關席、贊助席、不開放座位，加裝 VIP 排', `保留／不開放 ${st.stats.reserved} 席`],
    ['links', '專屬購票連結', '發給受邀對象的購票連結與可購張數', `已發出 ${st.links.length} 條`],
    ['orders', '訂單與到帳確認', '看暫存中與已送出的訂單，核對匯款後按確認，通知消費者劃位成功', `${st.stats.newOrders ? `新訂單 ${st.stats.newOrders} 筆・` : ''}暫存 ${st.stats.held} 席・待確認 ${st.stats.pending} 席`],
    ['tickets', '紙本入場券', '依已確認的訂單產生實名入場券並列印', `已售 ${st.stats.sold} 席`],
  ];
  return (
    <div className="home">
      {items.map(([k, t, d, m], i) => (
        <button key={k} className={`hcard${i === 0 ? ' main' : ''}`} onClick={() => go(k)}><b>{t}</b><span>{d}</span><em>{m}</em></button>
      ))}
      {st.dirty && <div className="note warn" style={{ gridColumn: '1 / -1' }}>開放設定有尚未發布的變更，消費者目前還看不到。請到「價格設定」的「四、開放訂購」按「發布到購票頁」。</div>}
    </div>
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
                <td><input key={`p${z.id}-${z.price}`} defaultValue={z.price || ''} placeholder="請填票價" inputMode="numeric" className={`mono ${z.price ? '' : 'need'}`} style={{ width: 110 }}
                  onBlur={(e) => { const v = parseInt(e.target.value.replace(/[^\d]/g, '')) || 0; if (v !== z.price) act({ action: 'zone.update', id: z.id, values: { price: v } }); }} /></td>
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
          <h3>座位編號（排-席次-區）</h3>
          <p className="small" style={{ margin: 0 }}>例：<b className="mono">03-15-L1</b> 是第3排15號、左區。VIP 排的排號為 V，輪椅席為 WC。區塊：L2 左側區、L1 左區、C0 中區、R1 右區、R2 右側區。</p>
        </div></div>
      </div>

      {/* 三、組合票 */}
      <div className="card">
        <h2>三、組合票 <span className="small muted">由票種與張數組成，可跨票種；套票價格自行填寫</span></h2>
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

      {/* 四、開放訂購 */}
      <div className="card">
        <h2>四、開放訂購 <span className="small muted">勾選要開放的項目，按「發布到購票頁」後消費者才看得到、才能訂購</span></h2>
        <div className="pubgrid">
          <div><h3>總開關</h3>
            <label className="switch"><input type="checkbox" checked={st.event.saleOpen} disabled={busy} onChange={(e) => act({ action: 'event.update', values: { saleOpen: e.target.checked } })} />開放訂購</label>
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
            <b>購票頁目前：</b>{pub?.open ? '開放訂購中' : '未開放'}｜票種：{pub ? pub.zoneIds.map((id) => zoneById[id]?.name).filter(Boolean).join('、') || '無' : '無'}｜購票方式：{pub ? st.combos.filter((c) => pub.comboIds.includes(c.id)).map((c) => c.name).join('、') || '無' : '無'}
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
    name: e.name, saleStart: toLocalInput(e.saleStart), saleEnd: toLocalInput(e.saleEnd), maxPerOrder: String(e.maxPerOrder),
    holdMinutes: String(e.holdMinutes), payHours: String(e.payHours), bankName: e.bankName, bankAccount: e.bankAccount, accountName: e.accountName,
  });
  const f = (k: keyof typeof v, label: string, type = 'text') => (
    <label className="f">{label}<input type={type} value={v[k]} onChange={(x) => setV({ ...v, [k]: x.target.value })} /></label>
  );
  return (
    <>
      <h3>時間、限制與匯款帳戶</h3>
      <div className="fields">
        {f('name', '演出名稱')}{f('maxPerOrder', '每筆訂單上限（張）')}
        {f('saleStart', '開始時間（台北）', 'datetime-local')}{f('saleEnd', '截止時間（台北）', 'datetime-local')}
        {f('holdMinutes', '選位暫存（分鐘）')}{f('payHours', '待確認到帳保留（小時）')}
        {f('bankName', '銀行（含代碼）')}{f('bankAccount', '帳號')}{f('accountName', '戶名')}
      </div>
      <button className="btn pri" style={{ marginTop: 10 }} disabled={busy} onClick={() => act({ action: 'event.update', values: {
        name: v.name, saleStart: fromLocalInput(v.saleStart), saleEnd: fromLocalInput(v.saleEnd),
        maxPerOrder: parseInt(v.maxPerOrder) || 21, holdMinutes: parseInt(v.holdMinutes) || 20, payHours: parseInt(v.payHours) || 48,
        bankName: v.bankName, bankAccount: v.bankAccount, accountName: v.accountName,
      } }, '已儲存。時間與匯款帳戶立即生效，不需發布。')}>儲存這些設定</button>
    </>
  );
}

/* ---------- 專屬連結 ---------- */
function Links() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const [f, setF] = useState({ name: '', phone: '', quota: '21', expiresAt: toDateInput(st.event.showAt) });
  const base = typeof window !== 'undefined' ? location.origin : '';
  const pubLink = st.links.find((l) => l.kind === 'public');
  const [pv, setPv] = useState({ start: toLocalInput(st.event.publicSaleStart), perPhone: String(st.event.publicPerPhone) });
  const copy = (code: string) => navigator.clipboard?.writeText(`${base}/t/${code}`)
    .then(() => setMsg({ kind: 'ok', text: `已複製 ${base}/t/${code}` }), () => setMsg({ kind: 'ok', text: `${base}/t/${code}` }));
  const generalStart = st.event.saleStart ? tw(st.event.saleStart) : '開放後立即';
  return (
    <div className="pstack">
    <div className="card">
      <h2>公開連結 <span className="small muted">整場一條，發給所有人（例如貼在 LINE 群組）；購票人訂購時自己填姓名電話</span></h2>
      {pubLink ? (
        <>
          <div className="row">
            <span className="mono" style={{ fontSize: 15 }}>{base}/t/{pubLink.code}</span>
            {pubLink.status === 'active' ? <span className="pill p-paid">使用中</span> : <span className="pill p-cancelled">已停用</span>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn pri" onClick={() => copy(pubLink.code)}>複製公開連結</button>
            <a className="btn" href={`/t/${pubLink.code}`} target="_blank" rel="noreferrer">開啟購票頁</a>
            <button className="btn" disabled={busy} onClick={() => act({ action: 'link.update', id: pubLink.id, values: { status: pubLink.status === 'active' ? 'disabled' : 'active' } })}>{pubLink.status === 'active' ? '停用' : '啟用'}</button>
          </div>
        </>
      ) : (
        <button className="btn pri" disabled={busy} onClick={() => act({ action: 'link.createPublic' }, '已建立公開連結')}>建立公開連結</button>
      )}
      <h3>先專屬、再公開</h3>
      <div className="fields">
        <label className="f">公開連結開始時間（台北）<input type="datetime-local" value={pv.start} onChange={(e) => setPv({ ...pv, start: e.target.value })} /></label>
        <label className="f">公開連結每支手機上限（0＝不限）<input value={pv.perPhone} inputMode="numeric" onChange={(e) => setPv({ ...pv, perPhone: e.target.value })} /></label>
      </div>
      <p className="small muted">專屬連結從 {generalStart} 開始可訂；公開連結從上面的時間開始，空白代表與專屬連結相同。時間到之前打開公開連結，可以看座位但不能訂。</p>
      <button className="btn" disabled={busy} onClick={() => act({ action: 'event.update', values: { publicSaleStart: fromLocalInput(pv.start), publicPerPhone: parseInt(pv.perPhone) || 0 } }, '已儲存公開連結設定（立即生效）')}>儲存公開連結設定</button>
    </div>
    <div className="grid2">
      <div className="card">
        <h2>已發出的專屬購票連結</h2>
        <div className="tbl"><table>
          <thead><tr><th>代碼</th><th>對象</th><th>手機</th><th>可購／已訂</th><th>有效至</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {st.links.filter((l) => l.kind !== 'public').map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.code}</td><td>{l.name}</td><td className="mono small">{l.phone}</td>
                <td className="mono">{l.quota || '不限'} / {l.used}</td><td className="small">{tw(l.expiresAt)}</td>
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
      <div className="side"><div className="card">
        <h2>發出新連結</h2>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const miss = [!f.name.trim() && '對象姓名', !f.phone.trim() && '手機', !f.expiresAt && '有效期限'].filter(Boolean);
          if (miss.length) { setMsg({ kind: 'err', text: `請填寫：${miss.join('、')}` }); return; }
          const digits = f.phone.replace(/\D/g, '');
          if (!/^09\d{8}$/.test(digits)) { setMsg({ kind: 'err', text: '手機格式應為 09 開頭的 10 位數字，例如 0912-345-678' }); return; }
          const q = parseInt(f.quota.trim() || '0');
          if (!Number.isInteger(q) || q < 0 || q > 200) { setMsg({ kind: 'err', text: '可購張數請填 0–200 的整數（0＝不限）' }); return; }
          const r = await act({ action: 'link.create', name: f.name.trim(), phone: digits, quota: q, expiresAt: f.expiresAt }, `已為 ${f.name.trim()} 產生專屬連結，請在左側清單按「複製連結」`);
          if (r) setF({ name: '', phone: '', quota: f.quota, expiresAt: f.expiresAt });
        }}>
          <label className="f">對象姓名<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="fields" style={{ marginTop: 8 }}>
            <label className="f">手機<input value={f.phone} inputMode="tel" placeholder="09xx-xxx-xxx" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            <label className="f">可購張數（0＝不限）<input value={f.quota} inputMode="numeric" onChange={(e) => setF({ ...f, quota: e.target.value })} /></label>
          </div>
          <label className="f" style={{ marginTop: 8 }}>有效期限（當天 23:59 止）<input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
          <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy}>{busy ? '處理中…' : '產生專屬連結'}</button>
        </form>
      </div></div>
    </div>
    </div>
  );
}

/* ---------- 訂單 ---------- */
function Orders() {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const list = st.orders.filter((o) => filter === 'all' || o.status === filter);
  const o = st.orders.find((x) => x.id === openId) ?? null;
  return (
    <div className="grid2">
      <div className="card">
        <h2>訂單
          <select value={filter} style={{ width: 'auto' }} onChange={(e) => setFilter(e.target.value)}>
            {[['all', '全部'], ['held', '暫存中'], ['pending', '待確認到帳'], ['paid', '劃位成功'], ['cancelled', '已取消'], ['expired', '逾時取消']].map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </h2>
        <div className="tbl"><table>
          <thead><tr><th>編號</th><th>購票人</th><th>座位</th><th>金額</th><th>匯款末5碼</th><th>狀態</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} className={`click${o?.id === x.id ? ' cur' : ''}`} onClick={() => openOrder(x)}>
                <td className="mono">{x.orderNo}</td><td>{x.buyerName}<br /><span className="small muted">{x.linkKind === 'public' ? '公開連結' : '專屬連結'}</span></td>
                <td className="small">{x.seats.map((s) => s.code).join('、')}</td>
                <td className="mono">{money(x.amount)}</td>
                <td className="mono">{x.payment?.last5 ?? '—'}</td>
                <td><span className={`pill p-${x.status}`}>{STATUS[x.status]}</span>{x.isNew && <span className="badge">新</span>}
                  {x.status === 'held' && x.holdUntil && <><br /><span className="small muted">剩 {mmss(Date.parse(x.holdUntil) - now)}</span></>}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={6} className="muted">沒有符合的訂單</td></tr>}
          </tbody>
        </table></div>
      </div>
      <div className="side">{o ? <OrderDetail o={o} /> : <div className="card"><p className="muted small" style={{ margin: 0 }}>點選左側訂單查看明細、確認到帳。</p></div>}</div>
    </div>
  );
}

function OrderDetail({ o }: { o: Order }) {
  const { st, act, busy, sure, confirm2, go, setMsg, zoneById, usageById, now, filter, setFilter, openId, setOpenId, openOrder } = useAdmin();
  const [c, setC] = useState({ date: todayTW(), amount: String(o.payment?.amount ?? o.amount), note: '' });
  return (
    <div className="card">
      <h2>訂單 {o.orderNo} <span className={`pill p-${o.status}`}>{STATUS[o.status]}</span></h2>
      <div className="bank">
        <span className="muted">購票人</span><span>{o.buyerName}</span>
        <span className="muted">手機</span><span className="mono">{o.buyerPhone || '—'}</span>
        <span className="muted">Email</span><span>{o.buyerEmail || '—'}</span>
        <span className="muted">連結</span><span className="mono">{o.linkCode}</span>
        <span className="muted">購票方式</span><span>{o.comboName}</span>
        <span className="muted">應付</span><span className="mono">{money(o.amount)}</span>
        <span className="muted">暫存時間</span><span>{tw(o.createdAt)}</span>
        {o.submittedAt && <><span className="muted">送出時間</span><span>{tw(o.submittedAt)}</span></>}
      </div>
      <h3>座位與實名</h3>
      <div className="tbl"><table><tbody>
        {o.seats.map((s) => <tr key={s.seatId}><td>{s.label}</td><td className="mono small">{s.code}</td><td>{s.holderName ?? <span className="muted">尚未填寫</span>}</td><td className="mono">{s.holderId4 ?? ''}</td></tr>)}
      </tbody></table></div>

      {o.payment && <>
        <h3>消費者填寫的匯款資訊</h3>
        <div className="bank">
          <span className="muted">帳號末5碼</span><span className="mono">{o.payment.last5}</span>
          <span className="muted">金額</span><span className="mono">{money(o.payment.amount)}{o.payment.amount !== o.amount && <b style={{ color: 'var(--red)' }}> 與應付不符</b>}</span>
          <span className="muted">時間</span><span>{o.payment.time}</span>
        </div>
      </>}

      {o.status === 'held' && <>
        <div className="note" style={{ marginTop: 12 }}>消費者正在填寫實名與匯款資料，<b>尚未送出</b>。座位已先保留，剩 {mmss(Date.parse(o.holdUntil ?? '') - now)}，逾時自動釋放。</div>
        <button className="btn danger" style={{ marginTop: 10 }} disabled={busy} onClick={() => confirm2(`cancel${o.id}`, () => act({ action: 'order.cancel', id: o.id }, '已取消暫存，座位已釋放'))}>{sure === `cancel${o.id}` ? '再按一次確認取消' : '取消暫存（釋放座位）'}</button>
      </>}

      {o.status === 'pending' && <>
        <h3>確認到帳</h3>
        <p className="small muted" style={{ margin: '0 0 6px' }}>核對銀行入帳無誤後按下方按鈕：座位改為已售出，並以簡訊與 Email 通知消費者劃位成功。請於 {tw(o.payDueAt)} 前確認，逾時系統會自動取消。</p>
        <div className="fields">
          <label className="f">到帳日期<input type="date" value={c.date} onChange={(e) => setC({ ...c, date: e.target.value })} /></label>
          <label className="f">到帳金額<input value={c.amount} inputMode="numeric" onChange={(e) => setC({ ...c, amount: e.target.value })} /></label>
        </div>
        <label className="f" style={{ marginTop: 8 }}>備註<input value={c.note} placeholder="例：核對網銀明細" onChange={(e) => setC({ ...c, note: e.target.value })} /></label>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn pri" style={{ flex: 1 }} disabled={busy} onClick={() => act({ action: 'order.confirm', id: o.id, date: c.date, amount: parseInt(c.amount.replace(/[^\d]/g, '')) || 0, note: c.note }, '已確認到帳，並通知消費者劃位成功')}>確認到帳，通知消費者劃位成功</button>
          <button className="btn danger" disabled={busy} onClick={() => confirm2(`cancel${o.id}`, () => act({ action: 'order.cancel', id: o.id }, '已取消訂單並通知消費者'))}>{sure === `cancel${o.id}` ? '再按一次確認' : '取消訂單'}</button>
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
      <h2>依訂購資料產生紙本入場券 <span className="small muted">已選 {pick.size} 筆訂單・{n} 張</span></h2>
      <div className="row">
        {paid.map((o) => (
          <label key={o.id} className="switch small" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px' }}>
            <input type="checkbox" checked={pick.has(o.id)} onChange={(e) => { const s = new Set(pick); if (e.target.checked) s.add(o.id); else s.delete(o.id); setPick(s); }} />
            {o.orderNo} {o.buyerName}（{o.seats.length} 張）
          </label>
        ))}
        {!paid.length && <span className="muted">尚無已確認到帳的訂單</span>}
      </div>
      <a className={`btn pri${pick.size ? '' : ' disabled'}`} style={{ marginTop: 12, display: 'inline-block' }}
        href={pick.size ? `/admin/tickets?ids=${[...pick].join(',')}` : undefined} target="_blank" rel="noreferrer">開啟列印頁</a>
      <p className="small muted">列印頁為 A4 每頁 4 張，每張含唯一序號與 QR code。用瀏覽器的列印功能列印，或另存成 PDF。</p>
    </div>
  );
}
