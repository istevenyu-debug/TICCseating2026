'use client';

import { useEffect, useState } from 'react';
import SeatMap from './SeatMap';

type View = {
  event: string; showAt: string; vipInstalled: boolean; org: string; name: string; n: number; cat: string; email: string; deadline: string;
  closed: boolean; done: boolean; orderNo: string; mine: { seatId: string; label: string; name: string }[]; free: number;
  zones: { id: number; name: string; color: string; gift: boolean }[];
  seats: { id: string; x: number; y: number; no: string; type: string; code: string; label: string; zoneId: number; bundle: string | null; status: string }[];
};
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
type MapProps = Parameters<typeof SeatMap>[0];

async function call<T>(code: string, method = 'GET', body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(`/api/g/${encodeURIComponent(code)}`, method === 'GET' ? { cache: 'no-store' } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}
const tw = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** 公益劃位：負責人選 N 席、每席填姓名職稱；送出後 QR 寄到主辦登記的 Email；截止前可改姓名 */
export default function CharityApp({ code }: { code: string }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const load = async () => {
    const r = await call<View>(code);
    if (!r.ok) { setErr(r.message); return; }
    setV(r.data);
    if (r.data.done) setNames(Object.fromEntries(r.data.mine.map((m) => [m.seatId, m.name])));
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <main className="wrap"><div className="card"><p className="err-text">{err}</p></div></main>;
  if (!v) return <main className="wrap"><p className="muted">載入中…</p></main>;
  const label = (id: string) => v.seats.find((s) => s.id === id)?.label ?? id;
  const toggle = (id: string) => {
    if (v.done || v.closed) return;
    const s = v.seats.find((x) => x.id === id); if (!s || s.status !== 'free') return;
    if (sel.includes(id)) setSel(sel.filter((x) => x !== id));
    else if (sel.length < v.n) setSel([...sel, id]);
    else { setMsg({ kind: 'err', text: `最多選 ${v.n} 席，請先取消一席再選。` }); return; }
    setSure(false); setMsg(null);
  };
  const ordered = v.seats.filter((s) => sel.includes(s.id)).map((s) => s.id); // 依座位順序
  const submit = async () => {
    if (ordered.some((id) => !names[id]?.trim())) { setMsg({ kind: 'err', text: '每一席都要填姓名職稱' }); return; }
    if (!sure) { setSure(true); return; }
    setBusy(true);
    const r = await call<{ orderNo: string }>(code, 'POST', { seatIds: ordered, names: ordered.map((id) => names[id]) });
    setBusy(false); setSure(false);
    if (r.ok) { setMsg({ kind: 'ok', text: `已送出！入場 QR code 會寄到 ${v.email}。` }); setSel([]); }
    else { setMsg({ kind: 'err', text: r.message }); setSel([]); }
    await load();
  };
  const rename = async () => {
    setBusy(true);
    const r = await call<{ changed: number }>(code, 'PUT', { names: v.mine.map((m) => ({ seatId: m.seatId, name: names[m.seatId] ?? '' })) });
    setBusy(false);
    setMsg(r.ok ? { kind: 'ok', text: r.data.changed ? `已更新 ${r.data.changed} 位的姓名。QR code 不變，入場時會顯示新姓名。` : '沒有變更' } : { kind: 'err', text: r.message });
    if (r.ok) await load();
  };
  const changed = v.mine.some((m) => (names[m.seatId] ?? '') !== m.name);

  return (
    <main className="wrap">
      <div className="card">
        <h1 style={{ fontSize: '1.2rem', margin: '0 0 6px' }}>{v.event}・{v.cat}席劃位</h1>
        <p className="small muted" style={{ margin: 0 }}>{tw(v.showAt)}・{v.org}・負責人 {v.name}</p>
        <p className="small" style={{ margin: '4px 0 0' }}>截止：<b>{tw(v.deadline)}</b>{v.closed ? '（已截止）' : ''}</p>
      </div>
      {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ margin: '8px 0' }}>{msg.text}</div>}
      {v.done ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>✅ 已選好 {v.mine.length} 席</h2>
          <p className="small muted" style={{ marginTop: 0 }}>入場 QR code 已寄到 {v.email}（每席一個，請轉給本人）。{v.closed ? '' : '截止前可以改姓名；要換座位請聯絡主辦方。'}</p>
          {v.mine.map((m) => (
            <label key={m.seatId} className="f" style={{ marginTop: 6 }}>{m.label}
              <input value={names[m.seatId] ?? ''} disabled={v.closed} maxLength={60} onChange={(e) => setNames({ ...names, [m.seatId]: e.target.value })} /></label>
          ))}
          {!v.closed && <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy || !changed} onClick={rename}>儲存姓名</button>}
        </div>
      ) : v.closed ? (
        <div className="card"><p className="err-text" style={{ margin: 0 }}>已過截止時間，請聯絡主辦方。</p></div>
      ) : (
        <>
          <div className="card">
            <p style={{ margin: 0 }}>請在座位圖點選 <b>{v.n}</b> 個有顏色的空位（灰色不能選），再替每一席填「姓名職稱」，按送出。</p>
            <p className="small muted" style={{ margin: '4px 0 0' }}>可選的座位還有 {v.free} 席，其他單位也在選，先送出先保留。送出後 QR code 會寄到 {v.email}。</p>
          </div>
          <SeatMap seats={v.seats as unknown as MapProps['seats']} zones={v.zones as unknown as MapProps['zones']} vipInstalled={v.vipInstalled} floor="2M"
            selected={new Set(sel)} onToggle={toggle} locked={busy} onBlocked={() => setMsg({ kind: 'err', text: '只能選有顏色的空位。' })} />
          <div className="card">
            <p style={{ marginTop: 0 }}>已選 <b>{sel.length}</b> / {v.n} 席</p>
            {ordered.map((id) => (
              <label key={id} className="f" style={{ marginTop: 6 }}>{label(id)}・姓名職稱
                <input value={names[id] ?? ''} maxLength={60} placeholder="例：王大明 董事長" onChange={(e) => { setNames({ ...names, [id]: e.target.value }); setSure(false); }} /></label>
            ))}
            <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={busy || sel.length !== v.n} onClick={submit}>
              {sure ? '再按一次確認送出' : `送出 ${v.n} 席`}
            </button>
            {sure && <p className="small" style={{ margin: '6px 0 0' }}>送出後座位就保留給貴單位，QR code 立即寄出。之後要換座位需聯絡主辦方。</p>}
          </div>
        </>
      )}
      <p className="small muted" style={{ textAlign: 'center' }}>這是貴單位專屬的劃位連結，請勿轉傳。</p>
    </main>
  );
}
