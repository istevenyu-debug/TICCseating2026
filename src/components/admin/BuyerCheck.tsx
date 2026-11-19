'use client';
/** 買方核對：二聯（個人）／三聯（統編）／招待 分開看，標出可能有誤的資料。只讀，不改發票、不寄信。 */
import { useMemo, useState } from 'react';
import type { BuyerRow, BuyerKind } from '@/lib/buyerCheck';

export type BuyerCheckData = { rows: BuyerRow[]; internal: string[]; sender: string };
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;

const KIND_NAME: Record<BuyerKind, string> = { b2b: '三聯（統編）', b2c: '二聯（個人）', vip: '招待' };
const INV_STATUS: Record<string, string> = { pending: '待開立', failed: '開立失敗', issued: '已開立', void: '已作廢' };
const n = (v: number) => v.toLocaleString('en-US');
/** 應稅：含稅金額拆未稅＋稅額（參考，實際以綠界開出為準） */
const split = (amt: number) => { const pre = Math.round(amt / 1.05); return { pre, tax: amt - pre }; };

async function download(rows: BuyerRow[], taxed: boolean) {
  const X = await import('xlsx');
  const wb = X.utils.book_new();
  const inv = (r: BuyerRow) => (r.invoice ? `${INV_STATUS[r.invoice.status] ?? r.invoice.status} ${r.invoice.invoiceNo}`.trim() : '');
  const sheets: [BuyerKind, string[], (r: BuyerRow) => (string | number)[]][] = [
    ['b2b', ['訂單', '狀態', '方案', '含稅金額', ...(taxed ? ['未稅（參考）', '稅額（參考）'] : []), '統一編號', '公司抬頭', '訂購人', '手機', '發票 Email', 'QR 寄送 Email', '發票', '可能有誤'],
      (r) => [r.no, r.status, r.plans, r.amount ?? 0, ...(taxed ? [split(r.amount ?? 0).pre, split(r.amount ?? 0).tax] : []), r.ubn, r.title, r.name, r.phone, r.email, r.qrEmails.join('、'), inv(r), r.flags.join('；')]],
    ['b2c', ['訂單', '狀態', '方案', '金額', '載具／捐贈', '訂購人', '手機', '發票 Email', 'QR 寄送 Email', '發票', '可能有誤'],
      (r) => [r.no, r.status, r.plans, r.amount ?? 0, r.carrier, r.name, r.phone, r.email, r.qrEmails.join('、'), inv(r), r.flags.join('；')]],
    ['vip', ['編號', '內容', '金額', '姓名', '手機', 'Email', '可能有誤'], (r) => [r.no, r.plans, '招待', r.name, r.phone, r.email, r.flags.join('；')]],
  ];
  for (const [k, head, row] of sheets) {
    const ws = X.utils.aoa_to_sheet([head, ...rows.filter((r) => r.kind === k).map(row)]);
    ws['!cols'] = head.map((h) => ({ wch: /可能有誤|方案|Email|抬頭/.test(h) ? 30 : 12 }));
    X.utils.book_append_sheet(wb, ws, KIND_NAME[k].replace(/[（）]/g, ' ').trim().slice(0, 31));
  }
  const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16).replace(/[-: ]/g, '');
  X.writeFile(wb, `買方核對-${d}.xlsx`);
}

export default function BuyerCheck({ data, taxType, isAdmin, act, busy }: { data: BuyerCheckData; taxType: string; isAdmin: boolean; act: Act; busy: boolean }) {
  const [kind, setKind] = useState<BuyerKind | 'all'>('all');
  const [onlyBad, setOnlyBad] = useState(false);
  const [q, setQ] = useState('');
  const [mail, setMail] = useState<string | null>(null);
  const taxed = taxType !== '3';
  const rows = data.rows;
  const cnt = (k: BuyerKind) => rows.filter((r) => r.kind === k).length;
  const bad = rows.filter((r) => r.flags.length).length;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (kind === 'all' || r.kind === kind) && (!onlyBad || r.flags.length)
      && (!s || [r.no, r.name, r.phone, r.email, r.ubn, r.title, ...r.qrEmails].some((v) => v.toLowerCase().includes(s))));
  }, [rows, kind, onlyBad, q]);
  const chip = (k: BuyerKind | 'all', label: string, c: number) => (
    <button key={k} className={`btn small${kind === k ? ' pri' : ''}`} onClick={() => setKind(k)}>{label} {c}</button>
  );
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>買方核對（二聯／三聯）</h2>
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        全部方案的買方。<b>三聯</b>＝有統一編號；<b>二聯</b>＝個人（載具或捐贈）；招待不開發票。紅字＝可能有誤，請到「發票」的「改買方」或後台修正。這裡只是查看，不會改資料、不會寄信。
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {chip('all', '全部', rows.length)}{chip('b2b', '三聯', cnt('b2b'))}{chip('b2c', '二聯', cnt('b2c'))}{chip('vip', '招待', cnt('vip'))}
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} style={{ width: 'auto' }} />只看可能有誤（{bad}）
        </label>
        <button className="btn small" onClick={() => download(rows, taxed)}>下載 Excel</button>
      </div>
      <input placeholder="搜尋：訂單、姓名、手機、Email、統編、抬頭" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8, maxWidth: 360 }} />
      <div style={{ maxWidth: 760 }}>
        {list.map((r) => <Item key={r.key} r={r} taxed={taxed} />)}
        {!list.length && <div className="muted small">沒有資料</div>}
      </div>
      <div style={{ marginTop: 12 }}>
        <b className="small">我們自己的信箱</b>
        <span className="small muted">（買方 Email 是這些就標紅：測試或代收時改成自己的，忘了改回）</span>
        <div className="small" style={{ margin: '4px 0' }}>
          自動包含寄件 Gmail：{data.sender || '（未設定）'}{data.internal.length ? `；另加：${data.internal.join('、')}` : ''}
        </div>
        {isAdmin && (mail === null
          ? <button className="btn small" onClick={() => setMail(data.internal.join('\n'))}>修改清單</button>
          : <div>
              <textarea rows={3} value={mail} onChange={(e) => setMail(e.target.value)} placeholder="一行一個 Email，例：工作人員、志工、自己的信箱" style={{ width: '100%', maxWidth: 360 }} />
              <div className="row" style={{ gap: 6 }}>
                <button className="btn pri small" disabled={busy} onClick={async () => { if (await act({ action: 'check.internalEmails', text: mail }, '已儲存')) setMail(null); }}>儲存</button>
                <button className="btn small" onClick={() => setMail(null)}>取消</button>
              </div>
            </div>)}
      </div>
    </div>
  );
}

function Item({ r, taxed }: { r: BuyerRow; taxed: boolean }) {
  const s = r.amount !== null && r.kind === 'b2b' && taxed ? split(r.amount) : null;
  const tag = r.kind === 'b2b' ? { t: '三聯', bg: '#1f3a6e', c: '#fff' } : r.kind === 'b2c' ? { t: '二聯', bg: '#e6ecf5', c: '#1f3a6e' } : { t: '招待', bg: '#f3e8ff', c: '#6b21a8' };
  const qr = r.qrEmails.filter((e) => e.toLowerCase() !== r.email.trim().toLowerCase());
  return (
    <div style={{ border: '1px solid #e2e6ee', borderLeft: r.flags.length ? '4px solid #d33' : '1px solid #e2e6ee', background: r.flags.length ? '#fff6f6' : '#fff', borderRadius: 8, padding: '8px 10px', marginBottom: 8, lineHeight: 1.55 }}>
      <div>
        <span style={{ background: tag.bg, color: tag.c, borderRadius: 4, padding: '1px 6px', fontSize: 12, fontWeight: 700, marginRight: 6 }}>{tag.t}</span>
        <b>{r.name || '（無姓名）'}</b> <span className="small muted">{r.phone}</span>
        <span className="small muted" style={{ float: 'right' }}>{r.no}・{r.status}</span>
      </div>
      <div className="small">{r.plans}・<b>{r.amount === null ? '招待' : `NT$${n(r.amount)}`}</b>{s && <span className="muted">（未稅 {n(s.pre)}＋稅 {n(s.tax)}，參考）</span>}</div>
      {r.kind === 'b2b' && <div className="small">統編 <b>{r.ubn}</b>　{r.title || <span style={{ color: '#c00' }}>（無抬頭）</span>}</div>}
      {r.kind === 'b2c' && <div className="small">{r.carrier}</div>}
      <div className="small" style={{ wordBreak: 'break-all' }}>
        {r.kind === 'vip' ? 'Email' : '發票 Email'}：{r.email || '—'}{qr.map((e) => <span key={e} className="muted">　QR 寄：{e}</span>)}
        {r.kind !== 'vip' && <span className="muted">　發票：{r.invoice ? `${INV_STATUS[r.invoice.status] ?? r.invoice.status} ${r.invoice.invoiceNo}` : '未建立'}</span>}
      </div>
      {r.flags.map((f) => <div key={f} className="small" style={{ color: '#c00' }}>⚠ {f}</div>)}
    </div>
  );
}
