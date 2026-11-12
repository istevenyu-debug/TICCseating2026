/**
 * 年代名單（Excel）解析：後台上傳前在瀏覽器整理成「訂單編號、張數、已售／已退」。
 * 支援兩種格式：
 *  - 一列一筆訂單：有「張數」欄
 *  - 一列一張票（年代「售出明細」UTK6120）：沒有張數欄，訂單編號像 ER2611120000109-1、-2…，同一訂單合計列數
 * 小計／合計列（沒有訂單編號）自動略過。可只算銀區（3 樓第 13–27 排）。
 */

export type EraCols = { head: number; no: number; qty: number; status: number; floor: number; row: number };
export type EraRow = { orderNo: string; qty: number; status: 'sold' | 'refunded' };

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
  };
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
    const x = map.get(no);
    if (!x) map.set(no, { orderNo: no, qty: refunded && c.qty < 0 ? 0 : q, status: refunded ? 'refunded' : 'sold' });
    else if (c.qty < 0) { if (!refunded) { x.qty += 1; x.status = 'sold'; } }
    else map.set(no, { orderNo: no, qty: q, status: refunded ? 'refunded' : 'sold' });
  }
  const rows = [...map.values()];
  return { rows, tickets: rows.filter((x) => x.status === 'sold').reduce((a, x) => a + x.qty, 0), outside, perTicket: c.qty < 0, canSilver };
}
