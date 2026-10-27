/** 計價與組合票規則（純函式，前後端共用） */

export interface ComboRule {
  code: string;
  name: string;
  qty: number; // 0 = 單張購票
  discountPct: number;
  sameZone: boolean;
  limitSets: number; // 0 = 不限量
  active: boolean;
}

/** 回傳此組合票不適用的原因；適用時回傳 null */
export function comboProblem(c: ComboRule, zoneCodes: string[], usedSets: number): string | null {
  if (!c.active) return '此票種未開放';
  if (zoneCodes.length === 0) return '請先勾選座位';
  if (c.qty === 0) return null;
  if (zoneCodes.length !== c.qty) return `需勾選 ${c.qty} 個座位`;
  if (c.sameZone && new Set(zoneCodes).size > 1) return '座位需在同一票區';
  if (c.limitSets > 0 && usedSets >= c.limitSets) return '此組合已售完';
  return null;
}

/** 應付金額：單張為原價合計；組合票為原價合計乘折扣後四捨五入至十元 */
export function calcAmount(prices: number[], c: Pick<ComboRule, 'qty' | 'discountPct'>): number {
  const sum = prices.reduce((a, b) => a + b, 0);
  if (c.qty === 0) return sum;
  return Math.round((sum * c.discountPct) / 100 / 10) * 10;
}
