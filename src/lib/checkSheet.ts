/**
 * 驗票打勾圖（11/20）：依 TICC 座位實際位置畫圖，門口人工打勾用。
 * 7 張：2M 第 1–3 排；2M 第 4–12 排 各區一張（左側、左、中、右、右側）；三樓銀區極左右（揪團贈席）。
 * 只有持本系統 QR 的座位有 ☐（已入場的印 ✓）；同一位買方（三樓：同一群）相鄰的座位框成一組、標一個名字。
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { ticketData } from './admin';
import { giftCheckRows } from './joinGift';

type Kind = 'qr' | 'paper' | 'none';
export interface SheetSeat { id: string; x: number; y: number; rowNo: number | null; seatNo: string; kind: Kind; key: string; name: string; entered: boolean }
export interface Sheet { key: string; title: string; seats: SheetSeat[]; minX: number; maxX: number; qr: number; entered: number }

const BLOCK_NAME: Record<string, string> = { L2: '左側區', L1: '左區', C0: '中區', R1: '右區', R2: '右側區' };

export async function checkSheets(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  const seats = await db.select().from(t.venueSeat);
  const info = new Map<string, { kind: Kind; key: string; name: string; entered: boolean }>();
  const used = new Set((await db.select({ serial: t.checkin.serial }).from(t.checkin).where(eq(t.checkin.eventId, ev.id))).map((r) => r.serial));

  // 2M：已付款訂單（含招待、買五送一、刷卡）＝本系統 QR
  const paid = await db.select({ id: t.orders.id, buyer: t.orders.buyerName }).from(t.orders).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  const { tickets } = await ticketData(db, paid.map((o) => o.id));
  for (const tk of tickets) {
    info.set(tk.seatId, { kind: 'qr', key: `o${tk.orderId}`, name: paid.find((o) => o.id === tk.orderId)?.buyer ?? '', entered: used.has(tk.serial) });
  }
  // 三樓：揪團贈席（選 QR 的有 ☐；紙本的標「紙」）
  const byCode = new Map(seats.map((s) => [s.code, s.id]));
  for (const g of await giftCheckRows(db, ev.id)) {
    const id = byCode.get(g.code);
    if (!id) continue;
    info.set(id, { kind: g.serial ? 'qr' : g.paper && g.paper !== '尚未選擇' ? 'paper' : 'none', key: `g${g.group}`, name: g.group, entered: !!g.serial && used.has(g.serial) });
  }

  const mk = (key: string, title: string, pick: (s: typeof seats[number]) => boolean): Sheet => {
    const list = seats.filter(pick).map((s) => {
      const i = info.get(s.id);
      return { id: s.id, x: s.x, y: s.y, rowNo: s.rowNo, seatNo: s.seatNo, kind: i?.kind ?? 'none', key: i?.key ?? '', name: i?.name ?? '', entered: i?.entered ?? false } as SheetSeat;
    });
    return {
      key, title, seats: list, minX: Math.min(...list.map((s) => s.x)), maxX: Math.max(...list.map((s) => s.x)),
      qr: list.filter((s) => s.kind === 'qr').length, entered: list.filter((s) => s.kind === 'qr' && s.entered).length,
    };
  };
  const front = (s: typeof seats[number]) => s.floor === '2M' && s.y <= 4 && (s.block === 'L1' || s.block === 'C0' || s.block === 'R1');
  const sheets: Sheet[] = [mk('2m-1', '2M 第 1–3 排（含 VIP 排）', front)];
  for (const b of ['L2', 'L1', 'C0', 'R1', 'R2']) sheets.push(mk(`2m-${b}`, `2M 第 4–12 排・${BLOCK_NAME[b]}`, (s) => s.floor === '2M' && s.block === b && !front(s)));
  sheets.push(mk('3f', '三樓銀區・極左（左側區）＋極右（右側區）', (s) => s.floor === '3F' && (s.block === 'L2' || s.block === 'R2')));
  return { event: { name: ev.name, showAt: ev.showAt.toISOString() }, sheets: sheets.filter((s) => s.seats.length) };
}
