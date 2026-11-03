'use client';

import { useMemo, useState } from 'react';
import type { floor3State } from '@/lib/card';
import { inkFor } from '@/lib/color';
import AdminMap, { type SeatLook } from './AdminMap';

type F3 = NonNullable<Awaited<ReturnType<typeof floor3State>>>;
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
type Mode = 'frame' | 'unframe' | 'hold' | 'unhold';
interface Usage { id: number; code: string; name: string; sellable: boolean }
interface Props {
  f: F3; act: Act; busy: boolean; usages: Usage[]; base: string; sure: string | null; confirm2: (key: string, fn: () => void) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
}

const money = (n: number) => `NT$${(n || 0).toLocaleString('en-US')}`;
const tw = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const STATUS: Record<string, string> = { pending: '付款中', paid: '已付款', failed: '付款失敗', expired: '逾時未付', refunding: '刷退中', refunded: '已退票' };
const SALE: Record<string, string> = { open: '販售中', closed: '未開放', not_started: '尚未開賣', ended: '已截止' };
const VIA: Record<string, string> = { return: '綠界通知', result: '買方返回', query: '定時查詢', admin: '人工查詢' };
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 16) : '');
const fromLocal = (s: string) => (s ? new Date(`${s}:00+08:00`).toISOString() : null);

/** 後台「三樓售票」：開賣、價格、組合框選、刷卡訂單、退票。三樓的東西都在這一頁，不會動到 2M */
export default function Floor3Tab({ f, act, busy, usages, base, sure, confirm2, setMsg }: Props) {
  const cfg = f.config;
  const s = cfg.settings;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>('frame');
  const [q, setQ] = useState('');
  const [keys, setKeys] = useState({ merchantId: cfg.merchantId, hashKey: '', hashIV: '', checkCode: '' });
  const [start, setStart] = useState(toLocal(s.saleStart));
  const [end, setEnd] = useState(toLocal(s.saleEnd));
  const [fee, setFee] = useState<Record<number, string>>({});
  const [late, setLate] = useState<Record<number, boolean>>({});
  const set = (v: Partial<typeof s>, ok = '已儲存') => act({ action: 'floor3.settings', values: v }, ok);
  const zone = useMemo(() => Object.fromEntries(f.zones.map((z) => [z.id, z])), [f.zones]);
  const hold = usages.find((u) => !u.sellable);
  const sale = usages.find((u) => u.sellable);
  const unsell = useMemo(() => new Set(usages.filter((u) => !u.sellable).map((u) => u.id)), [usages]);
  const groups = new Set(f.seats.filter((x) => x.bundle).map((x) => x.bundle)).size;
  const qty = f.combos.find((c) => !c.isSingle)?.seats ?? 11;
  const buyUrl = `${base}/3f`;
  const single = f.combos.find((c) => c.isSingle);
  const setCombo = f.combos.find((c) => !c.isSingle);

  const look = (x: F3['seats'][number]): SeatLook => {
    const z = zone[x.zoneId];
    const kind: SeatLook['kind'] = x.status === 'sold' ? 'sold' : x.status === 'pending' ? 'pending' : x.status === 'held' ? 'held' : unsell.has(x.usageId) ? 'blocked' : 'free';
    return { bg: z?.color, ink: z ? inkFor(z.color) : undefined, kind, sel: sel.has(x.id), title: `${x.label}・${z?.name ?? ''}${x.bundle ? '・組合' : ''}` };
  };
  const paint = (ids: string[]) => {
    if (mode === 'unframe') {
      const hit = f.seats.find((x) => ids.includes(x.id) && x.bundle);
      if (hit) act({ action: 'floor3.unframe', seatId: hit.id }, '已拆組，這幾席改回單張');
      return;
    }
    setSel((old) => {
      const n = new Set(old);
      const on = !n.has(ids[0]);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });
  };
  const list = f.orders.filter((o) => !q.trim() || `${o.tradeNo} ${o.gwTradeNo} ${o.name} ${o.phone} ${o.email}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="pstack">
      <h2 style={{ margin: '4px 0 -4px' }}>三樓統計 <span className="small muted">（上面那排數字是 2M，兩邊分開算）</span></h2>
      <div className="stats">
        <div className="stat"><b>{f.stats.free}</b><span>剩餘座位</span></div>
        <div className="stat"><b>{f.stats.sold}</b><span>已劃位</span></div>
        <div className="stat"><b>{f.stats.orders}</b><span>已付款訂單</span></div>
        <div className="stat"><b>{money(f.stats.revenue)}</b><span>刷卡收入</span></div>
        <div className="stat"><b>{f.stats.pending}</b><span>付款中</span></div>
        <div className="stat"><b>{f.stats.refunded}</b><span>已退票</span></div>
      </div>
      {f.stats.flagged > 0 && <div className="note err">有 {f.stats.flagged} 筆訂單需要人工處理（標紅），請看下方清單。</div>}

      <div className="grid2">
        <div className="card">
          <h2>開賣 <span className="pill">{SALE[f.state]}</span></h2>
          {cfg.mode !== 'prod' && <div className="note warn small" style={{ marginBottom: 8 }}>目前是綠界測試環境：不會真的扣款。測完要換成「正式」才能開賣。</div>}
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={s.open} disabled={busy} onChange={(e) => set({ open: e.target.checked }, e.target.checked ? '已開放三樓購票' : '已關閉三樓購票')} /> 開放三樓購票</label>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="small">開賣時間<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="small">截止時間<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            <button className="btn" disabled={busy} onClick={() => set({ saleStart: fromLocal(start), saleEnd: fromLocal(end) }, '已更新開賣時間')}>儲存時間</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <b className="small">付款方式</b>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={s.credit} disabled={busy} onChange={(e) => set({ credit: e.target.checked })} /> 信用卡</label>
            <label className="row small muted"><input type="checkbox" style={{ width: 'auto' }} checked={false} disabled readOnly /> ATM 虛擬帳號（尚未開放）</label>
            <label className="row small muted"><input type="checkbox" style={{ width: 'auto' }} checked={false} disabled readOnly /> 銀行匯款（尚未開放）</label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input readOnly value={buyUrl} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
            <button className="btn pri" onClick={() => navigator.clipboard?.writeText(buyUrl).then(() => setMsg({ kind: 'ok', text: `已複製 ${buyUrl}` }), () => undefined)}>複製購票連結</button>
          </div>
        </div>

        <div className="card">
          <h2>價格與方案</h2>
          {f.zones.filter((z) => !z.combo).map((z) => (
            <div key={z.id} className="row" style={{ marginBottom: 8 }}>
              <b style={{ flex: 1 }}>{z.name}</b>
              <label className="small">單張票價 <input key={z.price} type="number" defaultValue={z.price} style={{ width: 100 }} onBlur={(e) => { const v = Number(e.target.value); if (v !== z.price) act({ action: 'zone.update', id: z.id, values: { price: v } }, `單張票價改為 ${money(v)}`); }} /></label>
            </div>
          ))}
          {single && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={single.active} disabled={busy} onChange={(e) => act({ action: 'combo.update', id: single.id, values: { active: e.target.checked } }, e.target.checked ? '已開放單張購買' : '已關閉單張購買')} /> 開放單張購買</label>}
          {setCombo && <>
            <div className="row" style={{ margin: '10px 0 8px' }}>
              <b style={{ flex: 1 }}>{setCombo.name}</b>
              <label className="small">一組價格 <input key={setCombo.price} type="number" defaultValue={setCombo.price} style={{ width: 100 }} onBlur={(e) => { const v = Number(e.target.value); if (v !== setCombo.price) act({ action: 'combo.update', id: setCombo.id, values: { price: v } }, `組合價改為 ${money(v)}`); }} /></label>
            </div>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={setCombo.active} disabled={busy} onChange={(e) => act({ action: 'combo.update', id: setCombo.id, values: { active: e.target.checked } }, e.target.checked ? '已開放組合票' : '已關閉組合票')} /> 開放組合票（目前框好 {groups} 組，可賣 {f.stock.left[`combo:${setCombo.id}`] ?? 0} 組）</label>
          </>}
          <h2 style={{ marginTop: 14 }}>退票規則</h2>
          <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={s.refundOn} disabled={busy} onChange={(e) => set({ refundOn: e.target.checked })} /> 可以退票</label>
          <div className="row">
            <label className="small">演出前幾日 <input key={s.refundDays} type="number" defaultValue={s.refundDays} min={0} max={60} style={{ width: 70 }} onBlur={(e) => { const v = Number(e.target.value); if (v !== s.refundDays) set({ refundDays: v }); }} /></label>
            <label className="small">手續費 % <input key={s.refundFeePct} type="number" defaultValue={s.refundFeePct} min={0} max={10} style={{ width: 70 }} onBlur={(e) => { const v = Number(e.target.value); if (v !== s.refundFeePct) set({ refundFeePct: v }); }} /></label>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>買方看到：{f.refundText}</p>
        </div>
      </div>

      <div className="card">
        <h2>框組合與保留座位</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          {([['frame', `框組合（選 ${qty} 席）`], ['unframe', '拆組（點該組任一席）'], ['hold', '設為保留'], ['unhold', '取消保留']] as [Mode, string][]).map(([k, n]) => (
            <button key={k} className={`btn small${mode === k ? ' pri' : ''}`} onClick={() => { setMode(k); setSel(new Set()); }}>{n}</button>
          ))}
        </div>
        {mode !== 'unframe' && <div className="row" style={{ marginBottom: 8 }}>
          <span className="small">已選 <b>{sel.size}</b> 席</span>
          {mode === 'frame' && <button className="btn pri small" disabled={busy || sel.size !== qty} onClick={async () => { if (await act({ action: 'floor3.frame', seatIds: [...sel] }, `已框成一組 ${qty} 席`)) setSel(new Set()); }}>框成一組</button>}
          {mode === 'hold' && hold && <button className="btn pri small" disabled={busy || !sel.size} onClick={async () => { if (await act({ action: 'usage.assignSeats', usageId: hold.id, seatIds: [...sel] }, `已保留 ${sel.size} 席`)) setSel(new Set()); }}>設為保留（{hold.name}）</button>}
          {mode === 'unhold' && sale && <button className="btn pri small" disabled={busy || !sel.size} onClick={async () => { if (await act({ action: 'usage.assignSeats', usageId: sale.id, seatIds: [...sel] }, `已取消保留 ${sel.size} 席`)) setSel(new Set()); }}>改回可售</button>}
          <button className="btn small" disabled={!sel.size} onClick={() => setSel(new Set())}>清除選取</button>
        </div>}
        <AdminMap floor="3F" seats={f.seats} vipInstalled={false} look={look} onPaint={paint} caption="三樓第 13–27 排，共 724 席" />
      </div>

      <div className="card">
        <h2>刷卡訂單 <span className="small muted">可用訂單編號對照綠界後台</span></h2>
        <input value={q} placeholder="搜尋姓名、手機、Email、訂單編號" style={{ width: '100%', marginBottom: 8 }} onChange={(e) => setQ(e.target.value)} />
        <div className="tbl"><table>
          <thead><tr><th>訂單／時間</th><th>買方</th><th>內容</th><th>狀態</th><th></th></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} style={o.flagged ? { background: '#fdecec' } : undefined}>
                <td><span className="mono small">{o.tradeNo}</span><div className="small muted">{tw(o.paidAt ?? o.createdAt)}{o.env !== 'prod' ? '・測試' : ''}</div>{o.gwTradeNo && <div className="small muted mono">綠界 {o.gwTradeNo}</div>}</td>
                <td>{o.name}<div className="small muted">{o.phone}</div><div className="small muted">{o.email}</div></td>
                <td>{o.items}<div className="small"><b>{money(o.amount)}</b>・已劃 {o.seats} 席</div><div className="small muted">{o.invoiceNo ? `發票 ${o.invoiceNo}${o.invoiceStatus === 'void' ? '（已作廢）' : ''}` : o.invoiceStatus ? `發票：${o.invoiceStatus}` : ''}</div></td>
                <td><span className="pill">{STATUS[o.status] ?? o.status}</span>{o.paidVia && <div className="small muted">{VIA[o.paidVia] ?? o.paidVia}</div>}{o.status === 'refunded' && <div className="small">退 {money(o.refundAmount)}・手續費 {money(o.refundFee)}</div>}{o.note && <div className="small" style={{ color: 'var(--red)' }}>{o.note}</div>}</td>
                <td><div className="row">
                  {o.linkCode && o.status === 'paid' && <button className="btn small" onClick={() => navigator.clipboard?.writeText(`${base}/t/${o.linkCode}`).then(() => setMsg({ kind: 'ok', text: '已複製劃位連結' }), () => undefined)}>複製劃位連結</button>}
                  <button className="btn small" disabled={busy} onClick={async () => { const r = await act({ action: 'floor3.query', id: o.id }) as { tradeStatus: string; amount: number; fixed: boolean } | undefined; if (r) setMsg({ kind: 'ok', text: `綠界狀態 ${r.tradeStatus === '1' ? '已付款' : r.tradeStatus === '0' ? '未付款' : r.tradeStatus}・金額 ${money(r.amount)}${r.fixed ? '・已補單' : ''}` }); }}>向綠界查詢</button>
                  {o.status === 'paid' && <>
                    <label className="small">手續費 <input type="number" min={0} style={{ width: 80 }} value={fee[o.id] ?? String(Math.round(o.amount * s.refundFeePct / 100))} onChange={(e) => setFee({ ...fee, [o.id]: e.target.value })} /></label>
                    <label className="small row"><input type="checkbox" style={{ width: 'auto' }} checked={!!late[o.id]} onChange={(e) => setLate({ ...late, [o.id]: e.target.checked })} /> 超過期限仍要退</label>
                    <button className="btn small" style={{ color: 'var(--red)' }} disabled={busy} onClick={() => confirm2(`rf${o.id}`, () => act({ action: 'floor3.refund', id: o.id, fee: Number(fee[o.id] ?? Math.round(o.amount * s.refundFeePct / 100)), late: !!late[o.id] }, `已退票 ${o.tradeNo}`))}>{sure === `rf${o.id}` ? `再按一次：退 ${money(o.amount - Number(fee[o.id] ?? Math.round(o.amount * s.refundFeePct / 100)))}` : '退票'}</button>
                  </>}
                </div></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={5} className="muted">目前沒有訂單</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="card">
        <h2>綠界金流設定</h2>
        <p className="small muted" style={{ marginTop: 0 }}>這裡是<b>金流</b>那一組，不是發票那組。請管理綠界的人直接在這裡輸入，不要傳 LINE，也不要貼給任何人。</p>
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={cfg.mode === 'test'} disabled={busy} onChange={() => act({ action: 'floor3.keys', values: { mode: 'test' } }, '已切換到綠界測試環境')} /> 綠界測試環境（不扣款，刷退只模擬）</label>
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={cfg.mode === 'prod'} disabled={busy} onChange={() => confirm2('prod', () => act({ action: 'floor3.keys', values: { mode: 'prod' } }, '已切換到正式環境：之後的刷卡會真的扣款'))} /> {sure === 'prod' ? '再按一次：切換到正式（會真的扣款）' : '正式'}</label>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="small">特店編號<input value={keys.merchantId} onChange={(e) => setKeys({ ...keys, merchantId: e.target.value })} /></label>
          <label className="small">HashKey {cfg.keySet ? '（已設定，留空不變）' : ''}<input type="password" autoComplete="off" value={keys.hashKey} onChange={(e) => setKeys({ ...keys, hashKey: e.target.value })} /></label>
          <label className="small">HashIV {cfg.ivSet ? '（已設定，留空不變）' : ''}<input type="password" autoComplete="off" value={keys.hashIV} onChange={(e) => setKeys({ ...keys, hashIV: e.target.value })} /></label>
          <label className="small">商家檢查碼（退票用）{cfg.checkCodeSet ? '（已設定，留空不變）' : ''}<input type="password" autoComplete="off" value={keys.checkCode} onChange={(e) => setKeys({ ...keys, checkCode: e.target.value })} /></label>
          <button className="btn pri" disabled={busy} onClick={async () => { if (await act({ action: 'floor3.keys', values: keys }, '已儲存金流設定')) setKeys({ ...keys, hashKey: '', hashIV: '', checkCode: '' }); }}>儲存</button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>商家檢查碼在綠界廠商後台「信用卡收單 → 信用卡授權資訊」，用來判斷刷卡是否已關帳，全額退票時需要。</p>
      </div>
    </div>
  );
}
