/** 贈品（純函式，前後端共用）。贈品一律記在系統裡；買方看不看得到由活動的 giftShow 決定（預設都不顯示） */
export type GiftItem = { id: number; name: string; unit: string };
export type ComboGift = { giftId: number; qty: number };

/** 例：「書 12 本、穀東米 1 張」；沒有贈品回傳空字串 */
export function giftLine(gifts: ComboGift[] | null | undefined, catalog: GiftItem[]) {
  return (gifts ?? [])
    .filter((g) => g.qty > 0)
    .map((g) => { const c = catalog.find((x) => x.id === g.giftId); return c && c.name.trim() ? `${c.name.trim()} ${g.qty} ${c.unit.trim()}` : ''; })
    .filter(Boolean).join('、');
}

/** 依認購單內容算每樣贈品要備幾個：Map<giftId, 數量> */
export function giftNeed(items: { kind: string; id: number; qty: number }[], combos: { id: number; gifts: ComboGift[] }[]) {
  const need = new Map<number, number>();
  for (const it of items) {
    if (it.kind !== 'combo') continue;
    const c = combos.find((x) => x.id === it.id);
    for (const g of c?.gifts ?? []) if (g.qty > 0) need.set(g.giftId, (need.get(g.giftId) ?? 0) + g.qty * it.qty);
  }
  return need;
}
