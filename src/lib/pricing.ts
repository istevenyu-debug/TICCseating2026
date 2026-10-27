/** 計價與組合票規則（純函式，前後端共用） */

export interface ComboItem { zoneId: number; qty: number }

export interface ComboRule {
  id: number;
  name: string;
  isSingle: boolean;
  price: number; // 套票價（單張購票不使用）
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
 * 回傳此購票方式不適用的原因；適用時回傳 null。
 * zoneIds：勾選的每個座位所屬票種。組合票必須「每個票種的張數剛好符合組合內容」。
 */
export function comboProblem(
  c: ComboRule, zoneIds: number[], usedSets: number, zoneName: (id: number) => string = (id) => `票種${id}`,
): string | null {
  if (zoneIds.length === 0) return '請先勾選座位';
  if (c.isSingle) return null;
  if (comboQty(c) === 0) return '此組合尚未設定內容';
  if (!(c.price > 0)) return '此組合尚未設定套票價格';
  const have = new Map<number, number>();
  zoneIds.forEach((z) => have.set(z, (have.get(z) ?? 0) + 1));
  const need = new Map<number, number>();
  c.items.forEach((i) => need.set(i.zoneId, (need.get(i.zoneId) ?? 0) + i.qty));
  const keys = new Set([...have.keys(), ...need.keys()]);
  for (const k of keys) {
    if ((have.get(k) ?? 0) !== (need.get(k) ?? 0)) return `需勾選 ${comboDesc(c, zoneName)}`;
  }
  if (c.limitSets > 0 && usedSets >= c.limitSets) return '此組合已售完';
  return null;
}

/** 應付金額：單張為票價合計；組合票為套票價 */
export function calcAmount(prices: number[], c: Pick<ComboRule, 'isSingle' | 'price'>): number {
  return c.isSingle ? prices.reduce((a, b) => a + b, 0) : c.price;
}
