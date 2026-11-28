'use client';

import { useEffect, useState } from 'react';
import TicketQR from './TicketQR';
import SeatMap from './SeatMap';
import { copyCard, downloadCard } from './vipCardImage';

type Card = { serial: string; value: string; seat: string; seatId: string; name: string; needName: boolean; org: string; orderId: number; email: string; sentAt: string | null; sending: boolean; entered: boolean };
type Data = { event: { name: string; showAt: string }; leader: string; asAdmin?: boolean; off?: boolean; cards: Card[]; total: number; sent: number };
type MapProps = Parameters<typeof SeatMap>[0];
type SeatView = { vipInstalled: boolean; rows: number; zones: unknown[]; seats: { id: string; label: string; status: string }[] };
type Res<T> = { ok: true; data: T } | { ok: false; message: string; code?: string };

const when = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** VIP 負責人：驗證 Email → 一頁看全部 VIP 票卡（截圖用 LINE 傳）→ 每位可「寄給本人」 */
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
  const [msg, setMsg] = useState<{ id: number; ok: boolean; text: string } | null>(null);
  const [mailFor, setMailFor] = useState<Record<number, string>>({});
  const [sure, setSure] = useState<number | null>(null);
  const [desk, setDesk] = useState(false); // 桌機（滑鼠）才顯示「複製圖片／下載圖片」
  const [imgMsg, setImgMsg] = useState<{ serial: string; ok: boolean; text: string } | null>(null);
  const [nameFor, setNameFor] = useState<Record<string, string>>({});
  const [nameMsg, setNameMsg] = useState<{ serial: string; ok: boolean; text: string } | null>(null);
  const [map, setMap] = useState<SeatView | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [pickName, setPickName] = useState<Record<string, string>>({});
  const [pickOrg, setPickOrg] = useState('');
  const [bookSure, setBookSure] = useState(false);
  const [bookMsg, setBookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { try { setDesk(window.matchMedia('(pointer: fine)').matches); } catch { /* 略過 */ } }, []);

  const call = async <T,>(method: string, body?: unknown, tk = token): Promise<Res<T>> => {
    try {
      const r = await fetch(`/api/vc/${encodeURIComponent(code)}`, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(tk ? { 'x-vc-token': tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
  async function img(c: Card, how: 'copy' | 'down') {
    if (!data) return;
    const x = { seat: c.seat, name: c.name, org: c.org, serial: c.serial, value: c.value, eventName: data.event.name, showAt: data.event.showAt };
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
  async function openMap() {
    setBookMsg(null);
    const r = await fetch(`/api/vc/${encodeURIComponent(code)}?seats=1`, { cache: 'no-store', headers: token ? { 'x-vc-token': token } : {} }).then((x) => x.json() as Promise<Res<SeatView>>).catch(() => ({ ok: false, message: '網路連線異常，請再試一次。' } as Res<SeatView>));
    if (r.ok) setMap(r.data); else setBookMsg({ ok: false, text: r.message });
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
    const r = await call<{ count: number }>('POST', { action: 'book', seats: pick.map((id) => ({ seatId: id, name: pickName[id].trim() })), org: pickOrg.trim() || undefined });
    setBusy(false);
    if (r.ok) {
      setBookMsg({ ok: true, text: `已劃好 ${r.data.count} 席，票卡已加在下方` });
      setPick([]); setPickName({}); setPickOrg('');
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

  if (err && !need && !data) return <main className="wrap" style={{ maxWidth: 480 }}><div className="card"><p className="note err" style={{ margin: 0 }}>{err}</p></div></main>;
  if (need) return (
    <main className="wrap" style={{ maxWidth: 480 }}>
      <div className="card">
        <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>VIP 票卡</h1>
        <p style={{ marginTop: 0 }}>請輸入主辦方登記的 Email，我們會寄一組 6 位數驗證碼給您。驗證後，這支手機到活動當晚 23:00 前都不用再驗證。</p>
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

  const k = q.trim();
  const list = data.cards.filter((c) => !k || c.name.includes(k) || c.org.includes(k) || c.seat.includes(k));
  return (
    <main className="wrap" style={{ maxWidth: desk ? 1140 : 480 }}>
      <div className="card" style={{ maxWidth: 720, margin: '0 auto 12px' }}>
        {data.asAdmin && <div className="note small" style={{ margin: '0 0 8px', background: '#eef2ff' }}>系統管理員檢視（已登入後台，不用驗證碼）：畫面與負責人 {data.leader} 看到的相同；您的操作會記在您的帳號。{data.off ? '　※ 連結目前停用中，負責人進不來。' : ''}</div>}
        <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>VIP 票卡</h1>
        <div className="small muted">{data.event.name}・{data.leader} 您好</div>
        <p style={{ margin: '8px 0' }}>VIP 共 <b>{data.total}</b> 位・已寄給本人 <b>{data.sent}</b> 位。<br />每一席一張，{desk ? <><b>按「複製圖片」，到電腦版 LINE 按 Ctrl+V 貼上</b>傳給貴賓</> : <><b>截圖後用 LINE 傳</b>給貴賓</>}；或按卡片下方「寄給本人」。</p>
        {data.cards.some((c) => c.needName) && <p className="note small" style={{ margin: '0 0 8px' }}>有 {data.cards.filter((c) => c.needName).length} 席還沒有姓名，可以在該張票卡下方補填。</p>}
        <input placeholder="搜尋姓名、單位、座位" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
        <div style={{ marginTop: 10 }}>
          {!map ? <button className="btn" style={{ width: '100%' }} onClick={openMap}>＋ 新增 VIP 座位（自己劃位）</button>
            : <button className="btn small" onClick={() => { setMap(null); setPick([]); setBookSure(false); }}>收起劃位</button>}
          {bookMsg && !map && <div className={`note${bookMsg.ok ? '' : ' err'}`} style={{ marginTop: 6 }}>{bookMsg.text}</div>}
        </div>
      </div>
      {map && <div style={{ width: '100%', maxWidth: 720, margin: '0 auto 12px', minWidth: 0, overflow: 'hidden' }}>
        <div className="card small" style={{ marginBottom: 8 }}>
          <b>新增 VIP 座位</b>：可以選 VIP 排和 2 樓第 1–{map.rows} 排有顏色的空位（灰色不能選）。每一席填姓名職稱後送出，票卡會加在下方，不會寄信。<b>選好就不能自己取消</b>，要取消請聯絡主辦方。
        </div>
        <SeatMap seats={map.seats as unknown as MapProps['seats']} zones={map.zones as unknown as MapProps['zones']} vipInstalled={map.vipInstalled} floor="2M"
          selected={new Set(pick)} onToggle={togglePick} locked={busy} onBlocked={() => setBookMsg({ ok: false, text: '只能選有顏色的空位。' })} />
        <div className="card">
          <p style={{ marginTop: 0 }}>已選 <b>{pick.length}</b> 席{pick.length >= 20 ? '（一次最多 20 席）' : ''}</p>
          {pick.map((id) => (
            <label key={id} className="f">{map.seats.find((x) => x.id === id)?.label ?? id}　姓名職稱
              <input value={pickName[id] ?? ''} maxLength={60} placeholder="例：王大明 董事長" onChange={(e) => { setBookSure(false); setPickName((m) => ({ ...m, [id]: e.target.value })); }} />
            </label>
          ))}
          {pick.length > 0 && <label className="f">單位（選填，這次選的都用同一個）<input value={pickOrg} maxLength={60} onChange={(e) => setPickOrg(e.target.value)} /></label>}
          {bookMsg && <div className={`note${bookMsg.ok ? '' : ' err'}`} style={{ margin: '8px 0' }}>{bookMsg.text}</div>}
          <button className="btn pri" style={{ width: '100%' }} disabled={busy || !pick.length} onClick={book}>{bookSure ? `再按一次確認劃這 ${pick.length} 席` : `送出（${pick.length} 席）`}</button>
          {bookSure && <p className="small" style={{ margin: '6px 0 0' }}>送出後不能自己取消。</p>}
        </div>
      </div>}
      <div className={desk ? 'vc-grid' : ''}>
      {list.map((c) => (
        <div key={c.serial} style={{ padding: '14px 0 10px' }}>
          <div style={{ maxWidth: 340, margin: '0 auto', background: '#fff', border: '4px solid #8a6a2a', borderRadius: 18, padding: '18px 16px 14px', textAlign: 'center', color: '#1f2a44' }}>
            <div style={{ display: 'inline-block', background: '#8a6a2a', color: '#fff', borderRadius: 999, padding: '3px 16px', fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>VIP 貴賓席</div>
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
            <div className="muted" style={{ marginTop: 4 }}>存好後票卡會顯示姓名，QR 不變。填過就不能自己改。</div>
          </div>}
          {nameMsg?.serial === c.serial && <div className={`note small${nameMsg.ok ? '' : ' err'}`} style={{ maxWidth: 340, margin: '6px auto 0' }}>{nameMsg.text}</div>}
          <div className="card small" style={{ maxWidth: 340, margin: '8px auto 0', padding: 10 }}>
            {c.sentAt ? <div className="ok-text">已寄給本人 {hm(c.sentAt)}{c.email ? `（${c.email}）` : ''}</div> : c.sending ? <div>寄送中…</div> : null}
            {c.email && <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>寄到 {c.email}</span>
              <button className="btn small pri" disabled={busy} onClick={() => send(c)}>{sure === c.orderId ? (c.sentAt ? '確定再寄一次？' : '確定寄出？') : c.sentAt ? '再寄一次' : '寄給本人'}</button>
            </div>}
            <div className="row" style={{ gap: 6, marginTop: c.email ? 6 : 0, alignItems: 'center' }}>
              <input type="email" placeholder={c.email ? '或改寄到其他 Email' : '貴賓的 Email'} value={mailFor[c.orderId] ?? ''} onChange={(e) => setMailFor((m) => ({ ...m, [c.orderId]: e.target.value }))} style={{ flex: 1, minWidth: 0 }} />
              {(!c.email || mailFor[c.orderId]) && <button className="btn small pri" disabled={busy || !(mailFor[c.orderId] ?? '').trim()} onClick={() => send(c)}>{sure === c.orderId ? '確定寄出？' : '寄出'}</button>}
            </div>
            {msg?.id === c.orderId && <div className={`note${msg.ok ? '' : ' err'}`} style={{ marginTop: 6 }}>{msg.text}</div>}
          </div>
        </div>
      ))}
      </div>
      {!list.length && <div className="card muted">{data.cards.length ? '找不到符合的貴賓' : '目前還沒有 VIP'}</div>}
      <p className="small muted" style={{ textAlign: 'center' }}>已填的姓名、座位有誤請聯絡主辦方修改。「寄給本人」寄的是同一張票，不會換 QR。</p>
    </main>
  );
}
