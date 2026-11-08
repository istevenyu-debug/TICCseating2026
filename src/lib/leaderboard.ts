/** 風雲榜：依認購組數排名（純函式，後台畫圖用） */
export type LbOrder = { name: string; status: string; paidOkAt: string | null; seq: number | null; items: { kind: string; id: number; qty: number }[] };
export type LbRow = { rank: number; name: string; sets: number };

/** comboIds：要計入的方案；paidOnly：只算已勾「已匯款」。同名（去空白）合併；同組數同名次，先登記的排前面 */
export function leaderboard(orders: LbOrder[], comboIds: number[], paidOnly = true): LbRow[] {
  const want = new Set(comboIds);
  const m = new Map<string, { name: string; sets: number; first: number }>();
  for (const o of orders) {
    if (o.status === 'cancelled' || (paidOnly && !o.paidOkAt)) continue;
    const sets = o.items.filter((i) => i.kind === 'combo' && want.has(i.id)).reduce((a, i) => a + i.qty, 0);
    if (!sets) continue;
    const key = o.name.replace(/\s+/g, '');
    if (!key) continue;
    const cur = m.get(key) ?? { name: o.name.trim(), sets: 0, first: Infinity };
    cur.sets += sets; cur.first = Math.min(cur.first, o.seq ?? 1e9);
    m.set(key, cur);
  }
  const list = [...m.values()].sort((a, b) => b.sets - a.sets || a.first - b.first);
  let rank = 0;
  return list.map((x, i) => { if (i === 0 || x.sets !== list[i - 1].sets) rank = i + 1; return { rank, name: x.name, sets: x.sets }; });
}
