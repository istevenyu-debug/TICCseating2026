'use client';

import { useState } from 'react';
import type { giftAdminState, GiftOption } from '@/lib/joinGift';

export type GiftState = Awaited<ReturnType<typeof giftAdminState>>;
type Seat = GiftState['seats'][number];
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
interface Props {
  g: GiftState; act: Act; busy: boolean; sure: string | null; confirm2: (key: string, fn: () => void) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
}
const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');

/** 十二、揪團贈票 →「贈票取票方式」：寄調查信、各方式統計、每席明細、取票選項設定（做活的） */
export default function GiftAdmin({ g, act, busy, sure, confirm2, setMsg }: Props) {
  const [one, setOne] = useState<number | ''>('');
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState<Seat | null>(null);
  const oneG = g.groups.find((x) => x.regId === one);
  const name = (k: string) => g.settings.options.find((o) => o.key === k)?.name ?? '';
  const rows = g.seats.filter((x) => !filter || (filter === '-' ? !x.effectiveKey : x.effectiveKey === filter));
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setMsg({ kind: 'ok', text: '已複製' }); } catch { window.prompt('請長按複製', text); } };

  async function sendOne(resend: boolean) {
    if (!oneG) return;
    const r = await act({ action: 'join.gift.send', ids: [oneG.regId], resend }) as { count: number } | null;
    if (r) setMsg({ kind: 'ok', text: r.count ? `已寄給 ${oneG.headName}（${oneG.email}）` : '沒有寄出' });
  }
  async function sendAll() {
    const r = await act({ action: 'join.gift.send' }) as { count: number; skipped: { noEmail: number; sent: number } } | null;
    if (r) setMsg({ kind: 'ok', text: `已寄出 ${r.count} 封${r.skipped.sent ? `；已寄過的 ${r.skipped.sent} 群沒有再寄` : ''}${r.skipped.noEmail ? `；${r.skipped.noEmail} 群沒有 Email，請複製連結用 LINE 傳` : ''}` });
  }
  async function download() {
    const X = await import('xlsx');
    const data: (string | number)[][] = [['取票方式', '群', '負責人', '劃位序', '排', '號', '入座者', 'Email', '收件手機', '收件地址', '電子票序號', '已入場']];
    const sorted = [...g.seats].sort((a, b) => (a.effectiveKey || 'zz').localeCompare(b.effectiveKey || 'zz') || (a.rowNo ?? 0) - (b.rowNo ?? 0) || Number(a.seatNo) - Number(b.seatNo));
    for (const x of sorted) data.push([x.effectiveKey ? `${name(x.effectiveKey)}${x.defaulted ? '（逾期預設）' : ''}` : '尚未選擇', x.group, x.headName, x.no, x.rowNo ?? '', x.seatNo, x.name, x.email, x.phone, x.address, x.serial, x.entered ? tw(x.entered) : '']);
    const ws = X.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 7 }, { wch: 5 }, { wch: 5 }, { wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 36 }, { wch: 10 }, { wch: 12 }];
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, '贈票取票方式');
    const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
    X.writeFile(wb, `贈票取票方式-${d}.xlsx`);
  }

  /** 各群座位 Excel（只有系統管理員）：群 → 買的年代座位＋贈席 */
  async function downloadGroups() {
    const r = await act({ action: 'join.seats.export' }) as Awaited<ReturnType<typeof import('@/lib/joinSeats').groupSeatsExport>> | null;
    if (!r) return;
    const X = await import('xlsx');
    const wb = X.utils.book_new();
    const a = X.utils.aoa_to_sheet([['群', '負責人', '手機', 'Email', '已核對張數', '年代名單張數', '贈席數', '買的年代座位', '贈席座位', '取票方式'],
      ...r.groups.map((g) => [g.group, g.headName, g.headPhone, g.email, g.okQty, g.eraQty, g.slots, g.bought, g.gift, g.giftHow])]);
    a['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 12 }, { wch: 24 }, { wch: 9 }, { wch: 9 }, { wch: 7 }, { wch: 60 }, { wch: 30 }, { wch: 16 }];
    X.utils.book_append_sheet(wb, a, '各群');
    const b = X.utils.aoa_to_sheet([['群', '買的／贈席', '樓層', '排', '號', '年代訂單／劃位序', '志工／入座者', '備註'],
      ...r.seats.map((x) => [x.group, x.kind, x.floor, x.row, x.seat, x.orderNo, x.who, x.note])]);
    b['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 20 }, { wch: 12 }, { wch: 22 }];
    X.utils.book_append_sheet(wb, b, '每席');
    const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
    X.writeFile(wb, `各群座位-${d}.xlsx`);
    setMsg({ kind: 'ok', text: `已下載：${r.groups.length} 群。只算已核對的回報；內有個資，請勿外傳。` });
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <span className="small muted">各群買的年代座位＋贈席（只有系統管理員能下載，含個資）</span>
          <button className="btn small" disabled={busy} onClick={downloadGroups}>下載各群座位 Excel</button>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>各取票方式統計</h3>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {g.tally.map((x) => <div key={x.key} className="stat"><b style={{ color: x.kind === 'qr' ? '#d9467a' : undefined }}>{x.seats}</b><span>{x.name}（{x.groups} 群）{x.active ? '' : '・停用'}</span></div>)}
          <div className="stat"><b style={{ color: 'var(--warn)' }}>{g.undecided}</b><span>尚未選擇</span></div>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>共 {g.seats.length} 席已選位。逾期未回覆的算進「{name(g.settings.defaultKey)}」。選 QR 的席，紙本票留在備用盒，不要發出。</p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>寄出調查信（給負責人）</h3>
        <p className="small muted" style={{ marginTop: 0 }}>信裡有劃位頁連結，負責人在那裡每席選方式、填入座者。回覆截止＝寄出後 {g.settings.hours} 小時（每群各自算）。</p>
        <b>① 先試寄一群</b>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0 12px' }}>
          <select value={one} onChange={(e) => setOne(e.target.value ? Number(e.target.value) : '')}>
            <option value="">選擇群</option>
            {g.groups.map((x) => <option key={x.regId} value={x.regId}>{x.group}・{x.headName}・{x.seats} 席{x.sentAt ? '（已寄）' : x.email ? '' : '（沒有 Email）'}</option>)}
          </select>
          {oneG && !oneG.sentAt && <button className="btn pri small" disabled={busy || !oneG.email} onClick={() => sendOne(false)}>寄給 {oneG.headName}</button>}
          {oneG?.sentAt && <button className="btn small" disabled={busy} onClick={() => confirm2(`gift-resend-${oneG.regId}`, () => sendOne(true))}>{sure === `gift-resend-${oneG.regId}` ? '確定重寄？再按一次' : '重寄這一群（截止時間不變）'}</button>}
          {oneG?.pickUrl && <button className="btn small" onClick={() => copy(oneG.pickUrl)}>複製劃位頁連結</button>}
          {oneG && (oneG.sentAt || oneG.decided > 0) && <button className="btn small" disabled={busy || !g.testOpen} title="測試用：這一群回到還沒寄調查信，舊 QR 全部失效"
            onClick={() => confirm2(`gift-reset-${oneG.regId}`, async () => {
              const r = await act({ action: 'join.gift.reset', id: oneG.regId }) as { seats: number; checkins: number } | null;
              if (r) setMsg({ kind: 'ok', text: `已重設 ${oneG.group}：${r.seats} 席回到未選、舊 QR 全部失效${r.checkins ? `、刪除 ${r.checkins} 筆入場紀錄` : ''}。可以再按「寄給 ${oneG.headName}」重新測試。` });
            })}>{!g.testOpen ? '重設已停用（活動當天）' : sure === `gift-reset-${oneG.regId}` ? `確定重設？${oneG.checkins ? `將一併刪除 ${oneG.checkins} 筆入場紀錄，` : ''}再按一次` : '重設這一群（重新測試）'}</button>}
        </div>
        {oneG?.sentAt && <p className="small" style={{ margin: '-6px 0 12px' }}>{oneG.sentAt ? `已寄 ${tw(oneG.sentAt)}・截止 ${tw(oneG.deadline)}・已決定 ${oneG.decided}／${oneG.seats} 席` : ''}</p>}
        <b>② 寄給全部群主</b>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '6px 0 0' }}>
          <button className="btn pri" disabled={busy || !g.sendable} onClick={() => confirm2('gift-send-all', sendAll)}>
            {sure === 'gift-send-all' ? `確定寄給 ${g.sendable} 位負責人？再按一次` : `寄給全部未寄的群主（${g.sendable} 群）`}</button>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>只寄還沒寄過、有 Email、已選好座位的群；已寄過的（含試寄那群）不會再寄。</p>
        {g.groups.some((x) => !x.email) && <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>沒有 Email（請複製劃位頁連結用 LINE 傳）：{g.groups.filter((x) => !x.email).map((x) => x.group).join('、')}</p>}
        <div className="tbl" style={{ marginTop: 10 }}><table>
          <thead><tr><th>群</th><th>負責人</th><th>席數</th><th>已決定</th><th>寄出</th><th>截止</th></tr></thead>
          <tbody>{g.groups.map((x) => <tr key={x.regId}><td>{x.group}</td><td>{x.headName}</td><td>{x.seats}</td><td>{x.decided}</td><td>{x.sentAt ? tw(x.sentAt) : <span className="muted">未寄</span>}</td><td>{tw(x.deadline)}</td></tr>)}</tbody>
        </table></div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>每席明細</h3>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部（{g.seats.length}）</option>
            {g.tally.map((x) => <option key={x.key} value={x.key}>{x.name}（{x.seats}）</option>)}
            <option value="-">尚未選擇（{g.undecided}）</option>
          </select>
          <button className="btn small" disabled={!g.seats.length} onClick={download}>下載 Excel（依方式、座位排序）</button>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>座位</th><th>群</th><th>取票方式</th><th>入座者</th><th>Email／收件</th><th>電子票</th><th /></tr></thead>
          <tbody>{rows.map((x) => <tr key={x.slotId}>
            <td style={{ whiteSpace: 'nowrap' }}>{x.label}<div className="small muted">第 {x.no} 號</div></td>
            <td>{x.group}<div className="small muted">{x.headName}</div></td>
            <td>{x.effectiveKey ? name(x.effectiveKey) : <span style={{ color: 'var(--warn)' }}>尚未選擇</span>}{x.defaulted && <div className="small muted">逾期預設</div>}</td>
            <td>{x.name}</td>
            <td className="small">{x.email}{x.address && <div>{x.phone} {x.address}</div>}</td>
            <td className="small">{x.serial ? <><span className="mono">{x.serial}</span>{x.entered && <div style={{ color: 'var(--ok)' }}>已入場 {tw(x.entered)}</div>}{x.mailedAt && <div className="muted">寄 {tw(x.mailedAt)}</div>}</> : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="btn small" disabled={busy} onClick={() => setEdit(x)}>修改</button>
              {x.serial && x.url && <button className="btn small" style={{ marginLeft: 4 }} onClick={() => copy(x.url)}>複製電子票連結</button>}
            </td>
          </tr>)}</tbody>
        </table></div>
        {edit && <EditSeat s={edit} options={g.settings.options} act={act} busy={busy} close={() => setEdit(null)} />}
      </div>

      <Options g={g} act={act} busy={busy} />
    </>
  );
}

/** 後台修改一席（不受截止時間限制） */
function EditSeat({ s, options, act, busy, close }: { s: Seat; options: GiftOption[]; act: Act; busy: boolean; close: () => void }) {
  const [f, setF] = useState({ optionKey: s.optionKey || s.effectiveKey, name: s.name, email: s.email, phone: s.phone, address: s.address });
  const o = options.find((x) => x.key === f.optionKey);
  async function save() {
    const r = await act({ action: 'join.gift.seat', seat: { slotId: s.slotId, ...f } }) as { mailed: number } | null;
    if (r) close();
  }
  return (
    <div className="card" style={{ border: '2px solid var(--brand, #8a6a2a)', marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>修改：{s.label}（{s.group}・第 {s.no} 號）</h3>
      <div className="fields">
        <label className="f">取票方式<select value={f.optionKey} onChange={(e) => setF({ ...f, optionKey: e.target.value })}>
          <option value="">尚未選擇</option>{options.map((x) => <option key={x.key} value={x.key}>{x.name}{x.active ? '' : '（停用）'}</option>)}</select></label>
        <label className="f">入座者姓名<input value={f.name} maxLength={30} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        {o?.kind === 'qr' && <label className="f">Email（填了會寄電子票）<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>}
        {o?.needAddress && <><label className="f">收件手機<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="f">收件地址<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label></>}
      </div>
      <p className="small muted">改姓名或從 QR 改成紙本，這一席的 QR 會換新、舊的失效。</p>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn pri small" disabled={busy} onClick={save}>儲存</button>
        {s.serial && s.email && <button className="btn small" disabled={busy} onClick={() => act({ action: 'join.gift.mail', slotId: s.slotId }, `已重寄到 ${s.email}`)}>重寄電子票 Email</button>}
        <button className="btn small" onClick={close}>取消</button>
      </div>
    </div>
  );
}

/** 取票選項（做活的）：新增、修改、排序、停用；已有人選的不能刪、不能改類型 */
function Options({ g, act, busy }: { g: GiftState; act: Act; busy: boolean }) {
  const [opts, setOpts] = useState<GiftOption[]>(g.settings.options);
  const [hours, setHours] = useState(String(g.settings.hours));
  const [def, setDef] = useState(g.settings.defaultKey);
  const used = new Map(g.tally.map((x) => [x.key, g.seats.filter((y) => y.optionKey === x.key).length]));
  const up = (i: number, v: Partial<GiftOption>) => setOpts((o) => o.map((x, j) => (j === i ? { ...x, ...v } : x)));
  const move = (i: number, d: number) => setOpts((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>取票選項設定</h3>
      <p className="small muted" style={{ marginTop: 0 }}>這裡的選項會出現在調查信和負責人劃位頁。QR＝本系統電子票；紙本＝要發年代紙本票。已有人選的選項不能刪除或改類型，只能停用。</p>
      {opts.map((o, i) => (
        <div key={o.key || `new-${i}`} style={{ borderTop: '1px solid var(--line, #e3e7ef)', padding: '8px 0' }}>
          <div className="fields">
            <label className="f">名稱<input value={o.name} maxLength={40} onChange={(e) => up(i, { name: e.target.value })} /></label>
            <label className="f">說明<input value={o.desc} maxLength={120} onChange={(e) => up(i, { desc: e.target.value })} /></label>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label>類型 <select value={o.kind} disabled={!!used.get(o.key)} onChange={(e) => up(i, { kind: e.target.value as GiftOption['kind'] })}><option value="qr">電子票 QR</option><option value="paper">紙本</option></select></label>
            {o.kind === 'paper' && <label><input type="checkbox" checked={o.needAddress} onChange={(e) => up(i, { needAddress: e.target.checked })} /> 要填地址（郵寄）</label>}
            <label><input type="checkbox" checked={o.active} onChange={(e) => up(i, { active: e.target.checked })} /> 啟用</label>
            <button className="btn small" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
            <button className="btn small" onClick={() => move(i, 1)} disabled={i === opts.length - 1}>↓</button>
            {used.get(o.key) ? <span className="small muted">已有 {used.get(o.key)} 席選擇</span>
              : <button className="btn small" onClick={() => setOpts((x) => x.filter((_, j) => j !== i))}>刪除</button>}
          </div>
        </div>
      ))}
      <button className="btn small" style={{ marginTop: 6 }} disabled={opts.length >= 10} onClick={() => setOpts((o) => [...o, { key: '', name: '', desc: '', kind: 'paper', needAddress: false, active: true }])}>＋ 新增選項</button>
      <div className="fields" style={{ marginTop: 12 }}>
        <label className="f">回覆時間（寄出後幾小時截止）<input value={hours} inputMode="numeric" onChange={(e) => setHours(e.target.value)} /></label>
        <label className="f">逾期未回覆視為<select value={def} onChange={(e) => setDef(e.target.value)}>
          {opts.filter((o) => o.key && o.active).map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}</select></label>
      </div>
      <button className="btn pri" disabled={busy} onClick={async () => {
        const r = await act({ action: 'join.gift.settings', values: { options: opts, hours: Number(hours), defaultKey: def } }, '已儲存取票選項') as GiftState['settings'] | null;
        if (r && typeof r === 'object') { setOpts(r.options); setHours(String(r.hours)); setDef(r.defaultKey); }
      }}>儲存選項設定</button>
    </div>
  );
}
