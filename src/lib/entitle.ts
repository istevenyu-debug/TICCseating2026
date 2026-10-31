/**
 * 已付款可劃的內容（純函式，前後端共用）：
 * 由訂單（預購單）收款確認後產生的劃位連結，只能劃「付了錢的」組合與張數。
 * 例：付 功德組 × 2 → 只能用功德組劃 2 組；單張 金區 × 3 → 只能劃 3 張金區。
 */
export interface PaidItem { kind: 'combo' | 'zone'; id: number; name: string; qty: number }
export interface UsedOrder { comboId: number; sets: number; isSingle: boolean; zoneIds: number[] }
export interface EntRow { kind: 'combo' | 'zone'; id: number; name: string; unit: string; qty: number; used: number; left: number }

export function entitle(items: PaidItem[], orders: UsedOrder[]) {
  const rows: EntRow[] = items.map((i) => {
    const used = i.kind === 'combo'
      ? orders.filter((o) => !o.isSingle && o.comboId === i.id).reduce((a, o) => a + o.sets, 0)
      : orders.filter((o) => o.isSingle).reduce((a, o) => a + o.zoneIds.filter((z) => z === i.id).length, 0);
    return { kind: i.kind, id: i.id, name: i.name, unit: i.kind === 'combo' ? '組' : '張', qty: i.qty, used, left: i.qty - used };
  });
  // 劃了沒付錢的內容（理論上不會發生；舊資料或規則改過時，後台標紅）
  const extra = orders.some((o) => o.isSingle
    ? o.zoneIds.some((z) => !items.some((i) => i.kind === 'zone' && i.id === z))
    : !items.some((i) => i.kind === 'combo' && i.id === o.comboId));
  return { rows, over: extra || rows.some((r) => r.left < 0), done: rows.every((r) => r.left <= 0) };
}

/** 白話：「功德組：已付 1 組，已劃 0 組（還沒劃）」；劃完顯示「✅ 已劃完」 */
export const entText = (rows: EntRow[]) => rows.map((r) => `${r.name}：已付 ${r.qty} ${r.unit}，${r.used >= r.qty ? '✅ 已劃完' : r.used === 0 ? `已劃 0 ${r.unit}（還沒劃）` : `已劃 ${r.used} ${r.unit}（還差 ${r.qty - r.used}）`}${r.used > r.qty ? `　⚠ 多劃了 ${r.used - r.qty}` : ''}`).join('；');
