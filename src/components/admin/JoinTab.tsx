'use client';

import { useState } from 'react';
import type { joinAdminState } from '@/lib/join';

type J = Awaited<ReturnType<typeof joinAdminState>>;
type Reg = J['regs'][number];
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
interface Props {
  j: J; act: Act; busy: boolean; base: string; sure: string | null; confirm2: (key: string, fn: () => void) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
}
type EditLeader = { id?: number; name: string; phone: string; email: string; noEmail: boolean };
type Edit = { headName: string; headPhone: string; note: string; leaders: EditLeader[] };

const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const ph = (s: string) => s.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');
const STATUS: Record<string, string> = { pending: '待審核', approved: '已核准', rejected: '已退回' };
const COLOR: Record<string, string> = { pending: 'var(--warn)', approved: 'var(--ok)', rejected: 'var(--muted)' };

/** 後台「十二、揪團贈票」第一階段：登記開關、團練場清單、審核揪團登記 */
export default function JoinTab({ j, act, busy, base, sure, confirm2, setMsg }: Props) {
  const [view, setView] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [bulk, setBulk] = useState('');
  const [contact, setContact] = useState(j.settings.contact);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [edit, setEdit] = useState<{ id: number; v: Edit } | null>(null);
  const [q, setQ] = useState('');
  const link = `${base}/join`;
  const n = (s: string) => j.regs.filter((r) => r.status === s).length;
  const approvedLeaders = j.regs.filter((r) => r.status === 'approved').reduce((k, r) => k + r.leaders.length, 0);
  const shown = j.regs.filter((r) => r.status === view).filter((r) => !q.trim() || JSON.stringify([r.venueName, r.venueText, r.headName, r.headPhone, r.leaders]).includes(q.trim()));

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMsg({ kind: 'ok', text: '已複製' }); } catch { window.prompt('請長按複製', text); }
  };
  const reject = (r: Reg) => {
    const why = window.prompt(`退回第 ${r.id} 號（${r.headName}）的原因（必填，只留在後台，不會寄給對方）`, '');
    if (why === null) return;
    if (why.trim().length < 2) { setMsg({ kind: 'err', text: '請填寫退回原因' }); return; }
    act({ action: 'join.reg.decide', id: r.id, status: 'rejected', reason: why }, '已退回');
  };
  const startEdit = (r: Reg) => setEdit({ id: r.id, v: { headName: r.headName, headPhone: r.headPhone, note: r.note, leaders: r.leaders.map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, noEmail: l.noEmail })) } });
  const setEL = (i: number, v: Partial<EditLeader>) => edit && setEdit({ ...edit, v: { ...edit.v, leaders: edit.v.leaders.map((l, k) => (k === i ? { ...l, ...v } : l)) } });
  const saveEdit = async () => {
    if (!edit) return;
    const r = await act({ action: 'join.reg.edit', id: edit.id, values: edit.v }, '已儲存');
    if (r) setEdit(null);
  };

  return (
    <div>
      <div className="card">
        <h2>十二、揪團贈票（第一階段：揪團登記）</h2>
        <p className="small muted" style={{ marginTop: 0 }}>銀區（三樓）買十送一。這一階段只收登記與審核，<b>不寄任何信</b>；揪團人連結、團練場回報連結在第二階段上線後才會寄出。</p>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <div className="stat"><b>{j.venues.length}</b><span>團練場</span></div>
          <div className="stat"><b style={{ color: 'var(--warn)' }}>{n('pending')}</b><span>待審核</span></div>
          <div className="stat"><b style={{ color: 'var(--ok)' }}>{n('approved')}</b><span>已核准登記</span></div>
          <div className="stat"><b>{approvedLeaders}</b><span>已核准揪團人</span></div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>登記連結</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{link}</span>
          <button className="btn small" onClick={() => copy(link)}>複製</button>
          <a className="btn small" href="/join" target="_blank" rel="noreferrer">開啟</a>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={j.settings.open} disabled={busy}
            onChange={(e) => act({ action: 'join.settings', values: { open: e.target.checked } }, e.target.checked ? '已開放登記' : '已關閉登記')} />
          <span><b>開放登記</b>{j.settings.open ? <span style={{ color: 'var(--ok)' }}>（開放中）</span> : <span className="muted">（關閉中：登記頁只顯示「尚未開放」）</span>}</span>
        </label>
        <label className="f" style={{ marginTop: 10, maxWidth: 420 }}>送出後顯示「資料有誤請聯絡＿＿」
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={contact} maxLength={60} placeholder="例：群票服務 LINE 群" onChange={(e) => setContact(e.target.value)} />
            <button className="btn small" style={{ whiteSpace: 'nowrap' }} disabled={busy || contact === j.settings.contact} onClick={() => act({ action: 'join.settings', values: { contact } }, '已儲存')}>儲存</button>
          </div>
        </label>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>登記審核</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(['pending', 'approved', 'rejected'] as const).map((s) => (
            <button key={s} className={`btn small${view === s ? ' pri' : ''}`} onClick={() => setView(s)}>{STATUS[s]}（{n(s)}）</button>
          ))}
          <input style={{ maxWidth: 200 }} placeholder="搜尋姓名、手機、團練場" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!shown.length && <p className="muted small">沒有{STATUS[view]}的登記。</p>}
        {shown.map((r) => (
          <div key={r.id} className="note" style={{ marginTop: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <b>#{r.id}　{r.venueName || <span style={{ color: 'var(--warn)' }}>其他：{r.venueText}</span>}</b>
              <span className="small"><span style={{ color: COLOR[r.status] }}>{STATUS[r.status]}</span>・送出 {tw(r.createdAt)}{r.decidedAt && `・${r.decidedBy} ${tw(r.decidedAt)}`}</span>
            </div>
            {!r.venueId && r.status !== 'rejected' && (
              <div className="row small" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <span>指定團練場：</span>
                <select style={{ width: 'auto' }} value={pick[r.id] ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                  <option value="">選清單上的…</option>
                  {j.venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <button className="btn small" disabled={busy || !pick[r.id]} onClick={() => act({ action: 'join.reg.venue', id: r.id, venueId: Number(pick[r.id]) }, '已指定')}>指定</button>
                <button className="btn small" disabled={busy} onClick={() => {
                  const nm = window.prompt('新增成清單上的團練場（可修改名稱，例：台北木柵）', r.venueText);
                  if (nm?.trim()) act({ action: 'join.reg.venue', id: r.id, newName: nm }, '已新增並指定');
                }}>新增「{r.venueText}」到清單</button>
              </div>
            )}

            {edit?.id === r.id ? (
              <div style={{ marginTop: 8 }}>
                <div className="fields">
                  <label className="f">負責人姓名<input value={edit.v.headName} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, headName: e.target.value } })} /></label>
                  <label className="f">負責人手機<input value={edit.v.headPhone} inputMode="tel" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, headPhone: e.target.value } })} /></label>
                </div>
                {edit.v.leaders.map((l, i) => (
                  <div key={i} className="fields" style={{ marginTop: 8, gridTemplateColumns: '1fr 1fr 1.5fr auto', alignItems: 'end' }}>
                    <label className="f">揪團人 {i + 1}<input value={l.name} onChange={(e) => setEL(i, { name: e.target.value })} /></label>
                    <label className="f">手機<input value={l.phone} inputMode="tel" onChange={(e) => setEL(i, { phone: e.target.value })} /></label>
                    <label className="f">Email
                      <input value={l.email} disabled={l.noEmail} onChange={(e) => setEL(i, { email: e.target.value })} />
                      <span className="check small"><input type="checkbox" checked={l.noEmail} onChange={(e) => setEL(i, { noEmail: e.target.checked })} />沒有 Email</span>
                    </label>
                    <button className="btn small" disabled={edit.v.leaders.length < 2} onClick={() => setEdit({ ...edit, v: { ...edit.v, leaders: edit.v.leaders.filter((_, k) => k !== i) } })}>移除</button>
                  </div>
                ))}
                <button className="btn small" style={{ marginTop: 8 }} onClick={() => setEdit({ ...edit, v: { ...edit.v, leaders: [...edit.v.leaders, { name: '', phone: '', email: '', noEmail: false }] } })}>＋ 新增揪團人</button>
                <label className="f" style={{ marginTop: 8 }}>後台備註（買方看不到）<input value={edit.v.note} maxLength={200} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, note: e.target.value } })} /></label>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn pri small" disabled={busy} onClick={saveEdit}>儲存</button>
                  <button className="btn small" onClick={() => setEdit(null)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="small" style={{ marginTop: 6 }}>負責人：<b>{r.headName}</b>　<a href={`tel:${r.headPhone}`} className="mono">{ph(r.headPhone)}</a></div>
                {r.leaders.map((l, i) => (
                  <div key={l.id} className="small">揪團人{r.leaders.length > 1 ? ` ${i + 1}` : ''}：<b>{l.name}</b>{l.sameAsHead && <span className="muted">（同負責人）</span>}{'　'}
                    <a href={`tel:${l.phone}`} className="mono">{ph(l.phone)}</a>　{l.noEmail ? <span style={{ color: 'var(--warn)' }}>沒有 Email（用 LINE 傳）</span> : <span className="mono">{l.email}</span>}</div>
                ))}
                {r.note && <div className="small muted">備註：{r.note}</div>}
                {r.status === 'rejected' && r.reason && <div className="small muted">退回原因：{r.reason}</div>}
                <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {r.status === 'pending' && <button className="btn pri small" disabled={busy || !r.venueId} title={r.venueId ? '' : '先指定團練場'}
                    onClick={() => act({ action: 'join.reg.decide', id: r.id, status: 'approved' }, '已核准')}>核准</button>}
                  {r.status === 'pending' && <button className="btn small" disabled={busy} onClick={() => reject(r)}>退回</button>}
                  {r.status !== 'pending' && <button className="btn small" disabled={busy} onClick={() => act({ action: 'join.reg.decide', id: r.id, status: 'pending' }, '已改回待審核')}>改回待審核</button>}
                  <button className="btn small" disabled={busy} onClick={() => startEdit(r)}>修改</button>
                  {r.status === 'rejected' && <button className="btn small" disabled={busy}
                    onClick={() => confirm2(`join-del-${r.id}`, () => act({ action: 'join.reg.delete', id: r.id }, '已刪除'))}>
                    {sure === `join-del-${r.id}` ? '再按一次刪除' : '刪除'}</button>}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>團練場清單（登記表從這裡選）</h3>
        <label className="f">新增團練場（一行一個，已有的會略過）
          <textarea rows={3} value={bulk} placeholder={'台北微風小棧\n台北木柵'} onChange={(e) => setBulk(e.target.value)}
            style={{ font: 'inherit', padding: 8, border: '1px solid var(--line)', borderRadius: 6 }} />
        </label>
        <button className="btn pri small" style={{ marginTop: 6 }} disabled={busy || !bulk.trim()} onClick={async () => {
          const r = await act({ action: 'join.venue.add', names: bulk.split('\n') }) as { added: number; skipped: number } | undefined;
          if (r) { setBulk(''); setMsg({ kind: 'ok', text: `新增 ${r.added} 個${r.skipped ? `，${r.skipped} 個已存在略過` : ''}` }); }
        }}>新增</button>
        {!j.venues.length && <p className="small muted">還沒有團練場。</p>}
        <div className="tbl" style={{ marginTop: 10 }}><table>
          {j.venues.length > 0 && <thead><tr><th style={{ textAlign: 'left' }}>團練場</th><th>登記</th><th>核准</th><th>揪團人</th><th>登記表顯示</th><th /></tr></thead>}
          <tbody>
            {j.venues.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td style={{ textAlign: 'center' }}>{v.regs}</td>
                <td style={{ textAlign: 'center' }}>{v.approved}</td>
                <td style={{ textAlign: 'center' }}>{v.leaders}</td>
                <td style={{ textAlign: 'center' }}><input type="checkbox" checked={v.active} disabled={busy}
                  onChange={(e) => act({ action: 'join.venue.update', id: v.id, values: { active: e.target.checked } })} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" disabled={busy} onClick={() => {
                    const nm = window.prompt('改名', v.name);
                    if (nm?.trim() && nm.trim() !== v.name) act({ action: 'join.venue.update', id: v.id, values: { name: nm } }, '已改名');
                  }}>改名</button>
                  <select style={{ width: 'auto', marginLeft: 4 }} value="" disabled={busy || j.venues.length < 2} onChange={(e) => {
                    const into = Number(e.target.value);
                    const to = j.venues.find((x) => x.id === into);
                    if (to && window.confirm(`把「${v.name}」的 ${v.regs} 份登記併入「${to.name}」，並刪除「${v.name}」？`)) act({ action: 'join.venue.merge', id: v.id, into }, '已合併');
                  }}>
                    <option value="">合併到…</option>
                    {j.venues.filter((x) => x.id !== v.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  {v.regs === 0 && <button className="btn small" style={{ marginLeft: 4 }} disabled={busy}
                    onClick={() => confirm2(`jv-del-${v.id}`, () => act({ action: 'join.venue.delete', id: v.id }, '已刪除'))}>
                    {sure === `jv-del-${v.id}` ? '再按一次' : '刪除'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}
