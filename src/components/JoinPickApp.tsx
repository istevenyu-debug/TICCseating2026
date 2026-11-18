'use client';

import { useEffect, useRef, useState } from 'react';
import SeatMap from './SeatMap';
import GiftCard from './GiftCard';
import { fmtDate } from './JoinApp';
import { phoneProblem } from '@/lib/validation';

type Page = {
  event: { name: string; showAt: string }; venue: string; headName: string; tickets: number; locked: boolean; now: string;
  settings: { pickOpen: boolean; paused: boolean; inHours: boolean; hourFrom: string; hourTo: string; turnMin: number; pickMin: number; pickPerSeat?: number; pushBack: number; contact: string };
  current: { nos: number[]; venue: string; mine: boolean; deadline: string | null; seen: boolean } | null;
  queue: { no: number; venue: string; mine: boolean; status: string; misses: number; place: number }[];
  board: { no: number; venue: string; mine: boolean; status: string; misses: number; seat: string }[];
  mine: { no: number; status: string; misses: number; seat: string; place: number }[];
  pickCount: number; draft?: string[]; rep: { name: string; phone: string };
  gift?: Gift | null;
  zones: { id: number; name: string; color: string; gift: boolean }[];
  seats: { id: string; x: number; y: number; no: string; type: string; code: string; label: string; bundle: string | null; zoneId: number; status: 'free' | 'sold' | 'blocked' }[];
};
type GiftOpt = { key: string; name: string; desc: string; kind: 'qr' | 'paper'; needAddress: boolean; active: boolean };
type GiftSeat = { slotId: number; no: number; label: string; optionKey: string; effectiveKey: string; defaulted: boolean; name: string; email: string; phone: string; address: string; self: boolean; isQr: boolean; serial: string;
  qr: { serial: string; value: string; url: string } | null; mailedTo: string; entered: string | null };
type Gift = { deadline: string; open: boolean; defaultName: string; options: GiftOpt[]; seats: GiftSeat[] };
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string; detail?: unknown };
type MapProps = Parameters<typeof SeatMap>[0];

async function call<T>(code: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(`/api/join/p/${encodeURIComponent(code)}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** 輪到時提醒：震動＋嗶一聲（瀏覽器允許時） */
function alertMe() {
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* 不支援 */ }
  try {
    const A = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new A(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination); g.gain.value = 0.2; o.start(); o.stop(ctx.currentTime + 0.6);
  } catch { /* 不支援 */ }
}

/** 負責人劃位：排隊看板（大家看得到排序、誰在劃位、下一位），輪到時選三樓贈席、填領票代表 */
export default function JoinPickApp({ code }: { code: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rep, setRep] = useState<{ name: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const offset = useRef(0);
  const wasMine = useRef(false);
  const jumped = useRef(false);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 已點選的座位先存（時間到時系統會保留這些）
  const saveDraft = (ids: Set<string>, r = rep) => {
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => { call(code, { action: 'draft', seatIds: [...ids], repName: r?.name ?? '', repPhone: r?.phone ?? '' }); }, 500);
  };

  const load = async () => {
    const r = await call<Page>(code);
    if (!r.ok) { setErr(r.message); return; }
    offset.current = new Date(r.data.now).getTime() - Date.now();
    setPage(r.data); setErr('');
    const mine = !!r.data.current?.mine;
    if (mine && !wasMine.current) { alertMe(); setSel(new Set(r.data.draft ?? [])); jumped.current = false; }
    wasMine.current = mine;
    setRep((x) => x ?? r.data.rep);
  };
  useEffect(() => {
    load();
    const a = setInterval(load, 4000);
    const b = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = page?.current?.mine ? '🔔 輪到您劃位了' : '揪團劃位'; }, [page?.current?.mine]);
  // 輪到時：座位圖自動捲到第一個粉紅贈席（兩側斜區），不用自己找
  useEffect(() => {
    if (!page?.current?.mine || jumped.current) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>('.mapscroll button.seat[data-k="free"]');
      const box = el?.closest<HTMLElement>('.mapscroll');
      if (el && box) { box.scrollLeft += el.getBoundingClientRect().left - box.getBoundingClientRect().left - 24; jumped.current = true; }
    }, 300);
    return () => clearTimeout(t);
  }, [page]);

  if (err && !page) return <main className="wrap join"><div className="card"><p className="note err">{err}</p></div></main>;
  if (!page) return <main className="wrap join"><div className="card muted">載入中…</div></main>;

  const s = page.settings;
  const cur = page.current;
  const left = cur?.deadline ? new Date(cur.deadline).getTime() - (Date.now() + offset.current) : 0;
  const mineTurn = !!cur?.mine;
  // 調查信寄出、本群座位都選好了：只留標題＋贈票取票方式（劃位排序、其他群、座位圖都不顯示）
  const giftMode = !!page.gift && page.mine.length > 0 && page.mine.every((x) => x.status === 'done');
  const skipped = page.mine.filter((x) => x.status === 'skip');
  const next = page.queue.filter((x) => x.status === 'wait').slice(0, 3);

  async function pick() {
    if (!page || !rep) return;
    if (sel.size !== page.pickCount) { setMsg({ kind: 'err', text: `請選 ${page.pickCount} 席，目前選了 ${sel.size} 席。` }); return; }
    if (!rep.name.trim()) { setMsg({ kind: 'err', text: '請填寫領票代表姓名' }); return; }
    const pp = phoneProblem(rep.phone); if (pp || !rep.phone.trim()) { setMsg({ kind: 'err', text: `領票代表${pp ?? '手機必填'}` }); return; }
    setBusy(true); setMsg(null);
    const r = await call<{ nos: number[]; seats: string[] }>(code, { action: 'pick', seatIds: [...sel], repName: rep.name, repPhone: rep.phone });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.message }); if (r.code === 'SEAT_TAKEN') setSel(new Set()); load(); return; }
    setMsg({ kind: 'ok', text: `劃位完成！第 ${r.data.nos.join('、')} 號已選好座位。` });
    setSel(new Set()); load(); window.scrollTo(0, 0);
  }
  async function rejoin() {
    setBusy(true);
    const r = await call<{ count: number }>(code, { action: 'rejoin' });
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `已重新排隊（排到最後），共 ${r.data.count} 個劃位序。` } : { kind: 'err', text: r.message });
    load();
  }
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else if (n.size >= page.pickCount) { setMsg({ kind: 'err', text: `這次只能選 ${page.pickCount} 席，要換請先取消一席。` }); return; }
    else n.add(id);
    setSel(n); setMsg(null); saveDraft(n);
  };
  const statusText = (x: { status: string; misses: number; seat: string }, place?: number) =>
    x.status === 'done' ? x.seat : x.status === 'turn' ? '劃位中' : x.status === 'skip' ? '暫停排隊（叫不到）'
      : `排隊中${place !== undefined && place >= 0 ? (place === 0 ? '・下一位' : `・前面還有 ${place} 位`) : ''}${x.misses ? '・已延後' : ''}`;

  return (
    <main className="wrap join" style={{ maxWidth: 900 }}>
      <div className="card">
        <h1 style={{ margin: '0 0 4px' }}>揪團劃位・{page.venue}</h1>
        <div className="muted">{page.event.name}・{fmtDate(page.event.showAt)}・負責人 {page.headName}</div>
        {!giftMode && <a href="/join/board" className="small" style={{ display: 'inline-block', marginTop: 6 }}>📊 看劃位現況（大家選到哪裡）</a>}
      </div>

      {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {giftMode ? null : mineTurn ? (
        <div className="card" style={{ border: '3px solid var(--red)' }}>
          <h2 style={{ margin: 0, color: 'var(--red)' }}>輪到您了！請選 {page.pickCount} 席</h2>
          <p style={{ margin: '6px 0 0' }}>劃位序第 {cur!.nos.join('、')} 號・剩 <b className="mono" style={{ fontSize: 20 }}>{mmss(left)}</b></p>
        </div>
      ) : (
        <div className="card">
          {!s.pickOpen ? <b>劃位尚未開始。開始後輪到您時會寄 Email 通知，也可以開著這頁等候。</b>
            : s.paused ? <b>主辦方暫停劃位中，請稍候。</b>
              : cur ? <div>正在劃位：<b>第 {cur.nos.join('、')} 號 {cur.venue}</b>{cur.deadline && <span className="muted">（剩 {mmss(left)}）</span>}</div>
                : !s.inHours ? <b>劃位時段 {s.hourFrom}–{s.hourTo}，時段外暫停。</b>
                  : <b>目前沒有人在劃位。</b>}
          {s.pickOpen && next.length > 0 && <div className="small" style={{ marginTop: 6 }}>下一位：{next.map((x) => `第 ${x.no} 號 ${x.venue}${x.mine ? '（您）' : ''}`).join('　→　')}</div>}
          <p className="small muted" style={{ margin: '8px 0 0' }}>輪到時請在 {s.turnMin} 分鐘內打開這頁，之後有 {s.pickMin} 分鐘選位{s.pickPerSeat ? `（超過 2 席，每席多 ${s.pickPerSeat} 分鐘）` : ''}；時間到時已點選的座位會先保留。沒打開會延後 {s.pushBack} 號，第二次排到最後。頁面每幾秒自動更新。</p>
        </div>
      )}

      {!giftMode && skipped.length > 0 && (
        <div className="card" style={{ borderTop: '4px solid var(--warn)' }}>
          <p style={{ marginTop: 0 }}>您的劃位序第 {skipped.map((x) => x.no).join('、')} 號因為叫不到，暫停排隊。</p>
          <button className="btn pri" disabled={busy} onClick={rejoin}>我回來了，重新排隊</button>
        </div>
      )}

      {page.gift && <GiftSection code={code} gift={page.gift} contact={s.contact} reload={load} event={page.event} group={page.venue} headName={page.headName} />}

      {!giftMode && <div className="card">
        <h2 style={{ marginTop: 0 }}>我的劃位序</h2>
        {!page.mine.length ? <p className="muted" style={{ margin: 0 }}>{page.locked ? `本群沒有劃位序（已核對 ${page.tickets} 張）。有疑義請洽 ${s.contact}` : `回報截止後才會確定劃位序。目前已核對 ${page.tickets} 張。`}</p> : (
          <div className="tbl"><table>
            <thead><tr><th>劃位序</th><th>狀態</th></tr></thead>
            <tbody>{page.mine.map((x) => <tr key={x.no}><td className="mono">第 {x.no} 號</td><td>{statusText(x, x.place)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>}

      {mineTurn && rep && (
        <>
          <p className="note" style={{ margin: '0 0 8px' }}>粉紅色是可以選的贈席，在<b>左右兩側</b>：請左右滑動座位圖，點一下勾選。</p>
          <SeatMap seats={page.seats as unknown as MapProps['seats']} zones={page.zones as unknown as MapProps['zones']} vipInstalled={false} floor="3F"
            selected={sel} onToggle={toggle} locked={busy} onBlocked={() => setMsg({ kind: 'err', text: '只能選粉紅色的揪團贈席空位。' })} />
          <div className="card">
            <p style={{ marginTop: 0 }}>已選 <b>{sel.size}</b> / {page.pickCount} 席：{page.seats.filter((x) => sel.has(x.id)).map((x) => x.label).join('、') || '—'}</p>
            <div className="fields">
              <label className="f">領票代表（12/9 去年代領票的人）<input value={rep.name} maxLength={30} onChange={(e) => { const r = { ...rep, name: e.target.value }; setRep(r); saveDraft(sel, r); }} /></label>
              <label className="f">領票代表手機<input value={rep.phone} inputMode="tel" onChange={(e) => { const r = { ...rep, phone: e.target.value }; setRep(r); saveDraft(sel, r); }} /></label>
            </div>
            <p className="small muted">領票時報群名、姓名、手機末三碼。</p>
            <button className="btn pri" style={{ width: '100%', padding: 14, fontSize: 18 }} disabled={busy || sel.size !== page.pickCount} onClick={pick}>{busy ? '送出中…' : '送出選位'}</button>
          </div>
        </>
      )}

      {!giftMode && <div className="card">
        <h2 style={{ marginTop: 0 }}>劃位排序（最初順序）</h2>
        {!page.board.length ? <p className="muted" style={{ margin: 0 }}>還沒有劃位序。</p> : (
          <div className="tbl"><table>
            <thead><tr><th>劃位序</th><th>群</th><th>狀態</th></tr></thead>
            <tbody>{page.board.map((x) => {
              const q = page.queue.find((y) => y.no === x.no);
              return <tr key={x.no} style={x.mine ? { background: 'var(--accent-soft, #fff6e0)', fontWeight: 700 } : undefined}>
                <td className="mono">第 {x.no} 號</td><td>{x.venue}{x.mine ? '（您）' : ''}</td><td>{statusText(x, q?.place)}</td></tr>;
            })}</tbody>
          </table></div>
        )}
      </div>}
      {!giftMode && !mineTurn && page.seats.length > 0 && (
        <SeatMap seats={page.seats as unknown as MapProps['seats']} zones={page.zones as unknown as MapProps['zones']} vipInstalled={false} floor="3F" view selected={new Set()} onToggle={() => undefined} locked />
      )}
      <p className="small muted" style={{ textAlign: 'center' }}>這是您專屬的劃位連結，請勿轉傳。有問題請聯絡{s.contact}。</p>
    </main>
  );
}

const fmtDl = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
type Row = { slotId: number; optionKey: string; name: string; email: string; phone: string; address: string };
const rowOf = (x: GiftSeat): Row => ({ slotId: x.slotId, optionKey: x.optionKey || x.effectiveKey, name: x.name, email: x.email, phone: x.phone, address: x.address });
const same = (a: string, b: string) => a.replace(/\s/g, '') === b.replace(/\s/g, '');

/**
 * 贈票取票方式：每席選方式、填實際入座的人（預設負責人）。
 * 按「儲存」先看摘要、再「確認送出」。已回覆的席顯示固定文字（小小的「修改」可再改）。
 * QR：負責人自己持有的才在這頁顯示票卡；設給別人的 Email 必填，電子票只寄給對方。
 */
function GiftSection({ code, gift, contact, reload, event, group, headName }: { code: string; gift: Gift; contact: string; reload: () => Promise<void>; event: { name: string; showAt: string }; group: string; headName: string }) {
  const answered = (x: GiftSeat) => !!(x.optionKey || x.defaulted);
  const [rows, setRows] = useState<Row[]>(() => gift.seats.map(rowOf));
  const [editAll, setEditAll] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState(false);
  const [all, setAll] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const sig = JSON.stringify(gift.seats.map(rowOf));
  useEffect(() => { if (!dirty) setRows(gift.seats.map(rowOf)); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const opt = (k: string) => gift.options.find((o) => o.key === k);
  const editing = (x: GiftSeat) => editAll || !answered(x);
  const anyEdit = gift.seats.some(editing);
  const edit = (i: number, v: Partial<Row>) => { setRows((r) => r.map((x, j) => (j === i ? { ...x, ...v } : x))); setDirty(true); setMsg(null); setReview(false); };
  function check() {
    for (const [i, r] of rows.entries()) {
      if (!editing(gift.seats[i])) continue;
      const o = opt(r.optionKey);
      const lb = gift.seats[i].label;
      if (gift.open && !o) return `${lb} 還沒選取票方式`;
      if (!r.name.trim()) return `${lb} 請填入座者姓名`;
      if (o?.kind === 'qr' && !same(r.name, headName) && !r.email.trim()) return `${lb}：設給別人的電子票，請填入座者 Email（電子票只寄給本人）`;
      if (o?.needAddress && (!r.address.trim() || !r.phone.trim())) return `${lb}：請填收件手機和地址`;
    }
    return '';
  }
  async function send() {
    setBusy(true); setMsg(null);
    const seats = rows.filter((_, i) => editing(gift.seats[i]));
    const r = await call<{ changed: number; mailed: number }>(code, { action: 'gift.save', seats });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.message }); setReview(false); return; }
    setDirty(false); setReview(false); setEditAll(false);
    setMsg({ kind: 'ok', text: r.data.changed ? `已收到您的回覆，確認信已寄到您的信箱${r.data.mailed ? `；電子票已寄出 ${r.data.mailed} 封` : ''}。` : '沒有變更。' });
    await reload();
  }
  async function mail(slotId: number) {
    setBusy(true);
    const r = await call<{ to: string }>(code, { action: 'gift.mail', slotId });
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `已重寄到 ${r.data.to}` } : { kind: 'err', text: r.message });
  }
  const mine = gift.seats.filter((x) => x.qr && !dirty);
  return (
    <div className="card" style={{ border: '3px solid #d9467a' }}>
      <h2 style={{ margin: '0 0 4px' }}>贈票取票方式</h2>
      {anyEdit && (gift.open
        ? <p style={{ margin: '0 0 8px' }}>請在 <b>{fmtDl(gift.deadline)}</b> 前，為每一席選擇取票方式，並填寫實際入座的人（預設為您）。逾期未回覆視為「{gift.defaultName}」。</p>
        : <p style={{ margin: '0 0 8px' }}>回覆已截止（{fmtDl(gift.deadline)}），取票方式不能再改，入座者姓名、Email 仍可修改。如需更改方式請洽{contact}。</p>)}
      {anyEdit && <ol className="small" style={{ margin: '0 0 10px', paddingLeft: 20 }}>
        {gift.options.filter((o) => o.active).map((o) => <li key={o.key}><b>{o.name}</b>{o.desc ? `：${o.desc}` : ''}</li>)}
      </ol>}
      {anyEdit && gift.open && gift.seats.filter(editing).length > 1 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, background: '#fff5f8', padding: 8, borderRadius: 8 }}>
          <span>全部套用：</span>
          <select value={all} onChange={(e) => setAll(e.target.value)}>
            <option value="">請選擇</option>
            {gift.options.filter((o) => o.active).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
          </select>
          <button className="btn small" disabled={!all} onClick={() => { setRows((r) => r.map((x, i) => (editing(gift.seats[i]) ? { ...x, optionKey: all } : x))); setDirty(true); setMsg(null); setReview(false); }}>套用</button>
        </div>
      )}
      {gift.seats.map((x, i) => {
        const r = rows[i] ?? rowOf(x);
        const o = opt(r.optionKey);
        if (!editing(x)) {
          const how = opt(x.effectiveKey)?.name.replace(/（推薦）/, '') ?? '';
          return (
            <div key={x.slotId} style={{ borderTop: '1px solid var(--line, #e3e7ef)', padding: '8px 0' }}>
              <b>三樓 {x.label}</b>｜{how}{x.defaulted ? '（逾期預設）' : ''}｜{x.name}
              {x.isQr && (x.self ? <span className="small" style={{ color: '#d9467a' }}>｜您本人持有，票卡在下方</span>
                : x.email ? <span className="small">｜電子票已寄到 {x.email}{x.mailedTo ? '' : '（尚未寄出）'}</span> : <span className="small" style={{ color: 'var(--warn)' }}>｜請按「修改」補 Email</span>)}
              {o?.needAddress && <div className="small muted">寄到：{x.phone} {x.address}</div>}
              {x.entered && <span className="small" style={{ color: 'var(--ok)' }}>｜已入場</span>}
              {x.isQr && !x.self && x.email && !x.entered && <button className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={() => mail(x.slotId)}>重寄</button>}
            </div>
          );
        }
        const qr = o?.kind === 'qr';
        return (
          <div key={x.slotId} style={{ borderTop: '1px solid var(--line, #e3e7ef)', padding: '10px 0' }}>
            <div style={{ fontWeight: 700 }}>三樓 {x.label}{x.entered ? <span className="small muted">・已入場</span> : null}</div>
            <div className="fields" style={{ marginTop: 6 }}>
              <label className="f">取票方式
                <select value={r.optionKey} disabled={!gift.open || !!x.entered} onChange={(e) => edit(i, { optionKey: e.target.value })}>
                  <option value="">請選擇</option>
                  {gift.options.filter((y) => y.active || y.key === r.optionKey).map((y) => <option key={y.key} value={y.key}>{y.name}</option>)}
                </select>
              </label>
              <label className="f">入座者姓名<input value={r.name} maxLength={30} disabled={!!x.entered} onChange={(e) => edit(i, { name: e.target.value })} /></label>
              {qr && <label className="f">入座者 Email{same(r.name, headName) ? '（選填）' : '（必填：電子票只寄給本人）'}<input type="email" value={r.email} maxLength={120} onChange={(e) => edit(i, { email: e.target.value })} /></label>}
              {o?.needAddress && <>
                <label className="f">收件人手機<input value={r.phone} inputMode="tel" onChange={(e) => edit(i, { phone: e.target.value })} /></label>
                <label className="f">收件地址<input value={r.address} maxLength={150} onChange={(e) => edit(i, { address: e.target.value })} /></label>
              </>}
            </div>
          </div>
        );
      })}
      {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ margin: '8px 0' }}>{msg.text}</div>}
      {anyEdit && !review && (
        <button className="btn pri" style={{ width: '100%', padding: 12, fontSize: 17 }} disabled={busy}
          onClick={() => { const e = check(); if (e) { setMsg({ kind: 'err', text: e }); return; } setMsg(null); setReview(true); }}>儲存</button>
      )}
      {review && (
        <div style={{ border: '2px solid #d9467a', borderRadius: 10, padding: 12, background: '#fff5f8' }}>
          <b>請確認以下內容：</b>
          <ul style={{ margin: '6px 0 10px', paddingLeft: 20 }}>
            {rows.map((r, i) => editing(gift.seats[i]) && (
              <li key={r.slotId}>三樓 {gift.seats[i].label}：{opt(r.optionKey)?.name.replace(/（推薦）/, '') ?? '尚未選擇'}・{r.name}
                {opt(r.optionKey)?.kind === 'qr' ? (same(r.name, headName) ? '（您本人持有）' : `（電子票寄到 ${r.email}）`) : ''}
                {opt(r.optionKey)?.needAddress ? `（寄到 ${r.address}）` : ''}</li>
            ))}
          </ul>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn pri" style={{ flex: 1, padding: 12, fontSize: 17 }} disabled={busy} onClick={send}>{busy ? '送出中…' : '確認送出'}</button>
            <button className="btn" style={{ flex: 1, padding: 12 }} disabled={busy} onClick={() => setReview(false)}>返回修改</button>
          </div>
        </div>
      )}
      {!anyEdit && <div style={{ textAlign: 'right', marginTop: 6 }}><button className="small" style={{ background: 'none', border: 0, color: 'var(--muted, #6b7488)', textDecoration: 'underline', cursor: 'pointer' }} onClick={() => { setEditAll(true); setMsg(null); }}>修改</button></div>}
      {editAll && <div style={{ textAlign: 'right', marginTop: 6 }}><button className="small" style={{ background: 'none', border: 0, color: 'var(--muted, #6b7488)', textDecoration: 'underline', cursor: 'pointer' }} onClick={() => { setEditAll(false); setDirty(false); setReview(false); setRows(gift.seats.map(rowOf)); setMsg(null); }}>取消修改</button></div>}
      {mine.length > 0 && !anyEdit && (
        <div style={{ marginTop: 18 }}>
          <h2 style={{ margin: '0 0 4px' }}>您的電子票卡</h2>
          <p style={{ margin: '0 0 12px' }}>入場時出示票卡上的 QR 即可（可截圖保存）。</p>
          {mine.map((x) => (
            <div key={x.slotId} style={{ padding: '14px 0 28px' }}>
              <GiftCard seat={x.label} name={x.name} group={group} serial={x.qr!.serial} value={x.qr!.value} eventName={event.name} showAt={event.showAt} entered={x.entered} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
