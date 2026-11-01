/**
 * 網銀對帳（純函式，前後端共用）
 * - parseBankGrid：把網銀下載的明細（.xls 讀成表格，或從 Excel 複製貼上）轉成入帳列
 * - parseRemits：訂單上記的後五碼字串 → [{ last5, amount }]
 * - reconcile：用「後五碼」把入帳與訂單連起來，同一個後五碼的入帳加總；
 *   互相有共用後五碼的訂單算同一組，整組「實收＝應付」才算對上。
 */

export interface BankRow { at: string; amount: number; last5: string; acct: string; balance: string; memo: string }

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, '').trim();
const num = (s: unknown) => { const v = String(s ?? '').replace(/[,\s$NT元]/g, ''); return /^-?\d+(\.\d+)?$/.test(v) ? Math.round(Number(v)) : 0; };

/** 日期（2026/11/01、2026-11-01、115/11/01 民國年）＋時間 → ISO（台北時間） */
function toIso(d: string, tm: string): string | null {
  const m = norm(d).match(/^(\d{2,4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[T ]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  let y = Number(m[1]); if (y < 1000) y += 1911;
  const t = norm(tm).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hh = t?.[1] ?? m[4] ?? '0', mm = t?.[2] ?? m[5] ?? '0', ss = t?.[3] ?? m[6] ?? '0';
  const p = (x: string | number) => String(x).padStart(2, '0');
  return `${y}-${p(m[2])}-${p(m[3])}T${p(hh)}:${p(mm)}:${p(ss)}+08:00`;
}

const HEAD: Record<keyof Omit<BankRow, 'at' | 'last5'> | 'date' | 'time', string[]> = {
  date: ['交易日期', '日期', '帳務日期'], time: ['交易時間', '時間'], amount: ['存入金額', '存入', '收入金額', '存款金額'],
  balance: ['餘額', '帳戶餘額'], memo: ['摘要'], acct: ['備註', '對方帳號', '轉出帳號', '匯款帳號', '帳號'],
};

/**
 * 表格 → 入帳列（只取「存入」）。找得到標題列就依標題對欄位；
 * 找不到（只貼了資料列）就照本行明細的欄位順序：日期、時間、幣別、支出、存入、餘額、（票據號碼）、摘要、備註。
 */
export function parseBankGrid(grid: unknown[][]): { rows: BankRow[]; skipped: number } {
  const g = grid.map((r) => (Array.isArray(r) ? r : []).map((c) => String(c ?? '').trim()));
  const hi = g.findIndex((r) => r.some((c) => HEAD.amount.includes(norm(c))) && r.some((c) => HEAD.date.includes(norm(c))));
  let col: Record<string, number>;
  if (hi >= 0) {
    const h = g[hi].map(norm);
    const find = (names: string[]) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
    col = Object.fromEntries(Object.entries(HEAD).map(([k, v]) => [k, find(v)]));
  } else {
    // 沒有標題：看第一列資料有幾欄（有沒有「票據號碼」欄）
    const first = g.find((r) => toIso(r[0] ?? '', ''));
    const wide = first && first.length >= 9 && !/^\d{8,}$/.test(norm(first[7]));
    col = { date: 0, time: 1, amount: 4, balance: 5, memo: wide ? 7 : 6, acct: wide ? 8 : 7 };
  }
  const rows: BankRow[] = []; let skipped = 0;
  for (const r of g.slice(hi + 1)) {
    const at = col.date >= 0 ? toIso(r[col.date] ?? '', col.time >= 0 ? r[col.time] ?? '' : '') : null;
    if (!at) continue; // 標題、合計、空白列
    const amount = col.amount >= 0 ? num(r[col.amount]) : 0;
    if (amount <= 0) { skipped++; continue; } // 支出
    const acct = (col.acct >= 0 ? r[col.acct] ?? '' : '').replace(/\D/g, '');
    rows.push({ at, amount, acct, last5: acct.length >= 5 ? acct.slice(-5) : '', balance: col.balance >= 0 ? norm(r[col.balance]) : '', memo: col.memo >= 0 ? (r[col.memo] ?? '').slice(0, 40) : '' });
  }
  return { rows, skipped };
}

/** 貼上的文字（Excel 複製出來是 Tab 分隔） → 表格 */
export const pasteToGrid = (text: string) => text.split(/\r?\n/).map((l) => (l.includes('\t') ? l.split('\t') : l.split(/\s{2,}|,(?=\S)/)));

/** 訂單上記的後五碼：'54321'、'11111（NT$15,000）、22222（NT$360）'、''（之後補填） */
export function parseRemits(last5: string, paidAmount: number): { last5: string; amount: number }[] {
  const multi = [...last5.matchAll(/(\d{5})（NT\$([\d,]+)）/g)].map((m) => ({ last5: m[1], amount: Number(m[2].replace(/,/g, '')) }));
  if (multi.length) return multi;
  return /^\d{5}$/.test(last5.trim()) ? [{ last5: last5.trim(), amount: paidAmount }] : [];
}
export function formatRemits(r: { last5: string; amount: number }[]) {
  return r.length > 1 ? r.map((x) => `${x.last5}（NT$${x.amount.toLocaleString('en-US')}）`).join('、') : r[0]?.last5 ?? '';
}

export interface RecOrder { id: number; no: string; name: string; amount: number; last5: string; paidAmount: number; paidOk: boolean; status: string; waitlist: boolean }
export interface RecDeposit { id: number; at: string; amount: number; last5: string; ignored: boolean }
export interface RecGroup { orders: number[]; codes: string[]; deposits: number[]; due: number; got: number }
export type RecState = 'ok' | 'diff' | 'waiting' | 'nolast5';

export function reconcile(orders: RecOrder[], deposits: RecDeposit[]) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  const codesOf = new Map(live.map((o) => [o.id, [...new Set(parseRemits(o.last5, o.paidAmount).map((r) => r.last5))]]));
  // 共用後五碼的訂單併成一組（union-find）
  const parent = new Map<number, number>(live.map((o) => [o.id, o.id]));
  const root = (x: number): number => { const p = parent.get(x)!; if (p === x) return x; const r = root(p); parent.set(x, r); return r; };
  const byCode = new Map<string, number>();
  for (const o of live) for (const c of codesOf.get(o.id)!) {
    const other = byCode.get(c);
    if (other === undefined) byCode.set(c, o.id); else parent.set(root(o.id), root(other));
  }
  const groups = new Map<number, RecGroup>();
  for (const o of live) {
    if (!codesOf.get(o.id)!.length) continue;
    const r = root(o.id);
    const g = groups.get(r) ?? { orders: [], codes: [], deposits: [], due: 0, got: 0 };
    g.orders.push(o.id); g.due += o.amount;
    for (const c of codesOf.get(o.id)!) if (!g.codes.includes(c)) g.codes.push(c);
    groups.set(r, g);
  }
  const used = new Set<number>();
  for (const g of groups.values()) {
    for (const d of deposits) if (!d.ignored && g.codes.includes(d.last5)) { g.deposits.push(d.id); g.got += d.amount; used.add(d.id); }
  }
  const state = new Map<number, { state: RecState; group: RecGroup | null }>();
  for (const o of live) {
    const g = codesOf.get(o.id)!.length ? groups.get(root(o.id))! : null;
    state.set(o.id, { group: g, state: !g ? 'nolast5' : !g.deposits.length ? 'waiting' : g.got === g.due ? 'ok' : 'diff' });
  }
  const unknown = deposits.filter((d) => !d.ignored && !used.has(d.id)).map((d) => d.id);
  return { state, groups: [...groups.values()], unknown };
}
