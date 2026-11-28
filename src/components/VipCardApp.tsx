'use client';

import { useEffect, useState } from 'react';
import TicketQR from './TicketQR';
import SeatMap from './SeatMap';
import { copyCard, downloadCard } from './vipCardImage';

type Card = {
  serial: string; value: string; seat: string; seatId: string; name: string; needName: boolean; org: string; orderId: number; email: string;
  sentAt: string | null; sending: boolean; failed: boolean; receivedAt: string | null; entered: boolean;
};
type Log = { at: string; actor: string; what: string; text: string };
type Data = { kind: 'vip' | 'charity'; label: string; event: { name: string; showAt: string }; leader: string; asAdmin?: boolean; off?: boolean; cards: Card[]; total: number; sent: number; log: Log[] };
type MapProps = Parameters<typeof SeatMap>[0];
type SeatView = { kind: 'vip' | 'charity'; vipInstalled: boolean; rows: number; floors: ('2M' | '3F')[]; free: number; zones: unknown[]; seats: { id: string; label: string; status: string; floor: string }[] };
type Preview = {
  list: { orderId: number; name: string; org: string; email: string; seats: string[] }[]; sentCount: number;
  noEmail: { orderId: number; name: string; seats: string[] }[]; done: { orderId: number; to: string }[]; skipped: { orderId: number; why: string }[];
};
type Res<T> = { ok: true; data: T } | { ok: false; message: string; code?: string };
type Filter = 'all' | 'unsent' | 'noconfirm' | 'confirmed';

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const isSent = (c: Card) => !!c.sentAt || c.sending;
const FILTERS: { k: Filter; label: string; test: (c: Card) => boolean }[] = [
  { k: 'all', label: '全部', test: () => true },
  { k: 'unsent', label: '未寄', test: (c) => !isSent(c) },
  { k: 'noconfirm', label: '已寄未確認', test: (c) => isSent(c) && !c.receivedAt },
  { k: 'confirmed', label: '已確認', test: (c) => !!c.receivedAt },
];
const WHAT: Record<string, string> = { book: '劃位', cancel: '取消', name: '補填', send: '寄出', receipt: '確認收到' };

/** VIP／公益負責人：驗證 Email → 一頁看全部票卡（截圖用 LINE 傳）→ 寄給本人／全部寄出、看確認收到、自己劃位、取消這席、清單、紀錄 */
export default function VipCardApp({ code }: { code: string }) {
  const tkKey = `vc:${code}`;
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [need, setNeed] = useState(false);
  const [err, setErr] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'cards' | 'list' | 'log'>('cards');
  const [filter, setFilter] = useState<Filter>('all');
  const [msg, setMsg] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  const [mailFor, setMailFor] = useState<Record<number, string>>({});
  const [sure, setSure] = useState<number | null>(null);
  const [cancelSure, setCancelSure] = useState<string | null>(null);
  const [cancelMsg, setCancelMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [desk, setDesk] = useState(false); // 桌機（滑鼠）才顯示「複製圖片／下載圖片」
  const [imgMsg, setImgMsg] = useState<{ serial: string; ok: boolean; text: string } | null>(null);
  const [nameFor, setNameFor] = useState<Record<string, string>>({});
  const [nameMsg, setNameMsg] = useState<{ serial: string; ok: boolean; text: string } | null>(null);
  const [map, setMap] = useState<SeatView | null>(null);
  const [floor, setFloor] = useState<'2M' | '3F'>('2M');
  const [pick, setPick] = useState<string[]>([]);
  const [pickName, setPickName] = useState<Record<string, string>>({});
  const [pickMail, setPickMail] = useState<Record<string, string>>({});
  const [pickOrg, setPickOrg] = useState('');
  const [bookSure, setBookSure] = useState(false);
  const [bookMsg, setBookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [all, setAll] = useState<Preview | null>(null);
  const [allMsg, setAllMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { try { setDesk(window.matchMedia('(pointer: fine)').matches); } catch { /* 略過 */ } }, []);

  const call = async <T,>(method: string, body?: unknown, tk = token, qs = ''): Promise<Res<T>> => {
    try {
      const r = await fetch(`/api/vc/${encodeURIComponent(code)}${qs}`, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(tk ? { 'x-vc-token': tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return await r.json();
    } catch { return { ok: false, message: '網路連線異常，請再試一次。' }; }
  };
  async function load(tk = token) {
    const r = await call<Data>('GET', undefined, tk);
    if (r.ok) { setData(r.data); setNeed(false); setErr(''); return; }
    if (r.code === 'AUTH') { setNeed(true); return; }
    setErr(r.message);
  }
  useEffect(() => {
    let tk: string | null = null;
    try {
      tk = localStorage.getItem(tkKey);
      // 切去收信再回來，手機瀏覽器可能重新載入頁面：記住「已寄驗證碼」10 分鐘
      const p = JSON.parse(localStorage.getItem(`${tkKey}:otp`) ?? 'null') as { email: string; sentTo: string; at: number } | null;
      if (p && Date.now() - p.at < 10 * 60_000) { setEmail(p.email); setSentTo(p.sentTo); }
    } catch { /* 無痕模式 */ }
    setToken(tk);
    load(tk);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function askOtp() {
    setBusy(true); setErr('');
    const r = await call<{ sentTo: string }>('POST', { action: 'otp', email });
    setBusy(false);
    if (r.ok) {
      setSentTo(r.data.sentTo);
      try { localStorage.setItem(`${tkKey}:otp`, JSON.stringify({ email, sentTo: r.data.sentTo, at: Date.now() })); } catch { /* 略過 */ }
    } else setErr(r.message);
  }
  async function verify() {
    setBusy(true); setErr('');
    const r = await call<{ token: string }>('POST', { action: 'verify', otp });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    try { localStorage.setItem(tkKey, r.data.token); localStorage.removeItem(`${tkKey}:otp`); } catch { /* 記不住就每次驗證 */ }
    setToken(r.data.token);
    await load(r.data.token);
  }
  const badge = data?.kind === 'charity' ? '公益貴賓席' : 'VIP 貴賓席';
  async function img(c: Card, how: 'copy' | 'down') {
    if (!data) return;
    const x = { seat: c.seat, name: c.name, org: c.org, serial: c.serial, value: c.value, eventName: data.event.name, showAt: data.event.showAt, badge, prefix: data.kind === 'charity' ? 'GY' : 'VIP' };
    try {
      if (how === 'copy') { await copyCard(x); setImgMsg({ serial: c.serial, ok: true, text: '已複製，到電腦版 LINE 對話框按 Ctrl+V 貼上' }); }
      else { await downloadCard(x); setImgMsg({ serial: c.serial, ok: true, text: '已下載圖片' }); }
    } catch (e) { setImgMsg({ serial: c.serial, ok: false, text: (e as Error).message || '複製失敗，請改用「下載圖片」' }); }
  }
  async function saveName(c: Card) {
    const name = (nameFor[c.serial] ?? '').trim();
    if (!name) return;
    setBusy(true);
    const r = await call<{ ok: boolean }>('POST', { action: 'name', orderId: c.orderId, seatId: c.seatId, name });
    setBusy(false);
    setNameMsg({ serial: c.serial, ok: r.ok, text: r.ok ? '已儲存姓名（QR 不變）' : r.message });
    if (r.ok) { setNameFor((m) => ({ ...m, [c.serial]: '' })); await load(); }
  }
  async function cancel(c: Card) {
    if (cancelSure !== c.serial) { setCancelSure(c.serial); return; }
    setCancelSure(null); setBusy(true);
    const r = await call<{ ok: boolean }>('POST', { action: 'cancel', orderId: c.orderId, seatId: c.seatId });
    setBusy(false);
    setCancelMsg({ ok: r.ok, text: r.ok ? `已取消 ${c.seat} ${c.name}，舊 QR 已失效、座位已釋出。要換人請按上方「＋ 新增座位」重新劃位。` : r.message });
    if (r.ok) { await load(); if (map) await openMap(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
  async function openMap() {
    setBookMsg(null);
    const r = await call<SeatView>('GET', undefined, token, '?seats=1');
    if (r.ok) { setMap(r.data); if (!r.data.floors.includes(floor)) setFloor(r.data.floors[0] ?? '2M'); } else setBookMsg({ ok: false, text: r.message });
  }
  function togglePick(id: string) {
    const s = map?.seats.find((x) => x.id === id);
    if (!s || s.status !== 'free') return;
    setBookSure(false);
    setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 20 ? p : [...p, id]));
  }
  async function book() {
    if (pick.some((id) => !(pickName[id] ?? '').trim())) { setBookMsg({ ok: false, text: '每一席都要填姓名職稱' }); return; }
    if (!bookSure) { setBookSure(true); return; }
    setBookSure(false); setBusy(true);
    const r = await call<{ count: number }>('POST', { action: 'book', seats: pick.map((id) => ({ seatId: id, name: pickName[id].trim(), email: (pickMail[id] ?? '').trim() || undefined })), org: pickOrg.trim() || undefined });
    setBusy(false);
    if (r.ok) {
      setBookMsg({ ok: true, text: `已劃好 ${r.data.count} 席，票卡已加在下方（還沒寄信）` });
      setPick([]); setPickName({}); setPickMail({}); setPickOrg('');
      await load(); await openMap();
    } else { setBookMsg({ ok: false, text: r.message }); await openMap(); }
  }
  async function send(c: Card) {
    if (sure !== c.orderId) { setSure(c.orderId); return; }
    setSure(null); setBusy(true);
    const r = await call<{ to: string }>('POST', { action: 'send', orderId: c.orderId, email: mailFor[c.orderId] || undefined });
    setBusy(false);
    setMsg({ id: c.orderId, ok: r.ok, text: r.ok ? `已寄到 ${r.data.to}（約 1 分鐘內收到）` : r.message });
    if (r.ok) { setMailFor((m) => ({ ...m, [c.orderId]: '' })); await load(); }
  }
  async function previewAll() {
    setAllMsg(null); setBusy(true);
    const r = await call<Preview>('POST', { action: 'sendAll', dry: true });
    setBusy(false);
    if (r.ok) setAll(r.data); else setAllMsg({ ok: false, text: r.message });
  }
  async function sendAll() {
    if (!all?.list.length) return;
    setBusy(true);
    const r = await call<Preview>('POST', { action: 'sendAll', dry: false, pick: all.list.map((x) => ({ orderId: x.orderId, email: x.email })) });
    setBusy(false);
    if (r.ok) {
      setAll(null);
      setAllMsg({ ok: !r.data.skipped.length, text: `已寄出 ${r.data.done.length} 封（約 1–2 分鐘內陸續收到）${r.data.skipped.length ? `；${r.data.skipped.length} 筆沒寄：${r.data.skipped.map((s) => s.why).join('、')}` : ''}` });
      await load();
    } else setAllMsg({ ok: false, text: r.message });
  }
  async function excel() {
    if (!data) return;
    const X = await import('xlsx');
    const rows = [['座位', '姓名職稱', '單位', 'Email', '寄出', '確認收到', '入場', '序號'],
      ...data.cards.map((c) => [c.seat, c.name, c.org, c.email, c.sentAt ? hm(c.sentAt) : c.sending ? '寄送中' : '', c.receivedAt ? hm(c.receivedAt) : '', c.entered ? '已入場' : '', c.serial])];
    const wb = X.utils.book_new();
    const ws = X.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 18 }];
    X.utils.book_append_sheet(wb, ws, `${data.label}名單`);
    const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
    X.writeFile(wb, `${data.label}票卡清單-${d}.xlsx`);
  }

  if (err && !need && !data) return <main className="wrap" style={{ maxWidth: 480 }}><div className="card"><p className="note err" style={{ margin: 0 }}>{err}</p></div></main>;
  if (need) return (
    <main className="wrap" style={{ maxWidth: 480 }}>
      <div className="card">
        <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>票卡頁</h1>
        <p className="small" style={{ margin: '0 0 10px' }}>請輸入主辦方登記的 Email，我們會寄 6 位數驗證碼給您。驗證過的這支手機（或電腦）會記住到演出當天，不用每次驗證。</p>
        <label className="f">Email<input type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} /></label>
        <button className={`btn${sentTo ? '' : ' pri'}`} style={{ width: '100%', marginTop: 8, padding: 12 }} disabled={busy || !email.trim()} onClick={askOtp}>{sentTo ? '沒收到？重新寄驗證碼' : '寄驗證碼'}</button>
        <p className="small" style={{ margin: '12px 0 4px' }}>{sentTo ? <>驗證碼已寄到 {sentTo}，10 分鐘內有效。看完信回到這頁，輸入 6 位數即可（不用重寄）。</> : '已經收到驗證碼？直接輸入：'}</p>
        <label className="f">驗證碼<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} /></label>
        <button className="btn pri" style={{ width: '100%', marginTop: 8, padding: 12 }} disabled={busy || otp.length !== 6} onClick={verify}>驗證</button>
        {err && <p className="note err" style={{ marginTop: 10 }}>{err}</p>}
      </div>
    </main>
  );
  if (!data) return <main className="wrap" style={{ maxWidth: 480 }}><div className="card muted">載入中…</div></main>;

  const L = data.label;
  const k = q.trim();
  const ft = FILTERS.find((f) => f.k === filter)!;
  const list = data.cards.filter((c) => ft.test(c) && (!k || c.name.includes(k) || c.org.includes(k) || c.seat.includes(k) || c.email.includes(k)));
  const cnt = (f: Filter) => data.cards.filter(FILTERS.find((x) => x.k === f)!.test).length;
  const wide = desk || view === 'list';
  return (
    <main className="wrap" style={{ maxWidth: wide ? 1140 : 480 }}>
      <div className="card" style={{ maxWidth: 720, margin: '0 auto 12px' }}>
        {data.asAdmin && <div className="note small" style={{ margin: '0 0 8px', background: '#eef2ff' }}>系統管理員檢視（已登入後台，不用驗證碼）：畫面與負責人 {data.leader} 看到的相同；您的操作會記在您的帳號。{data.off ? '　※ 連結目前停用中，負責人進不來。' : ''}</div>}
        <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>{L} 票卡</h1>
        <div className="small muted">{data.event.name}・{data.leader} 您好</div>
        <p style={{ margin: '8px 0' }}>共 <b>{data.cards.length}</b> 席・已寄 <b>{data.cards.filter(isSent).length}</b>・已確認收到 <b>{cnt('confirmed')}</b>・未寄 <b>{cnt('unsent')}</b></p>
        <p className="small" style={{ margin: '0 0 8px' }}>每一席一張，{desk ? <><b>按「複製圖片」，到電腦版 LINE 按 Ctrl+V 貼上</b></> : <><b>截圖後用 LINE 傳</b></>}；或按卡片下方「寄給本人」，也可以按「全部寄出」（會先列出清單給您核對）。對方在信裡按「確認收到」後，這裡會顯示 ✅。</p>
        {data.cards.some((c) => c.needName) && <p className="note small" style={{ margin: '0 0 8px' }}>有 {data.cards.filter((c) => c.needName).length} 席還沒有姓名，可以在該張票卡下方補填。</p>}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {(['cards', 'list', 'log'] as const).map((v) => <button key={v} className={`btn small${view === v ? ' pri' : ''}`} onClick={() => setView(v)}>{v === 'cards' ? '票卡' : v === 'list' ? '清單' : `紀錄（${data.log.length}）`}</button>)}
          <span style={{ flex: 1 }} />
          <button className="btn small" disabled={busy} onClick={previewAll}>全部寄出…</button>
        </div>
        {view !== 'log' && <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {FILTERS.map((f) => <button key={f.k} className={`btn small${filter === f.k ? ' pri' : ''}`} onClick={() => setFilter(f.k)}>{f.label} {cnt(f.k)}</button>)}
          </div>
          <input placeholder="搜尋姓名、單位、座位、Email" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
        </>}
        {allMsg && <div className={`note${allMsg.ok ? '' : ' err'}`} style={{ marginTop: 8 }}>{allMsg.text}</div>}
        {all && <div className="card small" style={{ marginTop: 8, borderColor: '#8a6a2a' }}>
          <b>全部寄出：請先核對收件人</b>
          {all.list.length ? <>
            <p style={{ margin: '6px 0' }}>以下 <b>{all.list.length}</b> 筆還沒寄過、有 Email，按確定才會寄：</p>
            <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid #e3e7ef', borderRadius: 8 }}>
              <table className="tbl" style={{ width: '100%' }}><tbody>
                {all.list.map((x) => <tr key={x.orderId}><td>{x.seats.join('、')}</td><td>{x.name}{x.org ? `（${x.org}）` : ''}</td><td className="mono" style={{ wordBreak: 'break-all' }}>{x.email}</td></tr>)}
              </tbody></table>
            </div>
          </> : <p style={{ margin: '6px 0' }}>沒有要寄的（還沒寄過又有 Email 的：0 筆）。</p>}
          {all.sentCount > 0 && <p style={{ margin: '6px 0 0' }}>已寄過 {all.sentCount} 筆，這次不寄（要補寄請用那張卡的「再寄一次」）。</p>}
          {all.noEmail.length > 0 && <p style={{ margin: '6px 0 0' }}>沒有 Email，不會寄（{all.noEmail.length} 筆）：{all.noEmail.map((x) => `${x.name || '未填姓名'}（${x.seats.join('、')}）`).join('、')}</p>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {all.list.length > 0 && <button className="btn pri" disabled={busy} onClick={sendAll}>確定寄出這 {all.list.length} 封</button>}
            <button className="btn" onClick={() => setAll(null)}>取消</button>
          </div>
        </div>}
        {cancelMsg && <div className={`note${cancelMsg.ok ? '' : ' err'}`} style={{ marginTop: 8 }}>{cancelMsg.text}</div>}
        <div style={{ marginTop: 10 }}>
          {!map ? <button className="btn" style={{ width: '100%' }} onClick={openMap}>＋ 新增{L}座位（自己劃位）</button>
            : <button className="btn small" onClick={() => { setMap(null); setPick([]); setBookSure(false); }}>收起劃位</button>}
          {bookMsg && !map && <div className={`note${bookMsg.ok ? '' : ' err'}`} style={{ marginTop: 6 }}>{bookMsg.text}</div>}
        </div>
      </div>
      {map && <div style={{ width: '100%', maxWidth: 720, margin: '0 auto 12px', minWidth: 0, overflow: 'hidden' }}>
        <div className="card small" style={{ marginBottom: 8 }}>
          <b>新增{L}座位</b>：{map.kind === 'vip' ? `可以選 VIP 排和 2 樓第 1–${map.rows} 排有顏色的空位` : `可以選「公益保留席」有顏色的空位（目前 ${map.free} 席；在座位圖兩側，請左右滑動）`}（灰色不能選）。每一席填姓名職稱（Email 選填，只存不寄）後送出，票卡會加在下方。之後要換人：在票卡下方「取消這席」再重新新增。
        </div>
        {map.floors.length > 1 && <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          {map.floors.map((f) => <button key={f} className={`btn small${floor === f ? ' pri' : ''}`} onClick={() => setFloor(f)}>{f === '2M' ? '2 樓' : '3 樓'}</button>)}
        </div>}
        {map.floors.length === 0 ? <div className="card muted">目前沒有可選的座位，請聯絡主辦方。</div>
          : <SeatMap seats={map.seats.filter((s) => s.floor === floor) as unknown as MapProps['seats']} zones={map.zones as unknown as MapProps['zones']} vipInstalled={map.vipInstalled} floor={floor}
            selected={new Set(pick)} onToggle={togglePick} locked={busy} onBlocked={() => setBookMsg({ ok: false, text: '只能選有顏色的空位。' })} />}
        <div className="card">
          <p style={{ marginTop: 0 }}>已選 <b>{pick.length}</b> 席{pick.length >= 20 ? '（一次最多 20 席）' : ''}</p>
          {pick.map((id) => (
            <div key={id} style={{ marginBottom: 8 }}>
              <label className="f">{map.seats.find((x) => x.id === id)?.label ?? id}　姓名職稱
                <input value={pickName[id] ?? ''} maxLength={60} placeholder="例：王大明 董事長" onChange={(e) => { setBookSure(false); setPickName((m) => ({ ...m, [id]: e.target.value })); }} />
              </label>
              <input type="email" value={pickMail[id] ?? ''} maxLength={120} placeholder="Email（選填，之後按「寄給本人」才會寄）" style={{ width: '100%', marginTop: 4 }} onChange={(e) => { setBookSure(false); setPickMail((m) => ({ ...m, [id]: e.target.value })); }} />
            </div>
          ))}
          {pick.length > 0 && <label className="f">單位（選填，這次選的都用同一個）<input value={pickOrg} maxLength={60} onChange={(e) => setPickOrg(e.target.value)} /></label>}
          {bookMsg && <div className={`note${bookMsg.ok ? '' : ' err'}`} style={{ margin: '8px 0' }}>{bookMsg.text}</div>}
          <button className="btn pri" style={{ width: '100%' }} disabled={busy || !pick.length} onClick={book}>{bookSure ? `再按一次確認劃這 ${pick.length} 席` : `送出（${pick.length} 席）`}</button>
          {bookSure && <p className="small" style={{ margin: '6px 0 0' }}>送出後不會寄信；要換人請在票卡下方「取消這席」。</p>}
        </div>
      </div>}

      {view === 'log' && <div className="card" style={{ maxWidth: 720, margin: '0 auto' }}>
        <h2 style={{ marginTop: 0 }}>紀錄 <span className="small muted">劃位、取消、補填、寄出、確認收到（最近 200 筆）</span></h2>
        {data.log.length ? <table className="tbl small" style={{ width: '100%' }}><tbody>
          {data.log.map((x, i) => <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{hm(x.at)}</td><td style={{ whiteSpace: 'nowrap' }}>{WHAT[x.what] ?? x.what}</td><td>{x.text}<div className="muted">{x.actor}</div></td></tr>)}
        </tbody></table> : <p className="muted">還沒有紀錄</p>}
      </div>}

      {view === 'list' && <div className="card" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}><b>{ft.label}・{list.length} 席</b><span style={{ flex: 1 }} /><button className="btn small" onClick={excel}>下載 Excel</button></div>
        <table className="tbl small" style={{ width: '100%', minWidth: 760 }}>
          <thead><tr><th>座位</th><th>姓名職稱</th><th>單位</th><th>Email</th><th>寄出</th><th>收到確認</th><th>入場</th></tr></thead>
          <tbody>{list.map((c) => <tr key={c.serial}>
            <td style={{ whiteSpace: 'nowrap' }}>{c.seat}</td><td>{c.name || <span className="err-text">未填</span>}</td><td>{c.org}</td>
            <td className="mono" style={{ wordBreak: 'break-all' }}>{c.email}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{c.sentAt ? hm(c.sentAt) : c.sending ? '寄送中' : c.failed ? <span className="err-text">寄送失敗</span> : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{c.receivedAt ? `✅ ${hm(c.receivedAt)}` : '—'}</td>
            <td>{c.entered ? '已入場' : ''}</td>
          </tr>)}</tbody>
        </table>
        {!list.length && <p className="muted">沒有符合的</p>}
      </div>}

      {view === 'cards' && <div className={desk ? 'vc-grid' : ''}>
      {list.map((c) => (
        <div key={c.serial} style={{ padding: '14px 0 10px' }}>
          <div style={{ maxWidth: 340, margin: '0 auto', background: '#fff', border: '4px solid #8a6a2a', borderRadius: 18, padding: '18px 16px 14px', textAlign: 'center', color: '#1f2a44' }}>
            <div style={{ display: 'inline-block', background: '#8a6a2a', color: '#fff', borderRadius: 999, padding: '3px 16px', fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>{badge}</div>
            <div style={{ fontSize: 30, fontWeight: 800, marginTop: 10, lineHeight: 1.15 }}>{c.seat}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{c.name || <span style={{ color: '#b45309', fontSize: 16 }}>（尚未填姓名）</span>}</div>
            {c.org && <div style={{ fontSize: 14, color: '#6b7488' }}>{c.org}</div>}
            <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0 4px' }}><TicketQR serial={c.serial} value={c.value} size={230} /></div>
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7488' }}>序號 {c.serial}</div>
            {c.entered && <div style={{ marginTop: 6, color: '#1a7f4b', fontWeight: 700 }}>已入場</div>}
            <div style={{ borderTop: '1px dashed #c9b27a', marginTop: 10, paddingTop: 8, fontSize: 13, lineHeight: 1.55 }}>
              <div style={{ fontWeight: 700 }}>{data.event.name}</div>
              <div>{when(data.event.showAt)}・台北國際會議中心 大會堂</div>
              <div style={{ color: '#6b7488', fontSize: 12 }}>入場出示此 QR・每個 QR 限用一次</div>
            </div>
          </div>
          {desk && <div className="row" style={{ maxWidth: 340, margin: '8px auto 0', gap: 6 }}>
            <button className="btn small pri" style={{ flex: 1 }} onClick={() => img(c, 'copy')}>複製圖片（貼到 LINE）</button>
            <button className="btn small" style={{ flex: 1 }} onClick={() => img(c, 'down')}>下載圖片</button>
          </div>}
          {imgMsg?.serial === c.serial && <div className={`note small${imgMsg.ok ? '' : ' err'}`} style={{ maxWidth: 340, margin: '6px auto 0' }}>{imgMsg.text}</div>}
          {c.needName && <div className="card small" style={{ maxWidth: 340, margin: '8px auto 0', padding: 10, borderColor: '#b45309' }}>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input placeholder="填姓名職稱" maxLength={60} value={nameFor[c.serial] ?? ''} onChange={(e) => setNameFor((m) => ({ ...m, [c.serial]: e.target.value }))} style={{ flex: 1, minWidth: 0 }} />
              <button className="btn small pri" disabled={busy || !(nameFor[c.serial] ?? '').trim()} onClick={() => saveName(c)}>儲存</button>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>存好後票卡會顯示姓名，QR 不變。填過就不能改（要換人請取消這席再新增）。</div>
          </div>}
          {nameMsg?.serial === c.serial && <div className={`note small${nameMsg.ok ? '' : ' err'}`} style={{ maxWidth: 340, margin: '6px auto 0' }}>{nameMsg.text}</div>}
          <div className="card small" style={{ maxWidth: 340, margin: '8px auto 0', padding: 10 }}>
            {c.sentAt ? <div className="ok-text">已寄給本人 {hm(c.sentAt)}</div> : c.sending ? <div>寄送中…</div> : c.failed ? <div className="err-text">上次寄送失敗，請確認 Email 後再寄</div> : null}
            {c.receivedAt ? <div className="ok-text">✅ 已確認收到 {hm(c.receivedAt)}</div> : isSent(c) ? <div className="muted">對方還沒按「確認收到」</div> : null}
            {c.email && <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
              <span style={{ wordBreak: 'break-all' }}>寄到 {c.email}</span>
              <button className="btn small pri" disabled={busy} onClick={() => send(c)}>{sure === c.orderId ? (isSent(c) ? '確定再寄一次？' : '確定寄出？') : isSent(c) ? '再寄一次' : '寄給本人'}</button>
            </div>}
            <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
              <input type="email" placeholder={c.email ? '或改寄到其他 Email' : '對方的 Email'} value={mailFor[c.orderId] ?? ''} onChange={(e) => setMailFor((m) => ({ ...m, [c.orderId]: e.target.value }))} style={{ flex: 1, minWidth: 0 }} />
              {(!c.email || mailFor[c.orderId]) && <button className="btn small pri" disabled={busy || !(mailFor[c.orderId] ?? '').trim()} onClick={() => send(c)}>{sure === c.orderId ? '確定寄出？' : '寄出'}</button>}
            </div>
            {msg?.id === c.orderId && <div className={`note${msg.ok ? '' : ' err'}`} style={{ marginTop: 6 }}>{msg.text}</div>}
            {!c.entered && <div style={{ marginTop: 8, textAlign: 'right' }}>
              <button className="btn small danger" disabled={busy} onClick={() => cancel(c)}>{cancelSure === c.serial ? '再按一次：取消這席（舊 QR 失效）' : '取消這席'}</button>
              {cancelSure === c.serial && <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setCancelSure(null)}>不要</button>}
            </div>}
          </div>
        </div>
      ))}
      </div>}
      {view === 'cards' && !list.length && <div className="card muted">{data.cards.length ? '沒有符合的' : `目前還沒有${L}`}</div>}
      <p className="small muted" style={{ textAlign: 'center' }}>已填的姓名不能改；要換人請「取消這席」再新增（全部留紀錄）。「寄給本人」寄的是同一張票，不會換 QR。</p>
    </main>
  );
}
