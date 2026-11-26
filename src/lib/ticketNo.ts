/** 票號（序號末兩碼）的共用規則：入場券、劃位頁、驗票都用同一套 */
/**
 * 票號（序號末兩碼）：有固定票號（換過座位的訂單）就用固定的；沒有就照座位位置（前排、左邊先）排。
 * rows 要先照座位位置排好（y、x）。
 */
export function ticketNumbers(rows: { orderId: number; seatId: string; ticketNo: number | null }[]) {
  const out = new Map<string, number>();
  const byOrder = new Map<number, typeof rows>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  for (const [oid, list] of byOrder) {
    const fixed = list.every((r) => r.ticketNo != null);
    list.forEach((r, i) => out.set(`${oid}|${r.seatId}`, fixed ? r.ticketNo! : i + 1));
  }
  return out;
}
/** 依票號排（同一筆訂單內），訂單之間維持原本順序 */
export function sortByTicketNo<T extends { orderId: number; seatId: string }>(rows: T[], nos: Map<string, number>) {
  const firstIdx = new Map<number, number>();
  rows.forEach((r, i) => { if (!firstIdx.has(r.orderId)) firstIdx.set(r.orderId, i); });
  return [...rows].sort((a, b) => firstIdx.get(a.orderId)! - firstIdx.get(b.orderId)! || nos.get(`${a.orderId}|${a.seatId}`)! - nos.get(`${b.orderId}|${b.seatId}`)!);
}

