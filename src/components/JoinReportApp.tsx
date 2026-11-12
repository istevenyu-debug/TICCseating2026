'use client';

import { Fragment, useEffect, useState } from 'react';
import { fmtDate } from './JoinApp';

type Page = {
  event: { name: string; showAt: string }; venue: string; headName: string; open: boolean; locked: boolean; perSeat: number; contact: string;
  orders: number; verified: number; pending: number; bad: number; slots: number[]; next: number;
  today: string;
  list: { id: number; key: string; buyDate: string | null; orderNo: string | null; qty: number; reporter: string; at: string; status: string; eraQty: number | null; mine?: boolean }[];
};
type Result = { accepted: { orderNo: string; qty: number; status: string }[]; rejected: { orderNo: string; qty: string; reason: string }[]; orders: number; verified: number; pending: number; slots: number[]; next: number };
export type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
export type Page_ = Page;
/** 頁面資料與送出的來源：每群專屬連結（/join/r/<code>）或共用連結選好的群（/join） */
export type Api = {
  load: () => Promise<Res<Page>>;
  send: (b: { reporter: string; buyDate: string; rows: { orderNo: string; qty: string }[] }) => Promise<Res<Result>>;
  del: (id: number, reporter: string) => Promise<Res<unknown>>;
  fix: (id: number, orderNo: string, reporter: string) => Promise<Res<unknown>>;
};
const codeApi = (code: string): Api => ({
  load: () => call<Page>(code),
  send: (b) => call<Result>(code, b),
  del: (id, reporter) => call(code, { action: 'delete', id, reporter }),
  fix: (id, orderNo, reporter) => call(code, { action: 'fix', id, orderNo, reporter }),
});
type Row = { orderNo: string; qty: string; reason?: string };

const NAME_KEY = 'join-reporter';
const ST: Record<string, { text: string; color: string }> = {
  pending: { text: '待核對', color: 'var(--warn)' }, ok: { text: '已核對 ✓', color: 'var(--ok)' },
  mismatch: { text: '張數不符', color: 'var(--red)' }, refunded: { text: '已退票', color: 'var(--red)' }, ambiguous: { text: '需補完整編號', color: 'var(--red)' },
};
const blank = (n = 3): Row[] => Array.from({ length: n }, () => ({ orderNo: '', qty: '' }));
const tw = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const store = { get: () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } }, set: (v: string) => { try { localStorage.setItem(NAME_KEY, v); } catch { /* 不能存也沒關係 */ } } };

async function call<T>(code: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(`/api/join/r/${encodeURIComponent(code)}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 志工回報：第一次輸入名字（手機記住），之後輸入年代訂單編號＋張數，整批送出 */
export default function JoinReportApp({ code, api: api0, bar, suggestName }: { code?: string; api?: Api; bar?: React.ReactNode; suggestName?: string }) {
  const [api] = useState<Api>(() => api0 ?? codeApi(code ?? ''));
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [editName, setEditName] = useState(false);
  const [rows, setRows] = useState<Row[]>(blank());
  const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const [buyDate, setBuyDate] = useState(todayIso);
  const [editDate, setEditDate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Result | null>(null);
  const [showList, setShowList] = useState(true);

  const load = () => api.load().then((r) => (r.ok ? setPage(r.data) : setErr(r.message)));
  useEffect(() => {
    const n = store.get();
    // 剛建群的負責人：先帶入負責人姓名，可修改後按確定
    if (suggestName) { setName(''); setNameDraft(suggestName); setEditName(true); } else { setName(n); setEditName(!n); }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (i: number, v: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...v, reason: undefined } : r)));

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const filled = rows.filter((r) => r.orderNo.trim() || r.qty.trim());
    if (!filled.length) { setErr('請輸入訂單編號與張數'); return; }
    setBusy(true); setErr('');
    const r = await api.send({ reporter: name, buyDate, rows: filled.map((x) => ({ orderNo: x.orderNo, qty: x.qty })) });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setLast(r.data);
    const left: Row[] = r.data.rejected.map((x) => ({ orderNo: x.orderNo, qty: x.qty, reason: x.reason }));
    setRows(left.length ? [...left, ...blank(1)] : blank());
    load();
    window.scrollTo(0, 0);
  }

  async function remove(id: number, label: string) {
    if (!window.confirm(`刪除訂單 ${label}？（打錯時刪掉再重新輸入）`)) return;
    setBusy(true);
    const r = await api.del(id, name);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setLast(null); load();
  }

  const [fixing, setFixing] = useState<Record<number, string>>({});
  async function fix(id: number) {
    setBusy(true);
    const r = await api.fix(id, fixing[id] ?? '', name);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setErr(''); setFixing({ ...fixing, [id]: '' }); setLast(null); load();
  }

  if (err && !page) return <main className="wrap join">{bar}<div className="card"><p className="note err">{err}</p></div></main>;
  if (!page) return <main className="wrap join"><div className="card muted">載入中…</div></main>;

  const head = (
    <div className="card">
      <h1 style={{ margin: '0 0 4px' }}>揪團回報・{page.venue}</h1>
      <div className="muted">{page.event.name}・{fmtDate(page.event.showAt)}</div>
      <a href="/join/board" className="small" style={{ display: 'inline-block', marginTop: 6 }}>📊 看即時看板（回報動態、劃位排序）</a>
      {bar}
    </div>
  );
  const summary = (
    <div className="card" style={{ borderTop: '4px solid var(--accent)' }}>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div className="stat"><b style={{ color: 'var(--ok)' }}>{page.verified}</b><span>張已核對</span></div>
        <div className="stat"><b style={{ color: 'var(--warn)' }}>{page.pending}</b><span>張待核對</span></div>
        <div className="stat"><b>{page.slots.length}</b><span>個劃位序</span></div>
      </div>
      {page.slots.length > 0 && <p style={{ margin: '10px 0 0' }}>{page.locked ? '劃位序（已確定）' : '目前預計劃位序'}：<b>第 {page.slots.join('、')} 號</b></p>}
      <p className="small muted" style={{ margin: '6px 0 0' }}>每 {page.perSeat} 張已核對一個劃位序，再 {page.next} 張可多一個。</p>
    </div>
  );
  const howto = (
    <div className="note" style={{ margin: '12px 0' }}>
      <b>訂單編號只要輸入後 4 碼：</b>「-」前面的最後 4 個數字，例如 ER2611120000109-1 → 輸入 <b>0109</b>。系統自動帶入今天的日期；當天買、當天回報最簡單，也排得最前面。若同一天有別筆訂單後 4 碼相同，系統會請您補上完整編號。
      <div style={{ marginTop: 6 }}><b>先收後核：</b>送出後先登記為「待核對」，等年代名單更新後自動核對，核對通過才計入張數與劃位序。劃位序依回報時間排列，越早回報越前面；名單更新時預計號碼可能變動，回報截止後才確定。</div>
      <div style={{ marginTop: 4 }}>有疑義請洽 {page.contact}</div>
    </div>
  );

  const list = (
    <div className="card" style={{ marginTop: 12 }}>
      <button type="button" className="linkbtn" onClick={() => setShowList(!showList)}>{showList ? '▼' : '▶'} 已回報的訂單（{page.list.length}）</button>
      {showList && page.list.length > 0 && (
        <div className="tbl" style={{ marginTop: 8 }}><table>
          <thead><tr><th>訂單編號</th><th>張數</th><th>狀態</th><th>填寫人</th>{page.open && <th />}</tr></thead>
          <tbody>{[...page.list].reverse().map((x) => (
            <Fragment key={x.id}>
              <tr>
                <td className="mono">{x.orderNo ?? `${x.buyDate ? `${+x.buyDate.slice(2, 4)}/${+x.buyDate.slice(4, 6)}・` : ''}${x.key}`}{x.orderNo && x.orderNo !== x.key && <div className="small muted">輸入 {x.key}</div>}<div className="small muted">{tw(x.at)}</div></td>
                <td style={{ textAlign: 'center' }}>{x.qty}</td>
                <td style={{ color: ST[x.status]?.color, fontWeight: 700 }}>{ST[x.status]?.text ?? x.status}{x.status === 'mismatch' && x.eraQty !== null && <div className="small">年代記錄 {x.eraQty} 張</div>}</td>
                <td>{x.reporter}</td>
                {page.open && <td>{x.mine !== false && <button type="button" className="btn small" disabled={busy} onClick={() => remove(x.id, x.orderNo ?? x.key)}>刪除</button>}</td>}
              </tr>
              {page.open && x.status === 'ambiguous' && x.mine !== false && (
                <tr><td colSpan={5} style={{ background: '#fff4f2' }}>
                  <div className="small" style={{ color: 'var(--red)', marginBottom: 4 }}>有好幾筆訂單後幾碼都是 {x.key}，請補上完整訂單編號：</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={fixing[x.id] ?? ''} placeholder="例：ER2611120000109" autoCapitalize="characters" style={{ flex: 1, minWidth: 0 }} onChange={(e) => setFixing({ ...fixing, [x.id]: e.target.value })} />
                    <button type="button" className="btn pri small" disabled={busy || !(fixing[x.id] ?? '').trim()} onClick={() => fix(x.id)}>補上</button>
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );

  if (!page.open) return <main className="wrap join">{head}{summary}<div className="note" style={{ textAlign: 'center', padding: 16 }}>{page.locked ? '回報已截止，劃位序已確定。' : '回報目前沒有開放。'}有疑義請洽 {page.contact}</div>{list}</main>;

  if (editName || !name) return (
    <main className="wrap join">
      {head}
      <form className="card" onSubmit={(e) => { e.preventDefault(); const n = nameDraft.trim(); if (!n) return; store.set(n); setName(n); setEditName(false); }}>
        <h2 style={{ marginTop: 0 }}>請輸入您的名字</h2>
        <p className="small muted" style={{ marginTop: 0 }}>{suggestName && nameDraft === suggestName ? '已帶入負責人姓名，不是您本人請修改。' : ''}只要輸入一次，這支手機會記住。負責人會看到是誰回報的。</p>
        <input value={nameDraft} maxLength={20} autoFocus placeholder="例：王小明" onChange={(e) => setNameDraft(e.target.value)} />
        <button className="btn pri" style={{ marginTop: 12, width: '100%', padding: 12 }} disabled={!nameDraft.trim()}>確定</button>
      </form>
    </main>
  );

  return (
    <main className="wrap join">
      {head}
      {last && (
        <div className={`note${last.accepted.length ? '' : ' err'}`} style={{ marginBottom: 12 }}>
          {last.accepted.length > 0 && <div><b>已收到 {last.accepted.length} 筆、{last.accepted.reduce((a, x) => a + x.qty, 0)} 張</b>
            （已核對 {last.accepted.filter((x) => x.status === 'ok').length} 筆、待核對 {last.accepted.filter((x) => x.status === 'pending').length} 筆）。</div>}
          {last.rejected.length > 0 && <div>{last.rejected.length} 筆沒有收下，原因寫在下面，請修正後再送出。</div>}
        </div>
      )}
      {summary}
      {howto}
      <form onSubmit={send} noValidate className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>輸入年代訂單</h2>
          <span className="small muted">填寫人：{name}（<button type="button" className="linkbtn" onClick={() => { setNameDraft(name); setEditName(true); }}>更換</button>）</span>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 8, alignItems: 'center', background: '#f4f6fb', borderRadius: 10, padding: '8px 12px' }}>
          <span>購買日期：<b>{buyDate === todayIso() ? '今天 ' : ''}{+buyDate.slice(5, 7)}/{+buyDate.slice(8, 10)}</b></span>
          {editDate
            ? <input type="date" value={buyDate} max={todayIso()} onChange={(e) => { if (e.target.value) setBuyDate(e.target.value); setEditDate(false); }} style={{ width: 'auto' }} />
            : <button type="button" className="linkbtn small" onClick={() => setEditDate(true)}>改日期</button>}
        </div>
        <p className="small muted" style={{ margin: '4px 0 0' }}>只填後 4 碼時，系統找這一天買的訂單。不是今天買的請先「改日期」；不同天買的請分開送出。</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px', gap: '6px 8px', marginTop: 10, alignItems: 'center' }}>
          <span className="small muted">訂單編號（後 4 碼即可）</span><span className="small muted">張數</span>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <input value={r.orderNo} maxLength={40} autoCapitalize="characters" placeholder={i === 0 ? '例：0109' : undefined} aria-label={`第 ${i + 1} 筆訂單編號`}
                className={r.reason ? 'need' : undefined} onChange={(e) => setRow(i, { orderNo: e.target.value })} />
              <input value={r.qty} inputMode="numeric" maxLength={3} aria-label={`第 ${i + 1} 筆張數`}
                className={r.reason ? 'need' : undefined} onChange={(e) => setRow(i, { qty: e.target.value.replace(/\D/g, '') })} />
              {r.reason && <div className="small" style={{ gridColumn: '1 / -1', color: 'var(--red)', marginTop: -2 }}>{r.reason}</div>}
            </div>
          ))}
        </div>
        <button type="button" className="btn" style={{ marginTop: 10, width: '100%' }} onClick={() => setRows([...rows, ...blank(1)])}>＋ 再一筆</button>
        {err && <p className="note err" style={{ margin: '10px 0 0' }}>{err}</p>}
        <button className="btn pri" style={{ marginTop: 12, width: '100%', padding: 14, fontSize: 18 }} disabled={busy}>{busy ? '送出中…' : '送出'}</button>
        <p className="small muted" style={{ margin: '8px 0 0' }}>可以分很多次送。打錯的可在下方「已回報的訂單」刪除後重新輸入。</p>
      </form>
      {list}
    </main>
  );
}
