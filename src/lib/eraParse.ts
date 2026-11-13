/**
 * 年代名單（Excel）解析：後台上傳前在瀏覽器整理成「訂單編號、張數、已售／已退」。
 * 支援兩種格式：
 *  - 一列一筆訂單：有「張數」欄
 *  - 一列一張票（年代「售出明細」UTK6120）：沒有張數欄，訂單編號像 ER2611120000109-1、-2…，同一訂單合計列數
 * 小計／合計列（沒有訂單編號）自動略過。
 * 只算銀區：3 樓、第 13–27 排、售價是設定的銀區票價（預設 3000、2550）；沒有的欄位就不檢查。
 * 不算的票不丟掉，記在 otherQty／otherNote，志工回報這種訂單時才能說清楚原因。
 */

export type EraCols = { head: number; no: number; qty: number; status: number; floor: number; row: number; date: number; time: number; price: number; seat?: number };
/** 逐張票（一列一張票的售出明細才有）：全場銷售統計、三樓座位圖用 */
export type EraTicket = { ticketNo: string; orderNo: string; floor: string; row: string; seat: string; price: number; status: 'sold' | 'refunded'; soldAt: string | null };
export type EraRow = { orderNo: string; qty: number; status: 'sold' | 'refunded'; soldAt?: string | null; otherQty?: number; otherNote?: string };
/** 銀區票價（預設）：3000 原價、2550 八五折 */
export const SILVER_PRICES = [3000, 2550];
/** 設定字串「3000,2550」→ [3000, 2550] */
export const parsePrices = (s: string) => [...new Set(String(s ?? '').split(/[^\d]+/).map(Number).filter((n) => n > 0))];

/** 訂單編號主體：去掉每張票的「-1、-2」尾碼 */
export const orderBase = (s: string) => s.trim().toUpperCase().replace(/^(.{6,})-\d{1,3}$/, '$1');

const find = (row: string[], words: string[]) => row.findIndex((c) => words.some((w) => c.includes(w)));

export function guessCols(g: string[][]): EraCols {
  const head = Math.max(0, g.findIndex((r) => r.some((c) => /訂單|編號|單號/.test(c))));
  const h = g[head] ?? [];
  return {
    head,
    no: find(h, ['訂單', '編號', '單號']),
    qty: find(h, ['張數', '數量']),
    status: find(h, ['狀態', '退']),
    floor: find(h, ['區樓', '樓層', '樓']),
    row: h.findIndex((c) => c.trim() === '排' || c.includes('排號')),
    date: find(h, ['售出日期', '訂購日期', '交易日期']),
    time: find(h, ['售出時間', '訂購時間', '交易時間']),
    price: find(h, ['售價', '票價', '實收']),
    seat: h.findIndex((c) => c.trim() === '號' || c.includes('座號') || c.trim() === '座位'),
  };
}

/** 售出日期＋時間 → ISO（台北時間）。日期可為 11/12/26（月/日/年）或 2026/11/12；看不懂就回傳 null */
export function soldAtOf(date: string, time: string): string | null {
  const d = String(date ?? '').trim(), tm = String(time ?? '').trim();
  let y: number, mo: number, da: number;
  let m = d.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  else if ((m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { mo = +m[1]; da = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
  else return null;
  const hm = tm.match(/(\d{1,2}):(\d{2})/) ?? d.match(/\s(\d{1,2}):(\d{2})/);
  if (!hm || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const p2 = (n: number | string) => String(n).padStart(2, '0');
  return `${y}-${p2(mo)}-${p2(da)}T${p2(hm[1])}:${p2(hm[2])}:00+08:00`;
}

const num = (s: string) => Number(String(s ?? '').replace(/[^\d]/g, '')) || 0;

/** 銀區：3 樓第 13–27 排（沒有售價欄時用） */
export function isSilver(floor: string, row: string) {
  return is3F(floor) && num(row) >= 13 && num(row) <= 27;
}
export const is3F = (floor: string) => /(^|\D)3(\D|$)|三樓/.test(String(floor ?? '').trim());

/** 這張票為什麼不算銀區；算的話回傳空字串 */
export function outsideWhy(r: string[], c: EraCols, prices: number[]) {
  const floor = String(r[c.floor] ?? '').trim();
  if (c.floor >= 0 && !is3F(floor)) return floor || '非 3 樓';
  if (c.price >= 0) { const p = num(r[c.price]); if (!prices.includes(p)) return `售價 ${p}`; }
  if (c.floor >= 0 && c.row >= 0 && !isSilver(floor, r[c.row])) return `3樓${String(r[c.row] ?? '').trim()}`;
  return '';
}

const noteOf = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} ${n} 張`).join('、');

export function eraRows(g: string[][], c: EraCols, silverOnly: boolean, prices: number[] = SILVER_PRICES) {
  const body = g.slice(c.head + 1).filter((r) => c.no >= 0 && /^[A-Za-z0-9]/.test(String(r[c.no] ?? '').trim()));
  const canSilver = c.floor >= 0 && (c.row >= 0 || c.price >= 0);
  let outside = 0;
  const why = new Map<string, number>();
  const map = new Map<string, EraRow & { notes: Map<string, number> }>();
  const tickets: EraTicket[] = [];
  for (const r of body) {
    const no = orderBase(String(r[c.no]));
    const refunded = c.status >= 0 && /退|取消|作廢/.test(r[c.status] ?? '');
    const q = c.qty >= 0 ? num(r[c.qty]) : 1;
    const soldAt = c.date >= 0 ? soldAtOf(r[c.date], c.time >= 0 ? r[c.time] : '') : null;
    let x = map.get(no);
    if (!x) { x = { orderNo: no, qty: 0, status: 'sold', soldAt, otherQty: 0, otherNote: '', notes: new Map() }; map.set(no, x); }
    if (soldAt && (!x.soldAt || soldAt < x.soldAt)) x.soldAt = soldAt;
    if (c.qty < 0) {
      const s = (k: number | undefined) => (k !== undefined && k >= 0 ? String(r[k] ?? '').trim() : '');
      tickets.push({ ticketNo: String(r[c.no]).trim().toUpperCase(), orderNo: no, floor: s(c.floor), row: s(c.row), seat: s(c.seat), price: c.price >= 0 ? num(r[c.price]) : 0, status: refunded ? 'refunded' : 'sold', soldAt });
    }
    const w = silverOnly && canSilver ? outsideWhy(r, c, prices) : '';
    if (w) {
      if (refunded) continue;
      outside += q; why.set(w, (why.get(w) ?? 0) + q);
      x.otherQty! += q; x.notes.set(w, (x.notes.get(w) ?? 0) + q);
      continue;
    }
    if (c.qty < 0) { if (!refunded) { x.qty += 1; x.status = 'sold'; } else if (!x.qty) x.status = 'refunded'; }
    else { x.qty = q; x.status = refunded ? 'refunded' : 'sold'; }
  }
  const rows: EraRow[] = [...map.values()].filter((x) => x.qty > 0 || x.otherQty! > 0 || x.status === 'refunded').map(({ notes, ...x }) => ({ ...x, otherNote: noteOf(notes) }));
  return { rows, list: tickets, tickets: rows.filter((x) => x.status === 'sold').reduce((a, x) => a + x.qty, 0), outside, outsideNote: noteOf(why), perTicket: c.qty < 0, canSilver };
}
