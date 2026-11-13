'use client';
/** 後台首頁：全場銷售總覽（2M 本系統即時＋年代 2–5 樓依最後上傳的名單） */
import { useState } from 'react';
import type { SalesOverview } from '@/lib/sales';

type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString());

export function SalesCard({ s, act, admin, busy }: { s: SalesOverview | null; act: Act; admin: boolean; busy: boolean }) {
  const [edit, setEdit] = useState(false);
  const [caps, setCaps] = useState<Record<string, string>>({});
  if (!s) return null;
  const floors = s.era.floors;
  const capTotal = floors.reduce((a, f) => a + (f.cap ?? 0), 0);
  const eraLeft = floors.every((f) => f.cap !== null) && floors.length ? floors.reduce((a, f) => a + (f.left ?? 0), 0) : null;
  const startEdit = () => { setCaps(Object.fromEntries(floors.map((f) => [f.floor, f.cap ? String(f.cap) : '']))); setEdit(true); };
  const save = async () => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(caps)) { const x = Number(v.replace(/[^\d]/g, '')); if (x > 0) out[k] = x; }
    if (await act({ action: 'sales.caps', caps: out }, '已儲存各樓層總席數')) setEdit(false);
  };
  const th = { textAlign: 'right' as const };
  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h3 style={{ marginTop: 0 }}>全場銷售總覽</h3>
      <p className="small muted" style={{ marginTop: 0 }}>2M：本系統即時。年代（2–5 樓）：依年代售出明細，最後上傳 <b>{tw(s.era.at)}</b>；名單沒上傳的不會算進去。</p>

      <div className="tbl" style={{ overflowX: 'auto' }}><table style={{ whiteSpace: 'nowrap' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>區域</th><th style={{ textAlign: 'left' }}>票價</th><th style={th}>已售</th><th style={th}>待確認／暫存</th><th style={th}>已退／保留</th><th style={th}>總席數</th><th style={th}>尚可售</th></tr></thead>
        <tbody>
          <tr><td colSpan={7} className="small" style={{ background: 'var(--surface2, #f4f6fa)', fontWeight: 700 }}>2M（本系統）</td></tr>
          {s.twoM.zones.map((z) => (
            <tr key={z.name + z.price}><td>{z.name}</td><td className="mono">{n(z.price)}</td><td style={th}>{n(z.sold)}</td><td style={th}>{n(z.pending)}</td><td style={th}>{n(z.reserved)}</td><td style={th}>{n(z.total)}</td><td style={{ ...th, fontWeight: 700 }}>{n(z.free)}</td></tr>
          ))}
          <tr style={{ fontWeight: 700 }}><td>2M 小計</td><td /><td style={th}>{n(s.twoM.sold)}</td><td style={th}>{n(s.twoM.pending)}</td><td style={th}>{n(s.twoM.reserved)}</td><td style={th}>{n(s.twoM.total)}</td><td style={th}>{n(s.twoM.free)}</td></tr>

          <tr><td colSpan={7} className="small" style={{ background: 'var(--surface2, #f4f6fa)', fontWeight: 700 }}>年代售出（{s.era.tickets ? `共 ${n(s.era.tickets)} 張明細` : '還沒有逐張明細：請上傳年代「售出明細」'}）</td></tr>
          {floors.map((f) => (
            <FloorRows key={f.floor} f={f} edit={edit} cap={caps[f.floor] ?? ''} setCap={(v) => setCaps({ ...caps, [f.floor]: v })} />
          ))}
          {s.silver.cap > 0 && (
            <tr className="small"><td colSpan={2} style={{ paddingLeft: 18 }}>其中 3 樓銀區（中間）</td><td style={th}>{n(s.silver.sold)}</td><td /><td /><td style={th}>{n(s.silver.cap)}</td><td style={{ ...th, color: 'var(--red)', fontWeight: 700 }}>{n(s.silver.left)}</td></tr>
          )}
          <tr style={{ fontWeight: 700 }}><td>年代小計</td><td /><td style={th}>{n(s.era.sold)}</td><td /><td style={th}>{n(s.era.refunded)}</td><td style={th}>{capTotal ? n(capTotal) : '—'}</td><td style={th}>{n(eraLeft)}</td></tr>

          <tr style={{ fontWeight: 800, borderTop: '2px solid var(--line)' }}><td>全場合計</td><td /><td style={th}>{n(s.twoM.sold + s.era.sold)}</td><td style={th}>{n(s.twoM.pending)}</td><td /><td style={th}>{capTotal ? n(s.twoM.total + capTotal) : '—'}</td><td style={th}>{eraLeft === null ? '—' : n(s.twoM.free + eraLeft)}</td></tr>
        </tbody>
      </table></div>

      {admin && (edit
        ? <div className="row" style={{ gap: 8, marginTop: 8 }}><button className="btn pri small" disabled={busy} onClick={save}>儲存總席數</button><button className="btn small" onClick={() => setEdit(false)}>取消</button></div>
        : <button className="btn small" style={{ marginTop: 8 }} onClick={startEdit}>填各樓層總席數（算尚可售）</button>)}
      {edit && <p className="small muted">填年代各樓層的總席數（同一層各票價合計）。留空＝不算尚可售。</p>}

      {s.daily.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: 'pointer' }}><b>每天售出張數</b>（最近 14 天）</summary>
          <div className="tbl"><table>
            <thead><tr><th style={{ textAlign: 'left' }}>日期</th><th style={th}>2M</th><th style={th}>年代</th><th style={th}>合計</th></tr></thead>
            <tbody>{s.daily.map((d) => <tr key={d.day}><td>{d.day}</td><td style={th}>{n(d.twoM)}</td><td style={th}>{n(d.era)}</td><td style={{ ...th, fontWeight: 700 }}>{n(d.twoM + d.era)}</td></tr>)}</tbody>
          </table></div>
        </details>
      )}
    </div>
  );
}

function FloorRows({ f, edit, cap, setCap }: { f: SalesOverview['era']['floors'][number]; edit: boolean; cap: string; setCap: (v: string) => void }) {
  const th = { textAlign: 'right' as const };
  const one = f.prices.length <= 1;
  const capCell = edit
    ? <input inputMode="numeric" value={cap} placeholder="總席數" style={{ width: 80, textAlign: 'right' }} onChange={(e) => setCap(e.target.value)} />
    : n(f.cap);
  if (one) {
    const p = f.prices[0];
    return <tr><td>{f.floor}</td><td className="mono">{p ? n(p.price) : '—'}</td><td style={th}>{n(f.sold)}</td><td /><td style={th}>{f.refunded ? n(f.refunded) : ''}</td><td style={th}>{capCell}</td><td style={{ ...th, fontWeight: 700 }}>{n(f.left)}</td></tr>;
  }
  return (
    <>
      {f.prices.map((p, i) => (
        <tr key={p.price}><td>{i === 0 ? f.floor : ''}</td><td className="mono">{n(p.price)}</td><td style={th}>{n(p.sold)}</td><td /><td style={th}>{p.refunded ? n(p.refunded) : ''}</td><td /><td /></tr>
      ))}
      <tr style={{ fontStyle: 'italic' }}><td className="small" style={{ paddingLeft: 18 }}>{f.floor} 小計</td><td /><td style={th}>{n(f.sold)}</td><td /><td style={th}>{f.refunded ? n(f.refunded) : ''}</td><td style={th}>{capCell}</td><td style={{ ...th, fontWeight: 700 }}>{n(f.left)}</td></tr>
    </>
  );
}
