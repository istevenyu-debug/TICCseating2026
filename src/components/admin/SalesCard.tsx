'use client';
/** 後台首頁：全場銷售總覽（2M 本系統即時＋年代 2–5 樓依最後上傳的名單） */
import { Fragment, useRef, useState } from 'react';
import type { SalesOverview } from '@/lib/sales';
import { countSeatmap } from '@/lib/seatmapCount';

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
      <p className="small muted" style={{ marginTop: 0, maxWidth: 520 }}>總席數依 TICC 大會堂座位示意圖。2M、3F 兩側：本系統即時；{s.seatmaps[0]
        ? <>4F／5F：年代座位圖 <b>{tw(s.seatmaps[0].statAt)}</b></>
        : <>年代：依最後上傳的售出明細 <b>{tw(s.era.at)}</b></>}。</p>
      <div className="tbl" style={{ overflowX: 'auto' }}><table style={{ width: 'auto' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>區域</th><th style={r}>總席數</th><th style={r}>已售</th><th style={r}>尚可售</th></tr></thead>
        <tbody>
          {s.hall.map((h) => (<Fragment key={h.key}>
            <tr>
              <td style={{ whiteSpace: 'nowrap' }}>{h.label}
                <div className="small muted" style={{ whiteSpace: 'normal', maxWidth: 230 }}>
                  {(h.note.startsWith('座位圖') // 座位圖的統計時間放最後，其餘照原本順序
                    ? [h.by, h.prices.map((p) => `${n(p.price)}×${n(p.n)}`).join('・'), h.refunded ? `退 ${n(h.refunded)}` : '', h.note]
                    : [h.by, h.note, h.prices.map((p) => `${n(p.price)}×${n(p.n)}`).join('・'), h.refunded ? `退 ${n(h.refunded)}` : '']).filter(Boolean).join('｜')}</div>
              </td>
              <td style={r}>{edit && caps[h.key] !== undefined
                ? <input inputMode="numeric" value={caps[h.key]} style={{ width: 70, textAlign: 'right' }} onChange={(e) => setCaps({ ...caps, [h.key]: e.target.value })} />
                : n(h.total)}</td>
              <td style={r}>{n(h.sold)}</td>
              <td style={{ ...r, fontWeight: 700, whiteSpace: 'nowrap', color: h.left === 0 ? 'var(--red)' : undefined }}>{h.left === 0 ? '售完' : <>{n(h.left)}{pct(h.left, h.total)}</>}</td>
            </tr>
            {h.key === '2M' && s.twoM.plans.map((p) => (
              <tr key={`p${p.id}`} className="small">
                <td style={{ paddingLeft: 14 }}>{p.name}<span className="muted">（{p.size} 席一組）</span>
                  {admin && edit && <button className="btn small" style={{ marginLeft: 6, padding: '0 6px' }} disabled={busy} onClick={() => act({ action: 'sales.hidePlan', id: p.id, hidden: true }, `「${p.name}」不列入銷售總覽`)}>不列入</button>}
                  <div className="muted" style={{ whiteSpace: 'normal', maxWidth: 230 }}>{[p.pending ? `待確認 ${p.pending}` : '', p.owed ? `已付未劃 ${p.owed}` : '', p.vip ? `招待佔 ${p.vip}` : ''].filter(Boolean).join('・') || '　'}</div></td>
                <td style={r}>{n(p.sold + p.pending + p.owed + p.vip + p.left)} 組</td>
                <td style={r}>{n(p.sold)} 組</td>
                <td style={{ ...r, fontWeight: 700, whiteSpace: 'nowrap', color: p.left === 0 ? 'var(--red)' : undefined }}>{p.left === 0 ? '售完' : <>{n(p.left)} 組{pct(p.left, p.sold + p.pending + p.owed + p.vip + p.left)}</>}</td>
              </tr>
            ))}
          </Fragment>))}
          <tr style={{ fontWeight: 800, borderTop: '2px solid var(--line)' }}><td>全場</td><td style={r}>{n(s.hallSum.total)}</td><td style={r}>{n(s.hallSum.sold)}</td><td style={{ ...r, whiteSpace: 'nowrap' }}>{n(s.hallSum.left)}{pct(s.hallSum.left, s.hallSum.total)}</td></tr>
        </tbody>
      </table></div>

      {admin && <SeatmapUpload s={s} act={act} busy={busy} />}

      {admin && (edit
        ? <div className="row" style={{ gap: 8, marginTop: 8 }}><button className="btn pri small" disabled={busy} onClick={save}>儲存總席數</button><button className="btn small" onClick={() => setEdit(false)}>取消</button></div>
        : <button className="btn small" style={{ marginTop: 8 }} onClick={startEdit}>改總席數／不列入的方案</button>)}
      {edit && s.hiddenPlans.length > 0 && <p className="small">不列入的方案：{s.hiddenPlans.map((p) => <button key={p.id} className="btn small" style={{ marginLeft: 6 }} disabled={busy} onClick={() => act({ action: 'sales.hidePlan', id: p.id, hidden: false }, `「${p.name}」恢復列入`)}>{p.name} ↺ 恢復</button>)}</p>}
      {edit && <p className="small muted">方案列旁的「不列入」只是不顯示在這張表，不影響訂單、座位、發票。</p>}
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

/** 尚可售佔總數的百分比（小字） */
function pct(left: number | null, total: number | null) {
  if (left == null || !total) return null;
  // 放在數字下面一行，表格才不會變寬（手機放得下）
  return <div className="muted" style={{ fontWeight: 400, fontSize: '0.8em', lineHeight: 1.2 }}>{Math.round((left / total) * 100)}%</div>;
}

/** 上傳年代座位圖截圖 → 手機上算 4F／5F 已售 → 確認後存（總席數對得上才收） */
function SeatmapUpload({ s, act, busy }: { s: SalesOverview; act: Act; busy: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [res, setRes] = useState<{ floors: { key: string; total: number; sold: number }[]; thumb: string; statAt: string } | null>(null);
  const [err, setErr] = useState('');
  const [working, setWorking] = useState(false);
  const [sureUndo, setSureUndo] = useState(false);
  const caps = [{ key: '4F', total: s.caps['4F'] ?? 748 }, { key: '5F', total: s.caps['5F'] ?? 686 }];
  const local = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 16); // 台北時間給 datetime-local
  async function pick(f: File | undefined) {
    if (!f) return;
    setErr(''); setRes(null); setWorking(true);
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 2400 / bmp.width);
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const r = countSeatmap(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, caps);
      if (!r.ok) { setErr(r.message); return; }
      const t = document.createElement('canvas');
      const tk = Math.min(1, 480 / c.width);
      t.width = Math.round(c.width * tk); t.height = Math.round(c.height * tk);
      t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
      // 統計時間預設＝截圖檔案的時間（3 天內），不然用現在
      const when = Date.now() - f.lastModified < 3 * 86400_000 && f.lastModified <= Date.now() ? new Date(f.lastModified) : new Date();
      setRes({ floors: r.floors, thumb: t.toDataURL('image/jpeg', 0.6), statAt: local(when) });
    } catch { setErr('讀不到這張圖，請換一張截圖（PNG 或 JPG）。'); } finally { setWorking(false); if (file.current) file.current.value = ''; }
  }
  async function save() {
    if (!res) return;
    const statAt = new Date(`${res.statAt}:00+08:00`).toISOString();
    if (await act({ action: 'sales.seatmap', statAt, floors: res.floors, thumb: res.thumb }, '已更新 4F／5F 銷售數字')) setRes(null);
  }
  const last = s.seatmaps[0];
  const tw2 = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <div style={{ marginTop: 10, maxWidth: 520 }}>
      <input ref={file} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
      <button className="btn small pri" disabled={busy || working} onClick={() => file.current?.click()}>{working ? '計算中…' : '上傳年代座位圖（4F／5F）'}</button>
      <span className="small muted" style={{ marginLeft: 6 }}>綠色＝已售；要含 4F、5F 每一排</span>
      {err && <div className="note err" style={{ marginTop: 6 }}>{err}</div>}
      {res && (
        <div className="note" style={{ marginTop: 6 }}>
          <img src={res.thumb} alt="座位圖縮圖" style={{ maxWidth: '100%', display: 'block', marginBottom: 6 }} />
          {res.floors.map((f) => <div key={f.key}><b>{f.key}</b> 已售 <b>{f.sold.toLocaleString()}</b>／{f.total.toLocaleString()}（尚可售 {(f.total - f.sold).toLocaleString()}）</div>)}
          <label className="f" style={{ marginTop: 6 }}>統計時間<input type="datetime-local" value={res.statAt} onChange={(e) => setRes({ ...res, statAt: e.target.value })} /></label>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="btn pri small" disabled={busy || !res.statAt} onClick={save}>確認，更新銷售數字</button>
            <button className="btn small" onClick={() => setRes(null)}>取消</button>
          </div>
        </div>
      )}
      {last && (
        <details style={{ marginTop: 6 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>座位圖紀錄：最近 {tw2(last.statAt)}（{last.floors.map((f) => `${f.key} ${f.sold}`).join('、')}）</summary>
          {last.thumb && <img src={last.thumb} alt="最近一次座位圖" style={{ maxWidth: '100%', display: 'block', margin: '6px 0' }} />}
          <div className="tbl"><table style={{ width: 'auto' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>統計時間</th>{last.floors.map((f) => <th key={f.key} style={{ textAlign: 'right', paddingLeft: 10 }}>{f.key} 已售</th>)}<th style={{ textAlign: 'left', paddingLeft: 10 }}>上傳</th></tr></thead>
            <tbody>{s.seatmaps.map((m) => <tr key={m.at}><td>{tw2(m.statAt)}</td>{m.floors.map((f) => <td key={f.key} style={{ textAlign: 'right', paddingLeft: 10 }}>{f.sold.toLocaleString()}</td>)}<td className="small muted" style={{ paddingLeft: 10 }}>{m.by}・{tw2(m.at)}</td></tr>)}</tbody>
          </table></div>
          <button className="btn small" style={{ marginTop: 6 }} disabled={busy} onClick={async () => {
            if (!sureUndo) { setSureUndo(true); setTimeout(() => setSureUndo(false), 4000); return; }
            setSureUndo(false); await act({ action: 'sales.seatmapUndo' }, '已刪掉最近一次座位圖');
          }}>{sureUndo ? '再按一次確認刪除' : '刪掉最近一次（上傳錯圖時）'}</button>
        </details>
      )}
    </div>
  );
}
