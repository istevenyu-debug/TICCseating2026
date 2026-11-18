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
type GiftSeat = { slotId: number; no: number; label: string; optionKey: string; effectiveKey: string; defaulted: boolean; name: string; email: string; phone: string; address: string;
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
        <a href="/join/board" className="small" style={{ display: 'inline-block', marginTop: 6 }}>📊 看劃位現況（大家選到哪裡）</a>
      </div>

      {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ marginBottom: 12 }}>{msg.text}</div>}

      {mineTurn ? (
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

      {skipped.length > 0 && (
        <div className="card" style={{ borderTop: '4px solid var(--warn)' }}>
          <p style={{ marginTop: 0 }}>您的劃位序第 {skipped.map((x) => x.no).join('、')} 號因為叫不到，暫停排隊。</p>
          <button className="btn pri" disabled={busy} onClick={rejoin}>我回來了，重新排隊</button>
        </div>
      )}

      {page.gift && <GiftSection code={code} gift={page.gift} contact={s.contact} reload={load} event={page.event} group={page.venue} />}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>我的劃位序</h2>
        {!page.mine.length ? <p className="muted" style={{ margin: 0 }}>{page.locked ? `本群沒有劃位序（已核對 ${page.tickets} 張）。有疑義請洽 ${s.contact}` : `回報截止後才會確定劃位序。目前已核對 ${page.tickets} 張。`}</p> : (
          <div className="tbl"><table>
            <thead><tr><th>劃位序</th><th>狀態</th></tr></thead>
            <tbody>{page.mine.map((x) => <tr key={x.no}><td className="mono">第 {x.no} 號</td><td>{statusText(x, x.place)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>

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

      <div className="card">
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
      </div>
      {!mineTurn && page.seats.length > 0 && (
        <SeatMap seats={page.seats as unknown as MapProps['seats']} zones={page.zones as unknown as MapProps['zones']} vipInstalled={false} floor="3F" view selected={new Set()} onToggle={() => undefined} locked />
      )}
      <p className="small muted" style={{ textAlign: 'center' }}>這是您專屬的劃位連結，請勿轉傳。有問題請聯絡{s.contact}。</p>
    </main>
  );
}

const fmtDl = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
type Row = { slotId: number; optionKey: string; name: string; email: string; phone: string; address: string };
const rowOf = (x: GiftSeat): Row => ({ slotId: x.slotId, optionKey: x.optionKey || x.effectiveKey, name: x.name, email: x.email, phone: x.phone, address: x.address });

/** 贈票取票方式：每席選方式、填實際入座的人（預設負責人）；QR 可填 Email、複製連結用 LINE 傳 */
function GiftSection({ code, gift, contact, reload, event, group }: { code: string; gift: Gift; contact: string; reload: () => Promise<void>; event: { name: string; showAt: string }; group: string }) {
  const [rows, setRows] = useState<Row[]>(() => gift.seats.map(rowOf));
  const [dirty, setDirty] = useState(false);
  const [all, setAll] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const sig = JSON.stringify(gift.seats.map(rowOf));
  useEffect(() => { if (!dirty) setRows(gift.seats.map(rowOf)); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const opt = (k: string) => gift.options.find((o) => o.key === k);
  const edit = (i: number, v: Partial<Row>) => { setRows((r) => r.map((x, j) => (j === i ? { ...x, ...v } : x))); setDirty(true); setMsg(null); };
  async function save() {
    const miss = rows.findIndex((r) => !r.optionKey);
    if (gift.open && miss >= 0) { setMsg({ kind: 'err', text: `${gift.seats[miss].label} 還沒選取票方式` }); return; }
    setBusy(true); setMsg(null);
    const r = await call<{ changed: number; mailed: number }>(code, { action: 'gift.save', seats: rows });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.message }); return; }
    setDirty(false);
    setMsg({ kind: 'ok', text: r.data.changed ? `已儲存${r.data.mailed ? `，已寄出 ${r.data.mailed} 封電子票 Email` : ''}。` : '沒有變更。' });
    await reload();
  }
  async function mail(slotId: number) {
    setBusy(true);
    const r = await call<{ to: string }>(code, { action: 'gift.mail', slotId });
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: `已重寄到 ${r.data.to}` } : { kind: 'err', text: r.message });
  }
  return (
    <div className="card" style={{ border: '3px solid #d9467a' }}>
      <h2 style={{ margin: '0 0 4px' }}>贈票取票方式</h2>
      {gift.open
        ? <p style={{ margin: '0 0 8px' }}>請在 <b>{fmtDl(gift.deadline)}</b> 前，為每一席選擇取票方式，並填寫實際入座的人（預設為您）。逾期未回覆視為「{gift.defaultName}」。</p>
        : <p style={{ margin: '0 0 8px' }}>回覆已截止（{fmtDl(gift.deadline)}），取票方式不能再改；入座者姓名、Email 仍可修改。如需更改方式請洽{contact}。</p>}
      <ol className="small" style={{ margin: '0 0 10px', paddingLeft: 20 }}>
        {gift.options.filter((o) => o.active).map((o) => <li key={o.key}><b>{o.name}</b>{o.desc ? `：${o.desc}` : ''}</li>)}
      </ol>
      {gift.open && gift.seats.length > 1 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, background: '#fff5f8', padding: 8, borderRadius: 8 }}>
          <span>全部套用：</span>
          <select value={all} onChange={(e) => setAll(e.target.value)}>
            <option value="">請選擇</option>
            {gift.options.filter((o) => o.active).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
          </select>
          <button className="btn small" disabled={!all} onClick={() => { setRows((r) => r.map((x) => ({ ...x, optionKey: all }))); setDirty(true); setMsg(null); }}>套用到 {gift.seats.length} 席</button>
        </div>
      )}
      {gift.seats.map((x, i) => {
        const r = rows[i] ?? rowOf(x);
        const o = opt(r.optionKey);
        return (
          <div key={x.slotId} style={{ borderTop: '1px solid var(--line, #e3e7ef)', padding: '10px 0' }}>
            <div style={{ fontWeight: 700 }}>三樓 {x.label} <span className="muted small">・劃位序第 {x.no} 號{x.entered ? '・已入場' : ''}</span></div>
            <div className="fields" style={{ marginTop: 6 }}>
              <label className="f">取票方式
                <select value={r.optionKey} disabled={!gift.open || !!x.entered} onChange={(e) => edit(i, { optionKey: e.target.value })}>
                  <option value="">請選擇</option>
                  {gift.options.filter((y) => y.active || y.key === r.optionKey).map((y) => <option key={y.key} value={y.key}>{y.name}</option>)}
                </select>
                {x.defaulted && <span className="small muted">（逾期未選，系統預設）</span>}
              </label>
              <label className="f">入座者姓名<input value={r.name} maxLength={30} disabled={!!x.entered} onChange={(e) => edit(i, { name: e.target.value })} /></label>
              {o?.kind === 'qr' && <label className="f">入座者 Email（選填，填了會寄電子票）<input type="email" value={r.email} maxLength={120} onChange={(e) => edit(i, { email: e.target.value })} /></label>}
              {o?.needAddress && <>
                <label className="f">收件人手機<input value={r.phone} inputMode="tel" onChange={(e) => edit(i, { phone: e.target.value })} /></label>
                <label className="f">收件地址<input value={r.address} maxLength={150} onChange={(e) => edit(i, { address: e.target.value })} /></label>
              </>}
            </div>
            {x.qr && !dirty && (
              <div className="small" style={{ marginTop: 4, color: '#d9467a' }}>
                已有電子票（序號 {x.qr.serial}），見下方票卡{x.mailedTo ? `・已寄到 ${x.mailedTo}` : ''}
                {x.email && <button className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={() => mail(x.slotId)}>重寄 Email</button>}
              </div>
            )}
          </div>
        );
      })}
      {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ margin: '8px 0' }}>{msg.text}</div>}
      <button className="btn pri" style={{ width: '100%', padding: 12, fontSize: 17 }} disabled={busy || !dirty} onClick={save}>{busy ? '儲存中…' : dirty ? '儲存' : '已儲存'}</button>
      <p className="small muted" style={{ margin: '8px 0 0' }}>電子票每席一個 QR，只能入場一次。改了姓名，該席會換新 QR、舊的失效。</p>
      {!dirty && gift.seats.some((x) => x.qr) && (
        <div style={{ marginTop: 18 }}>
          <h2 style={{ margin: '0 0 4px' }}>電子票卡</h2>
          <p style={{ margin: '0 0 12px' }}>每一席一張，<b>截圖後用 LINE 傳給入座的人</b>。</p>
          {gift.seats.filter((x) => x.qr).map((x) => (
            <div key={x.slotId} style={{ padding: '14px 0 28px' }}>
              <GiftCard seat={x.label} name={x.name} group={group} serial={x.qr!.serial} value={x.qr!.value} eventName={event.name} showAt={event.showAt} entered={x.entered} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
