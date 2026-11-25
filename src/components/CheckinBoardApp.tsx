'use client';

import { useCallback, useEffect, useState } from 'react';

type Box = { name: string; total: number; done: number; lines: { label: string; total: number; done: number }[] };
type Data = { event: string; at: string; eraAt: string | null; boxes: Box[]; total: number; done: number; gates: { name: string; n: number }[] };

const hms = (iso: string) => new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const md = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** 驗票即時看板：每 5 秒更新，一個手機畫面看完 */
export default function CheckinBoardApp({ token }: { token: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await (await fetch(`/api/checkin/${encodeURIComponent(token)}`, { cache: 'no-store' })).json();
      if (r.ok) { setD(r.data); setErr(''); } else setErr(r.message);
    } catch { setErr('網路連線異常，稍後自動重試'); }
  }, [token]);
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, [load]);

  const page: React.CSSProperties = { minHeight: '100dvh', background: '#f4f5f8', color: '#18213a', padding: '12px 12px 24px', fontFamily: 'system-ui, -apple-system, "Noto Sans TC", sans-serif', maxWidth: 560, margin: '0 auto' };
  if (!d) return <main style={page}><p>{err || '載入中…'}</p></main>;
  const pct = (a: number, b: number) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
  return (
    <main style={page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <b style={{ fontSize: 18 }}>驗票即時看板</b>
        <span style={{ fontSize: 12, color: err ? '#b42318' : '#667085' }}>{err ? '連線中斷・' : ''}更新 {hms(d.at)}</span>
      </div>
      <div style={{ fontSize: 12, color: '#667085', marginBottom: 10 }}>{d.event}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {d.boxes.map((b) => (
          <div key={b.name} style={{ background: '#fff', borderRadius: 12, padding: '10px 12px', boxShadow: '0 1px 2px rgba(16,24,40,.08)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{b.name}</div>
            <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
              {b.done}<span style={{ fontSize: 16, color: '#667085', fontWeight: 500 }}> / {b.total}</span>
            </div>
            <div style={{ height: 6, background: '#eaecf0', borderRadius: 3, marginTop: 4 }}>
              <div style={{ height: 6, width: `${pct(b.done, b.total)}%`, background: b.total && b.done >= b.total ? '#12b76a' : '#2e6fd8', borderRadius: 3 }} />
            </div>
            {b.lines.map((l) => (
              <div key={l.label} style={{ fontSize: 12, color: '#475467', marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{l.done}/{l.total}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ background: '#18213a', color: '#fff', borderRadius: 12, padding: '12px 14px', marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <b>總計</b>
        <span style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d.done}<span style={{ fontSize: 16, opacity: 0.7, fontWeight: 500 }}> / {d.total}</span></span>
      </div>
      {d.gates.length > 0 && (
        <div style={{ fontSize: 12, color: '#475467', marginTop: 10, lineHeight: 1.7 }}>
          各門：{d.gates.map((g) => `${g.name} ${g.n}`).join('・')}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#98a2b3', marginTop: 8, lineHeight: 1.6 }}>
        已驗／應驗。年代的應驗＝年代售出明細 3–5 樓已售張數{d.eraAt ? `（名單更新 ${md(d.eraAt)}）` : '（尚未上傳名單）'}；年代票不分樓層，掃到就算。每 5 秒自動更新。
      </div>
    </main>
  );
}
