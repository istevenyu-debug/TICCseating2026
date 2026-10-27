/** 計價與組合票規則（純函式，前後端共用） */

export interface ComboItem { zoneId: number; qty: number }

export interface ComboRule {
  id: number;
  name: string;
  isSingle: boolean;
  price: number; // 一組的套票價（單張購票不使用）
  limitSets: number; // 0 = 不限量
  items: ComboItem[];
}

export function comboQty(c: Pick<ComboRule, 'isSingle' | 'items'>): number {
  return c.isSingle ? 0 : c.items.reduce((a, i) => a + i.qty, 0);
}

export function comboDesc(c: Pick<ComboRule, 'isSingle' | 'items'>, zoneName: (id: number) => string): string {
  return c.isSingle ? '依各票種票價計算' : c.items.map((i) => `${zoneName(i.zoneId)}×${i.qty}`).join('＋');
}

/**
 * 勾選的座位剛好是幾組：每個票種的張數都必須是組合內容的同一倍數，且沒有多餘票種。
 * 例：買一A送二B，勾 A×2＋B×4 為 2 組；勾 A×2＋B×3 不成組，回傳 0。
 */
export function comboSets(c: Pick<ComboRule, 'isSingle' | 'items'>, zoneIds: number[]): number {
  if (c.isSingle || !c.items.length || !zoneIds.length) return 0;
  const have = new Map<number, number>();
  zoneIds.forEach((z) => have.set(z, (have.get(z) ?? 0) + 1));
  const need = new Map<number, number>();
  c.items.forEach((i) => need.set(i.zoneId, (need.get(i.zoneId) ?? 0) + i.qty));
  if ([...have.keys()].some((z) => !need.has(z))) return 0;
  let k = 0;
  for (const [z, q] of need) {
    const h = have.get(z) ?? 0;
    if (q <= 0 || h % q !== 0) return 0;
    const m = h / q;
    if (m === 0) return 0;
    if (k === 0) k = m;
    else if (k !== m) return 0;
  }
  return k;
}

/**
 * 回傳此購票方式不適用的原因；適用時回傳 null。
 * zoneIds：勾選的每個座位所屬票種。組合票可買多組，張數須為整組的倍數。
 */
export function comboProblem(
  c: ComboRule, zoneIds: number[], usedSets: number, zoneName: (id: number) => string = (id) => `票種${id}`,
): string | null {
  if (zoneIds.length === 0) return '請先勾選座位';
  if (c.isSingle) return null;
  if (comboQty(c) === 0) return '此組合尚未設定內容';
  if (!(c.price > 0)) return '此組合尚未設定套票價格';
  const k = comboSets(c, zoneIds);
  if (k === 0) return `每組需勾選 ${comboDesc(c, zoneName)}，可買多組（張數須為整組的倍數）`;
  if (c.limitSets > 0 && usedSets + k > c.limitSets) {
    const left = Math.max(0, c.limitSets - usedSets);
    return left ? `此組合只剩 ${left} 組` : '此組合已售完';
  }
  return null;
}

/** 應付金額：單張為票價合計；組合票為套票價 × 組數 */
export function calcAmount(prices: number[], c: Pick<ComboRule, 'isSingle' | 'price'>, sets = 1): number {
  return c.isSingle ? prices.reduce((a, b) => a + b, 0) : c.price * sets;
}
