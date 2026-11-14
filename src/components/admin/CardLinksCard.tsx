'use client';

import { useState } from 'react';
import type { listCardLinks } from '@/lib/cardLink';

type D = NonNullable<Awaited<ReturnType<typeof listCardLinks>>>;
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
const money = (n: number) => `NT$${(n || 0).toLocaleString('en-US')}`;

/** 2M 刷卡專屬連結：不公開，只給特定買方。可買哪些方案、最多幾組、退票規則都可以每條不同 */
export default function CardLinksCard({ d, act, busy, base }: { d: D; act: Act; busy: boolean; base: string }) {
  const blank = { name: '', comboIds: [] as number[], maxSets: '0', policy: 'transfer', transferDays: '3', refundDays: '10', refundFeePct: '10', note: '' };
  const [f, setF] = useState(blank);
  const [copied, setCopied] = useState(0);
  const urlOf = (code: string) => `${base}/c/${code}`;
  const copy = async (id: number, code: string) => { try { await navigator.clipboard.writeText(urlOf(code)); setCopied(id); setTimeout(() => setCopied(0), 1500); } catch { window.prompt('複製這條連結', urlOf(code)); } };
  const create = async () => {
    const r = await act({ action: 'cardlink.create', values: { ...f, maxSets: Number(f.maxSets) || 0, transferDays: Number(f.transferDays) || 0, refundDays: Number(f.refundDays) || 0, refundFeePct: Number(f.refundFeePct) || 0 } }, '已建立專屬連結');
    if (r) setF(blank);
  };
  const name = (id: number) => d.combos.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>2M 刷卡專屬連結 <span className="small muted">（不公開，只給特定買方）</span></h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        買方打開連結 → 選方案與組數 → 同意退票與轉讓規則 → 綠界刷卡 → 付款成功直接進入劃位，選好送出就收到 QR code（不用經過「六」確認）。
        方案要先在「二、價格設定」建好、勾「啟用」（可勾「隱藏方案」不公開）。綠界金鑰在本頁下方設定。
      </p>
      {d.combos.length === 0 && <div className="note warn small">還沒有 2M 的組合方案。</div>}

      <div className="pstack" style={{ maxWidth: 640 }}>
        <label className="f">給誰（後台辨識用）<input value={f.name} placeholder="例：王小明／某某公司" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div><div className="small">可以買的方案</div>
          {d.combos.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={f.comboIds.includes(c.id)} onChange={(e) => setF({ ...f, comboIds: e.target.checked ? [...f.comboIds, c.id] : f.comboIds.filter((x) => x !== c.id) })} />
              <span>{c.name}・{money(c.price)}／組（{c.seats} 席）・目前可賣 {c.left} 組{c.hidden ? '・隱藏' : ''}{c.active ? '' : <b style={{ color: 'var(--err)' }}>・未啟用</b>}</span></label>
          ))}
        </div>
        <label className="f">最多買幾組（0＝不限）<input inputMode="numeric" value={f.maxSets} onChange={(e) => setF({ ...f, maxSets: e.target.value })} /></label>
        <div><div className="small">退票規則</div>
          <label className="check"><input type="radio" checked={f.policy === 'transfer'} onChange={() => setF({ ...f, policy: 'transfer' })} />
            <span>不可退、可轉讓：演出前 <input style={{ width: 52 }} inputMode="numeric" value={f.transferDays} onChange={(e) => setF({ ...f, transferDays: e.target.value })} /> 天以前可改持票人</span></label>
          <label className="check"><input type="radio" checked={f.policy === 'refund'} onChange={() => setF({ ...f, policy: 'refund' })} />
            <span>可退：演出前 <input style={{ width: 52 }} inputMode="numeric" value={f.refundDays} onChange={(e) => setF({ ...f, refundDays: e.target.value })} /> 天以前，手續費 <input style={{ width: 52 }} inputMode="numeric" value={f.refundFeePct} onChange={(e) => setF({ ...f, refundFeePct: e.target.value })} />%（上限 10%）</span></label>
        </div>
        <label className="f">備註<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <div><button className="btn pri" disabled={busy || !f.comboIds.length} onClick={create}>建立專屬連結</button></div>
      </div>

      {d.links.length > 0 && <>
        <h4>已建立的連結（{d.links.length}）</h4>
        <div className="tbl"><table>
          <thead><tr><th>給誰</th><th>方案</th><th>上限</th><th>已付款</th><th>退票規則</th><th>連結</th><th></th></tr></thead>
          <tbody>{d.links.map((l) => (
            <tr key={l.id} style={{ opacity: l.active ? 1 : 0.5 }}>
              <td>{l.name || '—'}{l.note && <div className="small muted">{l.note}</div>}</td>
              <td className="small">{l.comboIds.map(name).join('、')}</td>
              <td>{l.maxSets || '不限'}</td>
              <td>{l.paid} 筆・{l.sets} 組<div className="small muted">{money(l.revenue)}{l.pending ? `・付款中 ${l.pending}` : ''}</div></td>
              <td className="small" style={{ maxWidth: 260 }}>{l.terms}</td>
              <td><button className="btn small" onClick={() => copy(l.id, l.code)}>{copied === l.id ? '已複製' : '複製連結'}</button></td>
              <td><button className="btn small" disabled={busy} onClick={() => act({ action: 'cardlink.update', id: l.id, values: { active: !l.active } }, l.active ? '已停用' : '已啟用')}>{l.active ? '停用' : '啟用'}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </>}
    </div>
  );
}
