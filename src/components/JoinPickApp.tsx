'use client';

import { useEffect, useRef, useState } from 'react';
import SeatMap from './SeatMap';
import { fmtDate } from './JoinApp';
import { phoneProblem } from '@/lib/validation';

type Page = {
  event: { name: string; showAt: string }; venue: string; headName: string; tickets: number; locked: boolean; now: string;
  settings: { pickOpen: boolean; paused: boolean; inHours: boolean; hourFrom: string; hourTo: string; turnMin: number; pickMin: number; pushBack: number; contact: string };
  current: { nos: number[]; venue: string; mine: boolean; deadline: string | null; seen: boolean } | null;
  queue: { no: number; venue: string; mine: boolean; status: string; misses: number; place: number }[];
  board: { no: number; venue: string; mine: boolean; status: string; misses: number; seat: string }[];
  mine: { no: number; status: string; misses: number; seat: string; place: number }[];
  pickCount: number; rep: { name: string; phone: string };
  zones: { id: number; name: string; color: string; gift: boolean }[];
  seats: { id: string; x: number; y: number; no: string; type: string; code: string; label: string; bundle: string | null; zoneId: number; status: 'free' | 'sold' | 'blocked' }[];
};
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

  const load = async () => {
    const r = await call<Page>(code);
    if (!r.ok) { setErr(r.message); return; }
    offset.current = new Date(r.data.now).getTime() - Date.now();
    setPage(r.data); setErr('');
    const mine = !!r.data.current?.mine;
    if (mine && !wasMine.current) { alertMe(); setSel(new Set()); }
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
    setSel(n); setMsg(null);
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
          <p className="small muted" style={{ margin: '8px 0 0' }}>輪到時請在 {s.turnMin} 分鐘內打開這頁，之後有 {s.pickMin} 分鐘選位。沒打開會延後 {s.pushBack} 號，第二次排到最後。頁面每幾秒自動更新。</p>
        </div>
      )}

      {skipped.length > 0 && (
        <div className="card" style={{ borderTop: '4px solid var(--warn)' }}>
          <p style={{ marginTop: 0 }}>您的劃位序第 {skipped.map((x) => x.no).join('、')} 號因為叫不到，暫停排隊。</p>
          <button className="btn pri" disabled={busy} onClick={rejoin}>我回來了，重新排隊</button>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>我的劃位序</h2>
        {!page.mine.length ? <p className="muted" style={{ margin: 0 }}>{page.locked ? `本團練場沒有劃位序（已核對 ${page.tickets} 張）。有疑義請洽 ${s.contact}` : `回報截止後才會確定劃位序。目前已核對 ${page.tickets} 張。`}</p> : (
          <div className="tbl"><table>
            <thead><tr><th>劃位序</th><th>狀態</th></tr></thead>
            <tbody>{page.mine.map((x) => <tr key={x.no}><td className="mono">第 {x.no} 號</td><td>{statusText(x, x.place)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>

      {mineTurn && rep && (
        <>
          <p className="note" style={{ margin: '0 0 8px' }}>淡黃色是可以選的贈席，在<b>左右兩側</b>：請左右滑動座位圖，點一下勾選。</p>
          <SeatMap seats={page.seats as unknown as MapProps['seats']} zones={page.zones as unknown as MapProps['zones']} vipInstalled={false} floor="3F"
            selected={sel} onToggle={toggle} locked={busy} onBlocked={() => setMsg({ kind: 'err', text: '只能選淡黃色的揪團贈席空位。' })} />
          <div className="card">
            <p style={{ marginTop: 0 }}>已選 <b>{sel.size}</b> / {page.pickCount} 席：{page.seats.filter((x) => sel.has(x.id)).map((x) => x.label).join('、') || '—'}</p>
            <div className="fields">
              <label className="f">領票代表（12/9 去年代領票的人）<input value={rep.name} maxLength={30} onChange={(e) => setRep({ ...rep, name: e.target.value })} /></label>
              <label className="f">領票代表手機<input value={rep.phone} inputMode="tel" onChange={(e) => setRep({ ...rep, phone: e.target.value })} /></label>
            </div>
            <p className="small muted">領票時報團練場、姓名、手機末三碼。</p>
            <button className="btn pri" style={{ width: '100%', padding: 14, fontSize: 18 }} disabled={busy || sel.size !== page.pickCount} onClick={pick}>{busy ? '送出中…' : '送出選位'}</button>
          </div>
        </>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>劃位排序（最初順序）</h2>
        {!page.board.length ? <p className="muted" style={{ margin: 0 }}>還沒有劃位序。</p> : (
          <div className="tbl"><table>
            <thead><tr><th>劃位序</th><th>團練場</th><th>狀態</th></tr></thead>
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
