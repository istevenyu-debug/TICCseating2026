'use client';

import { Fragment, useMemo, useState } from 'react';
import type { joinAdminState } from '@/lib/joinQueue';
import AdminMap, { type SeatLook } from './AdminMap';
import { eraRows, guessCols, parsePrices, type EraCols, type EraRow } from '@/lib/eraParse';

type J = Awaited<ReturnType<typeof joinAdminState>>;
type Reg = J['regs'][number];
type Slot = J['slots'][number];
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
interface Props {
  j: J; act: Act; busy: boolean; base: string; sure: string | null; confirm2: (key: string, fn: () => void) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
}
type Sec = 'set' | 'reg' | 'venue' | 'era' | 'report' | 'seats' | 'queue' | 'list';

const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const ph = (s: string) => s.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3');
const STATUS: Record<string, string> = { pending: '待審核', approved: '已核准', rejected: '已退回' };
const COLOR: Record<string, string> = { pending: 'var(--warn)', approved: 'var(--ok)', rejected: 'var(--muted)' };
const SLOT: Record<string, string> = { wait: '排隊中', turn: '劃位中', done: '已選位', skip: '暫停排隊', void: '已取消' };
const byVenueSeat = (a: Slot, b: Slot) => a.venue.localeCompare(b.venue, 'zh-Hant') || (a.rowNo ?? 0) - (b.rowNo ?? 0) || Number(a.seatNo) - Number(b.seatNo);

/** 後台「十二、揪團贈票」：設定、登記審核、團練場、年代名單、回報、三樓座位、劃位排隊、送年代名單 */
export default function JoinTab({ j, act, busy, base, sure, confirm2, setMsg }: Props) {
  const [sec, setSec] = useState<Sec>('set');
  const n = (s: string) => j.regs.filter((r) => r.status === s).length;
  const unsentLinks = j.regs.filter((r) => r.status === 'approved' && !r.linksSentAt).length;
  const queue = j.slots.filter((x) => x.status === 'wait' || x.status === 'turn').sort((a, b) => a.pos - b.pos);
  const done = j.slots.filter((x) => x.status === 'done');
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setMsg({ kind: 'ok', text: '已複製' }); } catch { window.prompt('請長按複製', text); }
  };
  const secs: [Sec, string][] = [['set', '設定'], ['reg', `登記審核${n('pending') ? `（${n('pending')}）` : ''}`], ['venue', '團練場'], ['era', '年代名單'],
    ['report', '回報'], ['seats', '三樓座位'], ['queue', `劃位排隊${j.current ? '・進行中' : ''}`], ['list', '送年代名單']];

  return (
    <div>
      <div className="card">
        <h2>十二、揪團贈票（銀區三樓・每 {j.settings.perSeat} 張送 1 席）</h2>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="stat"><b>{n('approved')}</b><span>團練場（已核准）</span></div>
          <div className="stat"><b>{j.reports.length}</b><span>回報訂單</span></div>
          <div className="stat"><b>{j.reports.filter((x) => x.status === 'ok').reduce((a, x) => a + x.qty, 0)}</b><span>已核對張數</span></div>
          <div className="stat"><b style={{ color: 'var(--warn)' }}>{j.reports.filter((x) => x.status === 'pending').reduce((a, x) => a + x.qty, 0)}</b><span>待核對張數</span></div>
          <div className="stat"><b style={{ color: 'var(--ok)' }}>{j.locked ? j.slots.filter((x) => x.status !== 'void').length : j.provisional.length}</b><span>{j.locked ? '劃位序（已鎖定）' : '劃位序（預計）'}</span></div>
          <div className="stat"><b>{done.length}</b><span>已選位</span></div>
          <div className="stat"><b>{j.seats.filter((s) => s.usageId === j.usage.gift && s.status === 'free').length}</b><span>贈席空位</span></div>
        </div>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 6 }}>
          {secs.map(([k, label]) => <button key={k} className={`btn small${sec === k ? ' pri' : ''}`} onClick={() => setSec(k)}>{label}</button>)}
        </div>
      </div>
      {sec === 'set' && <Settings j={j} act={act} busy={busy} base={base} copy={copy} />}
      {sec === 'reg' && <Regs j={j} act={act} busy={busy} sure={sure} confirm2={confirm2} setMsg={setMsg} copy={copy} unsent={unsentLinks} />}
      {sec === 'venue' && <Venues j={j} act={act} busy={busy} sure={sure} confirm2={confirm2} setMsg={setMsg} />}
      {sec === 'era' && <Era j={j} act={act} busy={busy} setMsg={setMsg} />}
      {sec === 'report' && <Reports j={j} act={act} busy={busy} sure={sure} confirm2={confirm2} setMsg={setMsg} />}
      {sec === 'seats' && <Seats j={j} act={act} />}
      {sec === 'queue' && <Queue j={j} act={act} busy={busy} queue={queue} setMsg={setMsg} />}
      {sec === 'list' && <List j={j} act={act} busy={busy} done={done} setMsg={setMsg} />}
    </div>
  );
}

/* ---------- 設定 ---------- */
function Settings({ j, act, busy, base, copy }: { j: J; act: Act; busy: boolean; base: string; copy: (s: string) => void }) {
  const s = j.settings;
  const [f, setF] = useState({ contact: s.contact, perSeat: String(s.perSeat), turnMin: String(s.turnMin), pickMin: String(s.pickMin), pushBack: String(s.pushBack), notifyAhead: String(s.notifyAhead), hourFrom: s.hourFrom, hourTo: s.hourTo, silverPrices: s.silverPrices });
  const set = (values: Record<string, unknown>, ok: string) => act({ action: 'join.settings', values }, ok);
  const link = `${base}/join`;
  const num = (k: keyof typeof f) => Number(f[k]);
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>1. 揪團回報連結（共用，不用註冊）</h3>
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
          <span className="small">即時看板（公開，只顯示群名）：</span>
          <button className="btn small" onClick={() => copy(`${base}/join/board`)}>複製看板連結</button>
          <a className="btn small" href="/join/board" target="_blank" rel="noreferrer">開啟看板</a>
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>這一條連結發到群票服務即可：負責人在這裡「建立新群」（自動生效，不用審核），志工點選群回報。舊的每群專屬回報連結仍可使用。</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{link}</span>
          <button className="btn small" onClick={() => copy(link)}>複製</button>
          <a className="btn small" href="/join" target="_blank" rel="noreferrer">開啟</a>
        </div>
        <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={s.open} disabled={busy} onChange={(e) => set({ open: e.target.checked }, e.target.checked ? '已開放建群' : '已關閉建群')} />
          <span><b>開放建群</b><span className="small muted">（開賣前先讓負責人建群；開放回報時也能建群）</span>{s.open ? <span style={{ color: 'var(--ok)' }}>（開放中）</span> : <span className="muted">（關閉中）</span>}</span></label>
        <label className="f" style={{ marginTop: 8, maxWidth: 420 }}>送出後顯示「資料有誤請聯絡＿＿」
          <input value={f.contact} maxLength={60} placeholder="例：群票服務" onChange={(e) => setF({ ...f, contact: e.target.value })} /></label>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>2. 回報</h3>
        <label className="check"><input type="checkbox" checked={s.reportOpen} disabled={busy} onChange={(e) => set({ reportOpen: e.target.checked }, e.target.checked ? '已開放回報' : '已關閉回報')} />
          <span><b>開放回報</b>{s.reportOpen ? <span style={{ color: 'var(--ok)' }}>（開放中）</span> : <span className="muted">（關閉中）</span>}</span></label>
        <p className="small muted">先收後核：年代名單上還沒有的訂單先收為「待核對」，每次上傳年代名單自動核對。回報截止時到「回報」按「鎖定劃位序」（會同時關閉回報）。</p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="f" style={{ maxWidth: 200 }}>每幾張一個劃位序<input inputMode="numeric" value={f.perSeat} onChange={(e) => setF({ ...f, perSeat: e.target.value })} /></label>
          <label className="f" style={{ maxWidth: 260 }}>銀區票價（逗號分開）<input value={f.silverPrices} placeholder="3000,2550" onChange={(e) => setF({ ...f, silverPrices: e.target.value })} /></label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>年代名單只算 3 樓、售價是這些數字的票；其他票價、其他樓層不計贈票，志工回報時會看到「非銀區」與原因。</p>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>3. 劃位排隊</h3>
        {!j.locked && <p className="note warn small" style={{ marginTop: 0 }}>劃位序還沒鎖定，不能開始。</p>}
        <label className="check"><input type="checkbox" checked={s.pickOpen} disabled={busy || (!j.locked && !s.pickOpen)} onChange={(e) => (!e.target.checked || window.confirm('開始劃位排隊？第 1 號會立刻收到「輪到您了」的 Email。')) && set({ pickOpen: e.target.checked }, e.target.checked ? '已開始劃位排隊' : '已停止劃位排隊')} />
          <span><b>開始劃位排隊</b>{s.pickOpen ? <span style={{ color: 'var(--ok)' }}>（進行中）</span> : <span className="muted">（未開始）</span>}</span></label>
        <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={s.paused} disabled={busy} onChange={(e) => set({ paused: e.target.checked }, e.target.checked ? '已暫停' : '已繼續')} />
          <span><b>暫停</b>（不開始新的一輪；正在選的不計時）</span></label>
        <div className="fields" style={{ marginTop: 10, gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))' }}>
          <label className="f">輪到後等幾分鐘<input inputMode="decimal" value={f.turnMin} onChange={(e) => setF({ ...f, turnMin: e.target.value })} /></label>
          <label className="f">打開後選位分鐘<input inputMode="numeric" value={f.pickMin} onChange={(e) => setF({ ...f, pickMin: e.target.value })} /></label>
          <label className="f">叫不到延後幾號<input inputMode="numeric" value={f.pushBack} onChange={(e) => setF({ ...f, pushBack: e.target.value })} /></label>
          <label className="f">前幾號先通知<input inputMode="numeric" value={f.notifyAhead} onChange={(e) => setF({ ...f, notifyAhead: e.target.value })} /></label>
          <label className="f">時段開始<input value={f.hourFrom} placeholder="09:00" onChange={(e) => setF({ ...f, hourFrom: e.target.value })} /></label>
          <label className="f">時段結束<input value={f.hourTo} placeholder="21:00" onChange={(e) => setF({ ...f, hourTo: e.target.value })} /></label>
        </div>
        <p className="small muted">叫不到：第 1 次延後幾號、第 2 次排到最後、第 3 次暫停排隊（負責人按「我回來了」重新排到最後）。時段留白＝不限。</p>
      </div>
      <ClearTest act={act} busy={busy} />
      <button className="btn pri" disabled={busy} onClick={() => set({ contact: f.contact, perSeat: num('perSeat'), turnMin: num('turnMin'), pickMin: num('pickMin'), pushBack: num('pushBack'), notifyAhead: num('notifyAhead'), hourFrom: f.hourFrom.trim(), hourTo: f.hourTo.trim(), silverPrices: f.silverPrices.trim() }, '已儲存設定')}>儲存設定</button>
    </>
  );
}

/* ---------- 登記審核 ---------- */
function Regs({ j, act, busy, sure, confirm2, setMsg, copy, unsent }: { j: J; act: Act; busy: boolean; sure: string | null; confirm2: Props['confirm2']; setMsg: Props['setMsg']; copy: (s: string) => void; unsent: number }) {
  const [view, setView] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [pick, setPick] = useState<Record<number, string>>({});
  const [edit, setEdit] = useState<{ id: number; headName: string; headPhone: string; email: string; note: string } | null>(null);
  const [q, setQ] = useState('');
  const n = (s: string) => j.regs.filter((r) => r.status === s).length;
  const shown = j.regs.filter((r) => r.status === view).filter((r) => !q.trim() || [r.venueName, r.venueText, r.headName, r.headPhone, r.email].join(' ').includes(q.trim()));
  const reject = (r: Reg) => {
    const why = window.prompt(`退回第 ${r.id} 號（${r.headName}）的原因（必填，只留在後台，不會寄給對方）`, '');
    if (why === null) return;
    if (why.trim().length < 2) { setMsg({ kind: 'err', text: '請填寫退回原因' }); return; }
    act({ action: 'join.reg.decide', id: r.id, status: 'rejected', reason: why }, '已退回');
  };
  const send = async (ids?: number[]) => {
    const r = await act({ action: 'join.links.send', ids }) as { sent: number; noEmail: number } | undefined;
    if (r) setMsg({ kind: r.noEmail ? 'warn' : 'ok', text: `已寄出 ${r.sent} 封回報連結信${r.noEmail ? `；${r.noEmail} 位沒有 Email，請複製連結用 LINE 傳` : ''}` });
  };
  const sendPick = async (ids?: number[]) => {
    const r = await act({ action: 'join.pick.send', ids }) as { sent: number; noEmail: number } | undefined;
    if (r) setMsg({ kind: r.noEmail ? 'warn' : 'ok', text: `已寄出 ${r.sent} 封劃位連結信${r.noEmail ? `；${r.noEmail} 位沒有 Email，請複製連結傳給負責人` : ''}` });
  };
  const withSlot = new Set(j.slots.filter((x) => x.status !== 'void').map((x) => x.regId));
  const unsentPick = j.regs.filter((r) => r.status === 'approved' && withSlot.has(r.id) && !r.pickSentAt).length;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>登記審核</h3>
      <p className="small muted" style={{ marginTop: 0 }}>一個團練場只能核准一位負責人。核准後按「寄出回報連結」（負責人轉給志工）。劃位序鎖定後，再按「寄出劃位連結」（負責人本人用，只寄給有劃位序的）。</p>
      {unsent > 0 && <button className="btn pri small" disabled={busy} onClick={() => confirm2('join-send-all', () => send())} style={{ marginBottom: 10 }}>
        {sure === 'join-send-all' ? `再按一次：寄給 ${unsent} 位` : `寄出所有未寄的回報連結（${unsent} 位）`}</button>}
      {j.locked && unsentPick > 0 && <button className="btn pri small" disabled={busy} onClick={() => confirm2('join-pick-all', () => sendPick())} style={{ marginBottom: 10, marginLeft: 6 }}>
        {sure === 'join-pick-all' ? `再按一次：寄給 ${unsentPick} 位` : `寄出劃位連結（${unsentPick} 位有劃位序）`}</button>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {(['pending', 'approved', 'rejected'] as const).map((s) => <button key={s} className={`btn small${view === s ? ' pri' : ''}`} onClick={() => setView(s)}>{STATUS[s]}（{n(s)}）</button>)}
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
              <button className="btn small" disabled={busy} onClick={() => { const nm = window.prompt('新增成清單上的團練場（可修改名稱，例：台北木柵）', r.venueText); if (nm?.trim()) act({ action: 'join.reg.venue', id: r.id, newName: nm }, '已新增並指定'); }}>新增「{r.venueText}」到清單</button>
            </div>
          )}
          {edit?.id === r.id ? (
            <div style={{ marginTop: 8 }}>
              <div className="fields">
                <label className="f">負責人姓名<input value={edit.headName} onChange={(e) => setEdit({ ...edit, headName: e.target.value })} /></label>
                <label className="f">手機<input value={edit.headPhone} inputMode="tel" onChange={(e) => setEdit({ ...edit, headPhone: e.target.value })} /></label>
                <label className="f">Email<input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></label>
                <label className="f">後台備註<input value={edit.note} maxLength={200} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn pri small" disabled={busy} onClick={async () => { const { id, ...values } = edit; if (await act({ action: 'join.reg.edit', id, values }, '已儲存')) setEdit(null); }}>儲存</button>
                <button className="btn small" onClick={() => setEdit(null)}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <div className="small" style={{ marginTop: 6 }}>負責人：<b>{r.headName}</b>　<a href={`tel:${r.headPhone}`} className="mono">{ph(r.headPhone)}</a>　<span className="mono">{r.email || <span style={{ color: 'var(--warn)' }}>沒有 Email</span>}</span></div>
              {r.note && <div className="small muted">備註：{r.note}</div>}
              {r.status === 'rejected' && r.reason && <div className="small muted">退回原因：{r.reason}</div>}
              {r.status === 'approved' && (
                <div className="small" style={{ marginTop: 6 }}>
                  <div>回報連結（給志工）：<button className="linkbtn" onClick={() => copy(r.reportUrl)}>複製</button>　劃位連結（負責人本人）：<button className="linkbtn" onClick={() => copy(r.pickUrl)}>複製</button></div>
                  <div className="muted">{r.linksSentAt ? `回報連結已寄 ${tw(r.linksSentAt)}` : '回報連結還沒寄'}・{r.pickSentAt ? `劃位連結已寄 ${tw(r.pickSentAt)}` : '劃位連結還沒寄'}</div>
                </div>
              )}
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                {r.status === 'pending' && <button className="btn pri small" disabled={busy || !r.venueId} title={r.venueId ? '' : '先指定團練場'} onClick={() => act({ action: 'join.reg.decide', id: r.id, status: 'approved' }, '已核准')}>核准</button>}
                {r.status === 'pending' && <button className="btn small" disabled={busy} onClick={() => reject(r)}>退回</button>}
                {r.status === 'approved' && <button className="btn small" disabled={busy || !r.email} onClick={() => send([r.id])}>{r.linksSentAt ? '重寄回報連結' : '寄出回報連結'}</button>}
                {r.status === 'approved' && j.locked && withSlot.has(r.id) && <button className="btn small" disabled={busy || !r.email} onClick={() => sendPick([r.id])}>{r.pickSentAt ? '重寄劃位連結' : '寄出劃位連結'}</button>}
                {r.status === 'approved' && <button className="btn small" disabled={busy} onClick={() => confirm2(`join-renew-${r.id}`, () => act({ action: 'join.reg.renew', id: r.id }, '已換新的劃位連結，請重寄劃位連結'))}>{sure === `join-renew-${r.id}` ? '再按一次（舊連結失效）' : '換劃位連結'}</button>}
                {r.status !== 'pending' && <button className="btn small" disabled={busy} onClick={() => act({ action: 'join.reg.decide', id: r.id, status: 'pending' }, '已改回待審核')}>改回待審核</button>}
                <button className="btn small" disabled={busy} onClick={() => setEdit({ id: r.id, headName: r.headName, headPhone: r.headPhone, email: r.email, note: r.note })}>修改</button>
                {r.status === 'rejected' && <button className="btn small" disabled={busy} onClick={() => confirm2(`join-del-${r.id}`, () => act({ action: 'join.reg.delete', id: r.id }, '已刪除'))}>{sure === `join-del-${r.id}` ? '再按一次刪除' : '刪除'}</button>}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- 團練場清單 ---------- */
function Venues({ j, act, busy, sure, confirm2, setMsg }: { j: J; act: Act; busy: boolean; sure: string | null; confirm2: Props['confirm2']; setMsg: Props['setMsg'] }) {
  const [bulk, setBulk] = useState('');
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>團練場清單（登記表從這裡選）</h3>
      <label className="f">新增團練場（一行一個，已有的會略過）
        <textarea rows={3} value={bulk} placeholder={'台北微風小棧\n台北木柵'} onChange={(e) => setBulk(e.target.value)} style={{ font: 'inherit', padding: 8, border: '1px solid var(--line)', borderRadius: 6 }} /></label>
      <button className="btn pri small" style={{ marginTop: 6 }} disabled={busy || !bulk.trim()} onClick={async () => {
        const r = await act({ action: 'join.venue.add', names: bulk.split('\n') }) as { added: number; skipped: number } | undefined;
        if (r) { setBulk(''); setMsg({ kind: 'ok', text: `新增 ${r.added} 個${r.skipped ? `，${r.skipped} 個已存在略過` : ''}` }); }
      }}>新增</button>
      {!j.venues.length && <p className="small muted">還沒有團練場。</p>}
      {j.venues.length > 0 && (
        <div className="tbl" style={{ marginTop: 10 }}><table>
          <thead><tr><th style={{ textAlign: 'left' }}>團練場</th><th>登記</th><th>負責人</th><th>登記表顯示</th><th /></tr></thead>
          <tbody>{j.venues.map((v) => (
            <tr key={v.id}>
              <td>{v.name}</td><td style={{ textAlign: 'center' }}>{v.regs}</td>
              <td>{j.regs.find((r) => r.venueId === v.id && r.status === 'approved')?.headName ?? <span className="muted">—</span>}</td>
              <td style={{ textAlign: 'center' }}><input type="checkbox" checked={v.active} disabled={busy} onChange={(e) => act({ action: 'join.venue.update', id: v.id, values: { active: e.target.checked } })} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn small" disabled={busy} onClick={() => { const nm = window.prompt('改名', v.name); if (nm?.trim() && nm.trim() !== v.name) act({ action: 'join.venue.update', id: v.id, values: { name: nm } }, '已改名'); }}>改名</button>
                <select style={{ width: 'auto', marginLeft: 4 }} value="" disabled={busy || j.venues.length < 2} onChange={(e) => {
                  const to = j.venues.find((x) => x.id === Number(e.target.value));
                  if (to && window.confirm(`把「${v.name}」的 ${v.regs} 份登記併入「${to.name}」，並刪除「${v.name}」？`)) act({ action: 'join.venue.merge', id: v.id, into: to.id }, '已合併');
                }}>
                  <option value="">合併到…</option>
                  {j.venues.filter((x) => x.id !== v.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                {v.regs === 0 && <button className="btn small" style={{ marginLeft: 4 }} disabled={busy} onClick={() => confirm2(`jv-del-${v.id}`, () => act({ action: 'join.venue.delete', id: v.id }, '已刪除'))}>{sure === `jv-del-${v.id}` ? '再按一次' : '刪除'}</button>}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/* ---------- 年代名單 ---------- */
type UpRes = { rows: number; added: number; changed: number; refunded: number; outside: number; newlyVerified: number; pending: number; mismatch: number; refundedReports: number; ambiguous: number; outsideReports: number; early: number; notfound: number; dateFixed: number; newIssues: number; mailed: number };
function upText(r: UpRes, outsideNote: string) {
  const bad = [r.mismatch && `張數不符 ${r.mismatch}`, r.outsideReports && `非銀區 ${r.outsideReports}`, r.refundedReports && `已退票 ${r.refundedReports}`, r.ambiguous && `需補完整編號 ${r.ambiguous}`,
    r.early && `回報早於購買 ${r.early}`, r.notfound && `找不到訂單 ${r.notfound}`].filter(Boolean).join('、');
  return `已上傳 ${r.rows} 筆訂單（新增 ${r.added}、更新 ${r.changed}${r.outside ? `；整筆非銀區 ${r.outside}` : ''}）${outsideNote ? `。不計贈票的票：${outsideNote}` : ''}。`
    + `回報核對：新通過 ${r.newlyVerified} 筆${r.dateFixed ? `（自動更正日期 ${r.dateFixed}）` : ''}、仍待核對 ${r.pending} 筆${bad ? `；需修正：${bad}` : ''}${r.mailed ? `。已寄信通知 ${r.mailed} 位負責人` : ''}`;
}
const ERA_BADGE: Record<string, [string, string]> = { ok: ['已核對', 'var(--ok)'], pending: ['待核對', 'var(--warn)'] };
function Era({ j, act, busy, setMsg }: { j: J; act: Act; busy: boolean; setMsg: Props['setMsg'] }) {
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [cols, setCols] = useState<EraCols>({ head: 0, no: -1, qty: -1, status: -1, floor: -1, row: -1, date: -1, time: -1, price: -1 });
  const [silver, setSilver] = useState(true);
  const [last, setLast] = useState<{ text: string; warn: boolean } | null>(null);
  const [show, setShow] = useState<'all' | 'free' | 'other'>('all');
  const [more, setMore] = useState(100);
  const prices = parsePrices(j.settings.silverPrices);
  async function upload(rows: EraRow[], outsideNote: string) {
    const r = await act({ action: 'join.era.upload', rows }) as UpRes | undefined;
    if (!r) return false;
    setGrid(null);
    const text = upText(r, outsideNote);
    const warn = !!(r.mismatch || r.refundedReports || r.ambiguous || r.outsideReports || r.early || r.notfound);
    setLast({ text, warn });
    setMsg({ kind: warn ? 'warn' : 'ok', text });
    return true;
  }
  async function onFile(file: File) {
    try {
      const X = await import('xlsx');
      const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
      const g = X.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' }).slice(0, 50001).map((r) => r.map((c) => String(c ?? '').trim()));
      const c = guessCols(g);
      const p = eraRows(g, c, true, prices);
      // 欄位都認得（訂單編號、張數或一列一張票、能判斷銀區）→ 選了檔案就直接上傳，不用再按
      if (c.no >= 0 && p.rows.length && p.canSilver && (p.perTicket || c.qty >= 0)) { if (await upload(p.rows, p.outsideNote)) return; }
      setCols(c);
      setGrid(g);
    } catch { setMsg({ kind: 'err', text: '讀不到這個檔案。請用 Excel（.xlsx／.xls）或 .csv。' }); }
  }
  const parsed = useMemo(() => (grid ? eraRows(grid, cols, silver, prices) : null), [grid, cols, silver, prices.join()]);
  const rows = parsed?.rows ?? [];
  const header = grid?.[cols.head] ?? [];
  const pickCol = (k: 'no' | 'qty' | 'status' | 'floor' | 'row' | 'price', label: string, none?: string) => (
    <label className="f">{label}
      <select value={cols[k]} onChange={(e) => setCols({ ...cols, [k]: Number(e.target.value) })}>
        <option value={-1}>{none ?? '請選欄位'}</option>
        {header.map((h, i) => <option key={i} value={i}>{`第 ${i + 1} 欄${h ? `：${h}` : ''}`}</option>)}
      </select>
    </label>
  );
  const list = j.eraList.filter((x) => show === 'all' || (show === 'free' ? !x.group : x.otherQty > 0));
  const unclaimed = j.eraList.filter((x) => !x.group && x.qty > 0 && x.status === 'sold');
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>年代名單</h3>
      <p className="small" style={{ marginTop: 0 }}>目前 <b>{j.era.count}</b> 筆訂單{j.era.refunded ? `（已退 ${j.era.refunded} 筆）` : ''}・最後上傳 {tw(j.era.updatedAt)}</p>
      <p className="small muted">直接選年代「售出明細」檔案，<b>選了就自動上傳並核對</b>（欄位認不出來時才需要手動對欄位、按上傳）。只算 3 樓、售價 {prices.join('、')} 的票（在「設定」可改）；其他票價、其他樓層記為「不計贈票」，志工回報時會看到原因。同一訂單以新上傳的為準，可以重複上傳。</p>
      <label className="btn pri">選擇年代名單檔案（自動上傳）<input type="file" accept=".xls,.xlsx,.csv" style={{ display: 'none' }} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} /></label>
      {last && <p className={`note small ${last.warn ? 'warn' : 'ok'}`} style={{ marginTop: 10 }}>{last.text}{last.warn ? '。有問題的請到「回報」勾「只看有問題的」查看。' : ''}</p>}
      {grid && parsed && (
        <div style={{ marginTop: 12 }}>
          <p className="note warn" style={{ fontSize: 16, fontWeight: 700 }}>⚠️ 欄位沒有全部認出來，<u>還沒上傳</u>。請確認下面的欄位，再按最下面的「上傳」。</p>
          <div className="fields" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))' }}>
            <label className="f">標題在第幾列<input inputMode="numeric" value={cols.head + 1} onChange={(e) => setCols({ ...cols, head: Math.max(0, Number(e.target.value) - 1 || 0) })} /></label>
            {pickCol('no', '訂單編號')}
            {pickCol('qty', '張數', '（沒有：一列一張票，自動合計）')}
            {pickCol('status', '狀態（含「退」字＝已退）', '（沒有，全部算已售）')}
            {pickCol('floor', '樓層', '（沒有）')}
            {pickCol('price', '售價', '（沒有）')}
            {pickCol('row', '排', '（沒有）')}
          </div>
          {parsed.canSilver ? <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={silver} onChange={(e) => setSilver(e.target.checked)} /><span>只算銀區（3 樓、售價 {prices.join('、')}）</span></label>
            : <p className="note warn small">找不到「樓層」與「售價」（或「排」）欄位，無法判斷銀區：上傳後<b>所有票都會算</b>。</p>}
          {cols.no >= 0 && (
            <>
              <p className="small" style={{ marginBottom: 4 }}>整理後 <b>{rows.length}</b> 筆訂單、銀區 <b>{parsed.tickets}</b> 張{parsed.perTicket ? '（一列一張票合計）' : ''}{parsed.outside ? `；不計贈票 ${parsed.outside} 張（${parsed.outsideNote}）` : ''}。前 5 筆預覽：</p>
              <div className="tbl"><table><thead><tr><th>訂單編號</th><th>銀區張數</th><th>不計</th><th>狀態</th></tr></thead>
                <tbody>{rows.slice(0, 5).map((x) => <tr key={x.orderNo}><td className="mono">{x.orderNo}</td><td>{x.qty}</td><td className="small">{x.otherNote}</td><td>{x.status === 'refunded' ? '已退' : '已售'}</td></tr>)}</tbody></table></div>
              <button className="btn pri" style={{ marginTop: 8 }} disabled={busy || !rows.length} onClick={() => upload(rows, parsed.outsideNote)}>上傳 {rows.length} 筆</button>
            </>
          )}
        </div>
      )}
      {j.eraList.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: '0 0 6px' }}>已上傳的訂單（{j.eraList.length} 筆；還沒有群回報的銀區訂單 {unclaimed.length} 筆、{unclaimed.reduce((a, x) => a + x.qty, 0)} 張）</h4>
          <div className="row" style={{ gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
            {([['all', '全部'], ['free', '還沒有群回報'], ['other', '有不計贈票的票']] as const).map(([k, l]) => <button key={k} className={`btn small${show === k ? ' pri' : ''}`} onClick={() => setShow(k)}>{l}</button>)}
          </div>
          <div className="tbl"><table>
            <thead><tr><th style={{ textAlign: 'left' }}>訂單編號</th><th>售出</th><th>銀區</th><th>不計贈票</th><th style={{ textAlign: 'left' }}>回報的群</th></tr></thead>
            <tbody>{list.slice(0, more).map((x) => {
              const b = ERA_BADGE[x.reportStatus];
              return (
                <tr key={x.orderNo}>
                  <td className="mono small">{x.orderNo}{x.status === 'refunded' && <span style={{ color: 'var(--red)' }}>（已退）</span>}</td>
                  <td className="small">{tw(x.soldAt)}</td><td style={{ textAlign: 'center' }}>{x.qty}</td><td className="small">{x.otherNote}</td>
                  <td className="small">{x.group ? <>{x.group} <span style={{ color: b?.[1] ?? 'var(--red)' }}>{b?.[0] ?? '需修正'}</span></> : <span className="muted">無人回報</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {list.length > more && <button className="btn small" style={{ marginTop: 6 }} onClick={() => setMore(more + 200)}>看更多（還有 {list.length - more} 筆）</button>}
        </div>
      )}
    </div>
  );
}

/* ---------- 回報 ---------- */
const RST: Record<string, [string, string]> = { pending: ['待核對', 'var(--warn)'], ok: ['已核對', 'var(--ok)'], mismatch: ['張數不符', 'var(--red)'], refunded: ['已退票', 'var(--red)'], ambiguous: ['需補完整編號', 'var(--red)'],
  outside: ['非銀區', 'var(--red)'], early: ['回報早於購買', 'var(--red)'], notfound: ['找不到訂單', 'var(--red)'] };
const RED = new Set(['mismatch', 'refunded', 'ambiguous', 'outside', 'early', 'notfound']);
function Reports({ j, act, busy, sure, confirm2, setMsg }: { j: J; act: Act; busy: boolean; sure: string | null; confirm2: Props['confirm2']; setMsg: Props['setMsg'] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [showProv, setShowProv] = useState(false);
  const [onlyBad, setOnlyBad] = useState(false);
  const [find, setFind] = useState('');
  const badRegs = new Set(j.reports.filter((x) => RED.has(x.status)).map((x) => x.regId));
  const others = (id: number) => j.totals.filter((x) => x.regId !== id).sort((a, b) => a.venue.localeCompare(b.venue, 'zh-Hant'));
  const rename = (id: number, old: string) => { const n = window.prompt('新的群名稱', old)?.trim(); if (n && n !== old) act({ action: 'join.group.rename', id, name: n }, '已改名'); };
  const merge = (id: number, name: string, into: string) => {
    const to = j.totals.find((x) => String(x.regId) === into);
    if (!to || !window.confirm(`把「${name}」的回報全部合併到「${to.venue}」？\n「${name}」會被移除（劃位序依回報時間重新計算）。`)) return;
    act({ action: 'join.group.merge', id, into: to.regId }, `已合併到「${to.venue}」`); setOpen(null);
  };
  const bad = j.reports.filter((x) => RED.has(x.status));
  const pend = j.reports.filter((x) => x.status === 'pending');
  const short = j.totals.filter((x) => x.short);
  const lock = async () => {
    const msg = `鎖定劃位序？\n・回報會同時關閉\n・目前預計的 ${j.provisional.length} 個劃位序會確定下來${pend.length ? `\n・還有 ${pend.length} 筆「待核對」不會算進去（建議先上傳最新年代名單）` : ''}`;
    if (!window.confirm(msg)) return;
    const r = await act({ action: 'join.lock' }) as { slots: number; venues: number; notCounted: number } | undefined;
    if (r) setMsg({ kind: r.notCounted ? 'warn' : 'ok', text: `已鎖定 ${r.slots} 個劃位序（${r.venues} 個團練場）${r.notCounted ? `；${r.notCounted} 筆待核對沒有算進去` : ''}。下一步：到「登記審核」寄出劃位連結。` });
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>各團練場回報</h3>
      <div className="note small" style={{ marginBottom: 10 }}>
        {j.locked ? <><b style={{ color: 'var(--ok)' }}>劃位序已鎖定</b>（{j.slots.filter((x) => x.status !== 'void').length} 個）。
          {!j.slots.some((x) => x.status !== 'wait') && !j.settings.pickOpen && <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={() => confirm2('join-unlock', () => act({ action: 'join.unlock' }, '已解除鎖定，回報仍關閉；需要時到「設定」重新開放'))}>{sure === 'join-unlock' ? '再按一次解除' : '解除鎖定'}</button>}</>
          : <>預計 <b>{j.provisional.length}</b> 個劃位序（依回報時間、只算已核對）。待核對 {pend.length} 筆。
            <button className="btn pri small" style={{ marginLeft: 8 }} disabled={busy || !j.provisional.length} onClick={lock}>鎖定劃位序（回報截止）</button>
            {j.provisional.length > 0 && <button className="linkbtn" style={{ marginLeft: 8 }} onClick={() => setShowProv(!showProv)}>{showProv ? '收起' : '看預計順序'}</button>}</>}
      </div>
      {showProv && !j.locked && (
        <div className="tbl" style={{ marginBottom: 10 }}><table><thead><tr><th>號碼</th><th style={{ textAlign: 'left' }}>團練場</th><th>滿額時間</th></tr></thead>
          <tbody>{j.provisional.map((x) => <tr key={x.no}><td style={{ textAlign: 'center' }}>{x.no}</td><td>{x.venue}</td><td className="small">{tw(x.at)}</td></tr>)}</tbody></table></div>
      )}
      {bad.length > 0 && <p className="note warn small">有 {bad.length} 筆回報需要修正（張數不符、非銀區、已退票、找不到訂單、回報早於購買、需補完整編號），已用紅字標出原因，不計入張數。每次上傳年代名單後，系統已自動寄信給該群負責人；志工用原手機修正即可。</p>}
      {short.length > 0 && <p className="note warn small">鎖定後年代名單更新，{short.map((x) => x.venue).join('、')} 的已核對張數不夠目前的劃位序。劃位序不會自動取消，請到「劃位排隊」決定。</p>}
      <div className="row" style={{ gap: 10, margin: '6px 0 8px', flexWrap: 'wrap' }}>
        <input value={find} placeholder="找群名" style={{ maxWidth: 180 }} onChange={(e) => setFind(e.target.value)} />
        <label className="check"><input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} /><span>只看有問題的（{badRegs.size} 群）</span></label>
      </div>
      {!j.totals.length ? <p className="muted small">還沒有群。</p> : (
        <div className="tbl"><table>
          <thead><tr><th style={{ textAlign: 'left' }}>群名稱</th><th>負責人</th><th>訂單</th><th>已核對</th><th>待核對</th><th>劃位序</th><th>已選位</th></tr></thead>
          <tbody>{[...j.totals].filter((x) => (!onlyBad || badRegs.has(x.regId)) && (!find.trim() || x.venue.includes(find.trim()))).sort((a, b) => b.verified - a.verified || b.tickets - a.tickets).map((x) => (
            <tr key={x.regId} style={{ cursor: 'pointer', background: x.short ? '#fff4d6' : undefined }} onClick={() => setOpen(open === x.regId ? null : x.regId)}>
              <td>{open === x.regId ? '▼' : '▶'} {x.venue}</td><td>{x.headName}</td><td style={{ textAlign: 'center' }}>{x.orders}</td>
              <td style={{ textAlign: 'center' }}>{x.verified}{x.short && <span style={{ color: 'var(--red)' }}> ⚠</span>}</td><td style={{ textAlign: 'center', color: x.pending ? 'var(--warn)' : undefined }}>{x.pending}</td>
              <td style={{ textAlign: 'center' }}>{x.slots}{!j.locked && x.slots ? <span className="muted small">（預計）</span> : null}</td><td style={{ textAlign: 'center' }}>{x.done}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open !== null && (() => { const g = j.totals.find((x) => x.regId === open); return g && (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <b>{g.venue}</b>
          <button className="btn small" disabled={busy} onClick={() => rename(g.regId, g.venue)}>改群名</button>
          {!j.locked && <select value="" disabled={busy} onChange={(e) => merge(g.regId, g.venue, e.target.value)} style={{ width: 'auto' }}>
            <option value="">合併到…</option>{others(g.regId).map((o) => <option key={o.regId} value={o.regId}>{o.venue}</option>)}
          </select>}
        </div>
      ); })()}
      {open !== null && (
        <div className="tbl" style={{ marginTop: 10 }}><table>
          <thead><tr><th>訂單編號</th><th>張數</th><th>狀態</th><th>填寫人</th><th>時間</th><th /></tr></thead>
          <tbody>{j.reports.filter((x) => x.regId === open).map((x) => (
            <Fragment key={x.id}><tr>
              <td className="mono">{x.orderNo ?? `${x.buyDate ? `${+x.buyDate.slice(2, 4)}/${+x.buyDate.slice(4, 6)}・` : ''}${x.key}`}{x.orderNo && x.key !== x.orderNo && <div className="small muted">輸入 {x.key}</div>}</td><td style={{ textAlign: 'center' }}>{x.qty}</td>
              <td style={{ color: RST[x.status]?.[1], fontWeight: 700 }}>{RST[x.status]?.[0] ?? x.status}</td>
              <td>{x.reporter}</td><td className="small">{tw(x.at)}</td>
              <td><button className="btn small" disabled={busy} onClick={() => confirm2(`jr-del-${x.id}`, () => act({ action: 'join.report.delete', id: x.id }, '已刪除'))}>{sure === `jr-del-${x.id}` ? '再按一次' : '刪除'}</button>
                {!j.locked && <select value="" disabled={busy} style={{ width: 'auto', marginTop: 4 }} onChange={(e) => { const to = j.totals.find((o) => String(o.regId) === e.target.value); if (to && window.confirm(`把這筆移到「${to.venue}」？`)) act({ action: 'join.report.move', id: x.id, to: to.regId }, `已移到「${to.venue}」`); }}>
                  <option value="">移到…</option>{others(x.regId).map((o) => <option key={o.regId} value={o.regId}>{o.venue}</option>)}
                </select>}</td>
            </tr>
            {x.era && <tr><td colSpan={6} className="small" style={{ color: RST[x.status]?.[1], background: RED.has(x.status) ? '#fff4f2' : undefined }}>{x.era}</td></tr>}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

/* ---------- 清除揪團測試資料 ---------- */
function ClearTest({ act, busy }: { act: Act; busy: boolean }) {
  const [withRegs, setWithRegs] = useState(false);
  const go = () => {
    const what = `回報、年代名單、劃位序、已選的贈席${withRegs ? '，以及登記與團練場清單' : ''}`;
    if (!window.confirm(`清除揪團測試資料？\n會刪除：${what}。\n三樓座位設定（贈席／年代售出）保留。\n只能在正式開始前使用！`)) return;
    const typed = window.prompt('確定要清除，請輸入「清除」兩個字', '');
    if (typed?.trim() !== '清除') return;
    act({ action: 'join.clear', withRegs }, '已清除揪團測試資料');
  };
  return (
    <div className="card" style={{ borderLeft: '4px solid var(--red)' }}>
      <h3 style={{ marginTop: 0 }}>清除揪團測試資料</h3>
      <p className="small muted" style={{ marginTop: 0 }}>老大在年代後台測試購買、試回報後使用。只清揪團，不影響一般售票與二樓。正式回報開始後請勿使用。</p>
      <label className="check"><input type="checkbox" checked={withRegs} onChange={(e) => setWithRegs(e.target.checked)} /><span>連登記與團練場清單一起清除（通常不用勾）</span></label>
      <button className="btn small" style={{ marginTop: 8, color: 'var(--red)' }} disabled={busy} onClick={go}>清除揪團測試資料</button>
    </div>
  );
}

/* ---------- 三樓座位 ---------- */
const PAINT: Record<'gift' | 'era' | 'vol' | 'sale', [string, string]> = { gift: ['揪團贈席', '#f8b9cf'], era: ['年代售出', '#cfcfcf'], vol: ['志工席', '#c9b3f0'], sale: ['恢復可售', '#e8f3fb'] };
function Seats({ j, act }: { j: J; act: Act }) {
  const [brush, setBrush] = useState<'gift' | 'era' | 'vol' | 'sale'>('gift');
  const owner = useMemo(() => new Map(j.slots.filter((x) => x.seatId).map((x) => [x.seatId!, x])), [j.slots]);
  const cnt = (id: number, free?: boolean) => j.seats.filter((s) => s.usageId === id && (!free || s.status === 'free')).length;
  const kindOf = (s: J['seats'][number]) => (s.usageId === j.usage.gift ? 'gift' : s.usageId === j.usage.era ? 'era' : s.usageId === j.usage.vol ? 'vol' : 'sale');
  const look = (s: J['seats'][number]): SeatLook => {
    const o = owner.get(s.id);
    const k = kindOf(s);
    return { kind: s.status === 'free' ? 'free' : (s.status as SeatLook['kind']), bg: PAINT[k][1], ink: '#18213a',
      title: `${s.label}・${s.code}・${k === 'sale' ? '其他' : PAINT[k][0]}${o ? `・第 ${o.no} 號 ${o.venue}` : s.status !== 'free' ? '・已劃走' : ''}` };
  };
  const [note, setNote] = useState('');
  const run = async (body: Record<string, unknown>, label: string) => {
    const r = await act(body) as { updated: number; skipped: number; notSide: number } | undefined;
    if (r) setNote(`已設定 ${r.updated} 席為「${label}」${r.notSide ? `；${r.notSide} 席不在左2、右2，揪團贈席只能塗兩側斜區，已略過` : ''}${r.skipped - (r.notSide ?? 0) > 0 ? `；${r.skipped - r.notSide} 席已被選走或不在三樓，沒改` : ''}。`);
  };
  return (
    <div className="grid2">
      <AdminMap floor="3F" seats={j.seats} vipInstalled={false} look={look} caption="框選或塗刷；已被選走的座位不會改"
        onPaint={(ids) => run({ action: 'join.paint', kind: brush, seatIds: ids }, PAINT[brush][0])} />
      <div className="side"><div className="card">
        <h3 style={{ marginTop: 0 }}>三樓座位用途</h3>
        <p className="small muted" style={{ marginTop: 0 }}>揪團贈席（粉紅）只能在<b>左2、右2</b>（兩側斜區）。中間三區（左1、中、右1，年代賣）塗「年代售出」：系統內誰都選不到。志工席：各群選不到，留給志工。</p>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className="btn small" onClick={() => window.confirm('左2、右2 的空位全部設為「揪團贈席」？（志工席、已選走的不動）') && run({ action: 'join.preset', which: 'side' }, '揪團贈席')}>一鍵：左2、右2＝揪團贈席</button>
          <button className="btn small" onClick={() => window.confirm('左1、中、右1 的空位全部設為「年代售出」？（志工席、已選走的不動）') && run({ action: 'join.preset', which: 'middle' }, '年代售出')}>一鍵：中間三區＝年代售出</button>
        </div>
        <p className="small muted" style={{ margin: '0 0 6px' }}>筆刷（先選，再到左邊座位圖按「開始設定」框選或點座位）：</p>
        <div className="brushes">
          {(['gift', 'vol', 'era', 'sale'] as const).map((k) => (
            <button key={k} className={`brush${brush === k ? ' on' : ''}`} onClick={() => setBrush(k)}>
              <i style={{ background: PAINT[k][1] }} />{PAINT[k][0]}
              <span className="c">{k === 'gift' ? cnt(j.usage.gift) : k === 'era' ? cnt(j.usage.era) : k === 'vol' ? cnt(j.usage.vol) : ''}</span>
            </button>
          ))}
        </div>
        {note && <p className="note small" style={{ marginTop: 8 }}>{note}</p>}
        <p className="small">揪團贈席：共 {cnt(j.usage.gift)} 席，空位 {cnt(j.usage.gift, true)} 席；志工席 {cnt(j.usage.vol)} 席；劃位序 {j.slots.filter((x) => x.status !== 'void').length} 個。</p>
        {cnt(j.usage.gift, true) < j.slots.filter((x) => x.status === 'wait' || x.status === 'turn' || x.status === 'skip').length && <p className="note warn small">贈席空位比還沒選位的劃位序少，請再加贈席。</p>}
      </div></div>
    </div>
  );
}

/* ---------- 劃位排隊 ---------- */
function Queue({ j, act, busy, queue, setMsg }: { j: J; act: Act; busy: boolean; queue: Slot[]; setMsg: Props['setMsg'] }) {
  const s = j.settings;
  const skip = j.slots.filter((x) => x.status === 'skip');
  const voidIt = (x: Slot) => { const why = window.prompt(`取消劃位序第 ${x.no} 號（${x.venue}）的原因（必填）${x.seatId ? '\n已選的座位會放回贈席' : ''}`, ''); if (why?.trim()) act({ action: 'join.slot.void', id: x.id, reason: why }, '已取消'); else if (why !== null) setMsg({ kind: 'err', text: '請填寫取消原因' }); };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>劃位排隊</h3>
      <p className="small" style={{ marginTop: 0 }}>{!s.pickOpen ? '尚未開始（到「設定」開始）' : s.paused ? '暫停中' : !j.inHours ? `時段外（${s.hourFrom}–${s.hourTo}）` : '進行中'}</p>
      {j.current ? (
        <div className="note">正在劃位：<b>第 {j.current.nos.join('、')} 號 {j.current.venue}</b>・{j.current.seen ? '負責人已打開' : '等負責人打開'}・期限 {tw(j.current.deadline)}
          <button className="btn small" style={{ marginLeft: 8 }} disabled={busy} onClick={() => window.confirm('跳過這一輪？算一次叫不到。') && act({ action: 'join.queue.skip' }, '已跳過')}>跳過這一輪</button></div>
      ) : <p className="muted small">目前沒有人在劃位。</p>}
      <h4>排隊中（{queue.length}）</h4>
      {queue.length > 0 && <div className="tbl"><table>
        <thead><tr><th>順位</th><th>劃位序</th><th>團練場</th><th>狀態</th><th /></tr></thead>
        <tbody>{queue.map((x, i) => <tr key={x.id}><td>{i + 1}</td><td className="mono">第 {x.no} 號</td><td>{x.venue}</td><td>{SLOT[x.status]}{x.misses ? `・叫不到 ${x.misses} 次` : ''}</td>
          <td><button className="btn small" disabled={busy} onClick={() => voidIt(x)}>取消</button></td></tr>)}</tbody>
      </table></div>}
      {skip.length > 0 && <>
        <h4>暫停排隊（叫不到 3 次）</h4>
        <div className="tbl"><table><tbody>{skip.map((x) => <tr key={x.id}><td className="mono">第 {x.no} 號</td><td>{x.venue}</td>
          <td><button className="btn small" disabled={busy} onClick={() => act({ action: 'join.slot.restore', id: x.id }, '已排到最後')}>恢復（排到最後）</button> <button className="btn small" disabled={busy} onClick={() => voidIt(x)}>取消</button></td></tr>)}</tbody></table></div>
      </>}
      <h4>全部劃位序（最初順序）</h4>
      <div className="tbl"><table>
        <thead><tr><th>劃位序</th><th>團練場</th><th>取得時間</th><th>狀態</th><th>座位</th><th /></tr></thead>
        <tbody>{j.slots.map((x) => <tr key={x.id} style={x.status === 'void' ? { color: 'var(--muted)' } : undefined}>
          <td className="mono">第 {x.no} 號</td><td>{x.venue}</td><td className="small">{tw(x.earnedAt)}</td><td>{SLOT[x.status] ?? x.status}</td><td>{x.seat}</td>
          <td>{x.status === 'done' && <button className="btn small" disabled={busy} onClick={() => { const c = window.prompt('換到哪個座位？請輸入座位編號（座位圖上游標停住可看到，例：15-07-C0）', ''); const to = j.seats.find((y) => y.code === c?.trim()); if (c && !to) setMsg({ kind: 'err', text: '找不到這個座位編號' }); else if (to) act({ action: 'join.slot.seat', id: x.id, seatId: to.id }, '已換座位，記得重送年代'); }}>換座位</button>}
            {x.status === 'done' && !x.sentAt && <button className="btn small" style={{ marginLeft: 4 }} disabled={busy} onClick={() => voidIt(x)}>取消</button>}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
  );
}

/* ---------- 送年代名單 ---------- */
function List({ j, act, busy, done, setMsg }: { j: J; act: Act; busy: boolean; done: Slot[]; setMsg: Props['setMsg'] }) {
  const rows = [...done].sort(byVenueSeat);
  const unsent = rows.filter((x) => !x.sentAt).length;
  async function download(onlyUnsent: boolean) {
    const X = await import('xlsx');
    const data: (string | number)[][] = [['團練場', '負責人', '領票代表', '手機末三碼', '排', '號', '劃位序']];
    for (const x of rows.filter((y) => !onlyUnsent || !y.sentAt)) data.push([x.venue, x.headName, x.repName, x.repPhone.slice(-3), x.rowNo ?? '', x.seatNo, x.no]);
    const ws = X.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 5 }, { wch: 5 }, { wch: 7 }];
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, '揪團贈席');
    const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
    X.writeFile(wb, `揪團贈席名單-${d}.xlsx`);
  }
  const rep = (x: Slot) => {
    const name = window.prompt('領票代表姓名', x.repName); if (name === null) return;
    const phone = window.prompt('領票代表手機', x.repPhone); if (phone === null) return;
    act({ action: 'join.slot.rep', id: x.id, repName: name, repPhone: phone }, '已修改，記得重送年代');
  };
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>送年代名單</h3>
      <p className="small muted" style={{ marginTop: 0 }}>下載名單送年代出紙本招待票，送出後按「標示已送年代」。之後負責人不能改；後台改座位或領票代表時會變回「未送」，要重送。</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn pri small" disabled={!rows.length} onClick={() => download(false)}>下載全部（{rows.length} 席）</button>
        <button className="btn small" disabled={!unsent} onClick={() => download(true)}>只下載未送的（{unsent} 席）</button>
        <button className="btn small" disabled={busy || !unsent} onClick={async () => { const r = await act({ action: 'join.sent', sent: true }) as { count: number } | undefined; if (r) setMsg({ kind: 'ok', text: `已標示 ${r.count} 席為已送年代` }); }}>標示已送年代（{unsent} 席）</button>
      </div>
      {rows.length > 0 && <div className="tbl" style={{ marginTop: 10 }}><table>
        <thead><tr><th>團練場</th><th>負責人</th><th>領票代表</th><th>手機</th><th>排</th><th>號</th><th>劃位序</th><th>已送年代</th><th /></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.id}>
          <td>{x.venue}</td><td>{x.headName}</td><td>{x.repName}</td><td className="mono">{ph(x.repPhone)}</td><td>{x.rowNo}</td><td>{x.seatNo}</td><td className="mono">{x.no}</td>
          <td>{x.sentAt ? tw(x.sentAt) : <span style={{ color: 'var(--warn)' }}>未送</span>}</td>
          <td style={{ whiteSpace: 'nowrap' }}><button className="btn small" disabled={busy} onClick={() => rep(x)}>改領票代表</button>
            {x.sentAt && <button className="btn small" style={{ marginLeft: 4 }} disabled={busy} onClick={() => act({ action: 'join.sent', sent: false, ids: [x.id] }, '已改回未送')}>改回未送</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  );
}
