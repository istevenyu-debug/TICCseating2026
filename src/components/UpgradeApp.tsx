'use client';

import { useEffect, useState } from 'react';
import SeatMap from './SeatMap';

type View = {
  event: string; showAt: string; vipInstalled: boolean; status: 'open' | 'done' | 'cancelled'; buyerName: string; orderNo: string;
  n: number; old: string[]; moves: { fromLabel: string; toLabel: string }[]; allowedNames: string[];
  zones: { id: number; name: string; color: string; gift: boolean }[];
  seats: { id: string; x: number; y: number; no: string; type: string; code: string; label: string; zoneId: number; bundle: string | null; status: string }[];
};
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string; detail?: unknown };
type MapProps = Parameters<typeof SeatMap>[0];

async function call<T>(token: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(`/api/up/${encodeURIComponent(token)}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 免費升等：買方自己選新座位，按確認立即換好（持票人、QR 不變） */
export default function UpgradeApp({ token }: { token: string }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const load = async () => { const r = await call<View>(token); if (r.ok) setV(r.data); else setErr(r.message); };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <main className="wrap"><div className="card"><p className="err-text">{err}</p></div></main>;
  if (!v) return <main className="wrap"><p className="muted">載入中…</p></main>;
  const toggle = (id: string) => {
    const s = v.seats.find((x) => x.id === id); if (!s || s.status !== 'free') return;
    const n = new Set(sel);
    if (n.has(id)) n.delete(id); else if (n.size < v.n) n.add(id); else { setMsg({ kind: 'err', text: `最多選 ${v.n} 席，請先取消一席再選。` }); return; }
    setSel(n); setSure(false); setMsg(null);
  };
  const go = async () => {
    if (!sure) { setSure(true); return; }
    setBusy(true);
    const r = await call<{ moves: View['moves'] }>(token, { seatIds: [...sel] });
    setBusy(false); setSure(false);
    if (r.ok) { setMsg({ kind: 'ok', text: '已換好！' }); setSel(new Set()); await load(); }
    else { setMsg({ kind: 'err', text: r.message }); setSel(new Set()); await load(); }
  };
  const when = new Date(v.showAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <main className="wrap">
      <div className="card">
        <h1 style={{ fontSize: '1.2rem', margin: '0 0 6px' }}>{v.event}・免費升等</h1>
        <p className="small muted" style={{ margin: 0 }}>{when}・訂單 {v.orderNo}・{v.buyerName}</p>
      </div>
      {v.status === 'done' && <div className="card">
        <h2 style={{ marginTop: 0 }}>✅ 已換好</h2>
        {v.moves.map((m, i) => <p key={i} style={{ margin: '4px 0' }}>{m.fromLabel} → <b>{m.toLabel}</b></p>)}
        <p className="small muted">持票人和 QR code 都不變，原本收到的 QR code 入場時會對到新座位。劃位頁也會顯示新座位。</p>
      </div>}
      {v.status === 'cancelled' && <div className="card"><p className="err-text">這條升等連結已取消，請向主辦方確認。</p></div>}
      {v.status === 'open' && <>
        <div className="card">
          <p style={{ margin: 0 }}>因現場攝影需要，您以下 <b>{v.n}</b> 席可以<b>免費</b>換到 <b>{v.allowedNames.join('、')}</b>：</p>
          <p style={{ margin: '4px 0' }}><b>{v.old.join('、')}</b></p>
          <p className="small muted" style={{ margin: 0 }}>請在座位圖點選 {v.n} 個有顏色的空位（灰色不能選），按確認後立即生效。持票人和 QR code 都不變。圖上紫底的 {v.n} 席是您原本的座位。</p>
        </div>
        <SeatMap seats={v.seats as unknown as MapProps['seats']} zones={v.zones as unknown as MapProps['zones']} vipInstalled={v.vipInstalled} floor="2M"
          selected={sel} onToggle={toggle} locked={busy} onBlocked={() => setMsg({ kind: 'err', text: '只能選有顏色的空位。' })} />
        <div className="card">
          <p style={{ marginTop: 0 }}>已選 <b>{sel.size}</b> / {v.n} 席：{v.seats.filter((x) => sel.has(x.id)).map((x) => x.label).join('、') || '—'}</p>
          {msg && <div className={`note${msg.kind === 'err' ? ' err' : ''}`} style={{ marginBottom: 8 }}>{msg.text}</div>}
          <button className="btn pri" style={{ width: '100%' }} disabled={busy || sel.size !== v.n} onClick={go}>
            {sure ? '再按一次確認換座位' : `確認換到這 ${v.n} 席`}
          </button>
          {sure && <p className="small" style={{ margin: '6px 0 0' }}>換好後原座位會釋出，不能再換回來。</p>}
        </div>
      </>}
      <p className="small muted" style={{ textAlign: 'center' }}>這是您專屬的升等連結，請勿轉傳。</p>
    </main>
  );
}
