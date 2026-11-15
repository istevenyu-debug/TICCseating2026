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
  const editable = s.hall.filter((h) => h.by === '年代' && h.key !== '3F');
  const startEdit = () => { setCaps(Object.fromEntries(editable.map((h) => [h.key, h.total ? String(h.total) : '']))); setEdit(true); };
  const save = async () => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(caps)) { const x = Number(v.replace(/[^\d]/g, '')); if (x > 0) out[k] = x; }
    if (await act({ action: 'sales.caps', caps: out }, '已儲存總席數')) setEdit(false);
  };
  const r = { textAlign: 'right' as const, paddingLeft: 10 };
  return (
    <div className="card sales" style={{ gridColumn: '1 / -1', justifySelf: 'start', maxWidth: '100%', width: 'fit-content' }}>
      <h3 style={{ marginTop: 0 }}>全場銷售總覽</h3>
      <p className="small muted" style={{ marginTop: 0, maxWidth: 520 }}>總席數依 TICC 大會堂座位示意圖。2M、3F 兩側：本系統即時；年代：依最後上傳的售出明細 <b>{tw(s.era.at)}</b>。</p>
      <div className="tbl" style={{ overflowX: 'auto' }}><table style={{ width: 'auto' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>區域</th><th style={r}>總席數</th><th style={r}>已售</th><th style={r}>尚可售</th></tr></thead>
        <tbody>
          {s.hall.map((h) => (
            <tr key={h.key}>
              <td style={{ whiteSpace: 'nowrap' }}>{h.label}
                <div className="small muted" style={{ whiteSpace: 'normal', maxWidth: 230 }}>
                  {[h.by, h.note, h.prices.map((p) => `${n(p.price)}×${n(p.n)}`).join('・'), h.refunded ? `退 ${n(h.refunded)}` : ''].filter(Boolean).join('｜')}</div>
              </td>
              <td style={r}>{edit && caps[h.key] !== undefined
                ? <input inputMode="numeric" value={caps[h.key]} style={{ width: 70, textAlign: 'right' }} onChange={(e) => setCaps({ ...caps, [h.key]: e.target.value })} />
                : n(h.total)}</td>
              <td style={r}>{n(h.sold)}</td>
              <td style={{ ...r, fontWeight: 700, whiteSpace: 'nowrap', color: h.left === 0 ? 'var(--red)' : undefined }}>{h.left === 0 ? '售完' : n(h.left)}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 800, borderTop: '2px solid var(--line)' }}><td>全場</td><td style={r}>{n(s.hallSum.total)}</td><td style={r}>{n(s.hallSum.sold)}</td><td style={r}>{n(s.hallSum.left)}</td></tr>
        </tbody>
      </table></div>

      {admin && (edit
        ? <div className="row" style={{ gap: 8, marginTop: 8 }}><button className="btn pri small" disabled={busy} onClick={save}>儲存總席數</button><button className="btn small" onClick={() => setEdit(false)}>取消</button></div>
        : <button className="btn small" style={{ marginTop: 8 }} onClick={startEdit}>改年代各區總席數</button>)}
      {edit && <p className="small muted">預設依 TICC 座位圖（4F 748、5F 686）。年代實際開賣的席數不同時再改；清空＝用預設。</p>}

      {s.daily.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: 'pointer' }}><b>每天售出張數</b>（最近 14 天）</summary>
          <div className="tbl"><table style={{ width: 'auto' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>日期</th><th style={r}>2M</th><th style={r}>年代</th><th style={r}>合計</th></tr></thead>
            <tbody>{s.daily.map((d) => <tr key={d.day}><td>{d.day}</td><td style={r}>{n(d.twoM)}</td><td style={r}>{n(d.era)}</td><td style={{ ...r, fontWeight: 700 }}>{n(d.twoM + d.era)}</td></tr>)}</tbody>
          </table></div>
        </details>
      )}
    </div>
  );
}
