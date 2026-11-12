/**
 * 年代名單（Excel）解析：後台上傳前在瀏覽器整理成「訂單編號、張數、已售／已退」。
 * 支援兩種格式：
 *  - 一列一筆訂單：有「張數」欄
 *  - 一列一張票（年代「售出明細」UTK6120）：沒有張數欄，訂單編號像 ER2611120000109-1、-2…，同一訂單合計列數
 * 小計／合計列（沒有訂單編號）自動略過。可只算銀區（3 樓第 13–27 排）。
 */

export type EraCols = { head: number; no: number; qty: number; status: number; floor: number; row: number; date: number; time: number };
export type EraRow = { orderNo: string; qty: number; status: 'sold' | 'refunded'; soldAt?: string | null };

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

/** 銀區：3 樓第 13–27 排 */
export function isSilver(floor: string, row: string) {
  return /3/.test(floor ?? '') && num(row) >= 13 && num(row) <= 27;
}

export function eraRows(g: string[][], c: EraCols, silverOnly: boolean) {
  const body = g.slice(c.head + 1).filter((r) => c.no >= 0 && /^[A-Za-z0-9]/.test(String(r[c.no] ?? '').trim()));
  const canSilver = c.floor >= 0 && c.row >= 0;
  let outside = 0;
  const map = new Map<string, EraRow>();
  for (const r of body) {
    if (silverOnly && canSilver && !isSilver(r[c.floor], r[c.row])) { outside += c.qty >= 0 ? num(r[c.qty]) : 1; continue; }
    const no = orderBase(String(r[c.no]));
    const refunded = c.status >= 0 && /退|取消|作廢/.test(r[c.status] ?? '');
    const q = c.qty >= 0 ? num(r[c.qty]) : 1;
    const soldAt = c.date >= 0 ? soldAtOf(r[c.date], c.time >= 0 ? r[c.time] : '') : null;
    const x = map.get(no);
    if (!x) map.set(no, { orderNo: no, qty: refunded && c.qty < 0 ? 0 : q, status: refunded ? 'refunded' : 'sold', soldAt });
    else if (c.qty < 0) { if (!refunded) { x.qty += 1; x.status = 'sold'; } if (soldAt && (!x.soldAt || soldAt < x.soldAt)) x.soldAt = soldAt; }
    else map.set(no, { orderNo: no, qty: q, status: refunded ? 'refunded' : 'sold', soldAt });
  }
  const rows = [...map.values()];
  return { rows, tickets: rows.filter((x) => x.status === 'sold').reduce((a, x) => a + x.qty, 0), outside, perTicket: c.qty < 0, canSilver };
}
