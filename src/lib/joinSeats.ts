/**
 * 各群座位（只給系統管理員）：每一群「買的年代座位」＋「贈席座位」。
 * 買的座位＝這群已核對回報的年代訂單編號 → 年代售出明細裡那幾張票的樓層／排／號。
 * 只算已核對（ok）的回報；哪 6 張換到哪一席贈票沒有記錄，所以只列整群的。
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { giftAdminState } from './joinGift';

const num = (s: string) => parseInt(String(s).replace(/\D/g, ''), 10) || 0;

export async function groupSeatsExport(db: Db, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return { groups: [], seats: [] };
  const regs = await db.select().from(t.joinReg).where(and(eq(t.joinReg.eventId, ev.id), eq(t.joinReg.status, 'approved')));
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  const gname = (r: typeof regs[number]) => (r.venueId ? vs.find((v) => v.id === r.venueId)?.name ?? r.venueText : r.venueText);
  const reps = await db.select().from(t.joinReport).where(and(eq(t.joinReport.eventId, ev.id), eq(t.joinReport.status, 'ok')));
  const orderNos = [...new Set(reps.map((r) => r.orderNo).filter((x): x is string => !!x))];
  const tix = orderNos.length ? await db.select().from(t.joinEraTicket).where(and(eq(t.joinEraTicket.eventId, ev.id), inArray(t.joinEraTicket.orderNo, orderNos))) : [];
  const slots = await db.select().from(t.joinSlot).where(eq(t.joinSlot.eventId, ev.id));
  const gift = await giftAdminState(db, '', now);
  const optName = (k: string) => gift.settings.options.find((o) => o.key === k)?.name ?? '';

  type SeatRow = { group: string; kind: '買的' | '贈席'; floor: string; row: string; seat: string; orderNo: string; who: string; note: string };
  const seats: SeatRow[] = [];
  const groups = regs.map((r) => {
    const g = gname(r);
    const mine = reps.filter((x) => x.regId === r.id);
    const bought = mine.flatMap((rep) => tix.filter((x) => x.orderNo === rep.orderNo).map((x) => ({ x, rep })))
      .sort((a, b) => a.x.floor.localeCompare(b.x.floor) || num(a.x.rowNo) - num(b.x.rowNo) || num(a.x.seatNo) - num(b.x.seatNo));
    for (const { x, rep } of bought) seats.push({ group: g, kind: '買的', floor: x.floor, row: x.rowNo, seat: x.seatNo, orderNo: x.orderNo, who: rep.reporter, note: x.status === 'sold' ? '' : '已退票' });
    const gs = gift.seats.filter((x) => x.regId === r.id).sort((a, b) => (a.rowNo ?? 0) - (b.rowNo ?? 0) || num(a.seatNo) - num(b.seatNo));
    for (const x of gs) seats.push({ group: g, kind: '贈席', floor: '3樓', row: x.rowNo != null ? `${x.rowNo}排` : '', seat: `${x.seatNo}號`, orderNo: `劃位序 ${x.no}`, who: x.name, note: x.effectiveKey ? `${optName(x.effectiveKey)}${x.defaulted ? '（逾期預設）' : ''}` : '尚未選擇取票方式' });
    const live = bought.filter(({ x }) => x.status === 'sold');
    return {
      group: g, headName: r.headName, headPhone: r.headPhone, email: r.email,
      okQty: mine.reduce((a, x) => a + x.qty, 0), eraQty: live.length,
      slots: slots.filter((s) => s.regId === r.id && s.status !== 'void').length,
      bought: live.map(({ x }) => `${x.floor}${x.rowNo}${x.seatNo}`).join('、'),
      gift: gs.map((x) => x.label).join('、'),
      giftHow: [...new Set(gs.map((x) => (x.effectiveKey ? optName(x.effectiveKey) : '尚未選擇')))].join('、'),
    };
  }).filter((g) => g.okQty || g.slots).sort((a, b) => a.group.localeCompare(b.group, 'zh-Hant'));
  seats.sort((a, b) => a.group.localeCompare(b.group, 'zh-Hant') || (a.kind === b.kind ? 0 : a.kind === '買的' ? -1 : 1));
  return { groups, seats };
}
