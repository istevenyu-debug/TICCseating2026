/**
 * 清除測試資料，回到未開賣：刪除劃位連結、訂單（預購單送出的）、劃位、入場紀錄、通知紀錄，座位全部釋放。
 * 保留：場次資料、票種與票價、組合票、席位用途（例如志工席）、連座分組、驗票門口、通知設定、後台帳號。
 * 可指定保留某些劃位連結（例如志工用連結訂下的座位），這些連結的劃位、座位與入場紀錄都不動。
 */
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 清除前預覽：目前有多少資料、每條連結訂了幾席 */
export async function resetPreview(db: Db) {
  const ev = await currentEvent(db);
  const links = await db.select().from(t.inviteLink).where(eq(t.inviteLink.eventId, ev.id)).orderBy(t.inviteLink.id);
  const seatsByLink = await db.select({ linkId: t.orders.linkId, n: sql<number>`count(*)::int` }).from(t.eventSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.eventSeat.orderId)).where(eq(t.eventSeat.eventId, ev.id)).groupBy(t.orders.linkId);
  const count = async (tb: typeof t.orders | typeof t.preorder | typeof t.checkin) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(tb).where(eq(tb.eventId, ev.id)))[0].n;
  const [{ occupied }] = await db.select({ occupied: sql<number>`count(*)::int` }).from(t.eventSeat)
    .where(and(eq(t.eventSeat.eventId, ev.id), sql`${t.eventSeat.status} <> 'free'`));
  const usages = await db.select({ name: t.seatUsage.name, sellable: t.seatUsage.sellable, n: sql<number>`count(${t.eventSeat.seatId})::int` })
    .from(t.seatUsage).leftJoin(t.eventSeat, eq(t.eventSeat.usageId, t.seatUsage.id))
    .where(eq(t.seatUsage.eventId, ev.id)).groupBy(t.seatUsage.id, t.seatUsage.name, t.seatUsage.sellable);
  return {
    links: links.filter((l) => l.kind !== 'public').map((l) => ({ id: l.id, code: l.code, name: l.name, note: l.note, seats: seatsByLink.find((s) => s.linkId === l.id)?.n ?? 0 })),
    linkCount: links.length, orders: await count(t.orders), preorders: await count(t.preorder), checkins: await count(t.checkin), occupied,
    reserved: usages.filter((u) => !u.sellable && u.n > 0).map((u) => ({ name: u.name, seats: u.n })),
    saleOpen: !!ev.published?.open, preorderOpen: ev.preorderOpen,
  };
}

export async function resetSales(db: Db, actor: string, o: { keepLinkIds?: number[]; close?: boolean }) {
  const ev = await currentEvent(db);
  const keep = [...new Set(o.keepLinkIds ?? [])];
  return db.transaction(async (tx) => {
    const linkCond = keep.length ? and(eq(t.inviteLink.eventId, ev.id), notInArray(t.inviteLink.id, keep)) : eq(t.inviteLink.eventId, ev.id);
    const links = (await tx.select({ id: t.inviteLink.id }).from(t.inviteLink).where(linkCond)).map((l) => l.id);
    const orders = links.length
      ? (await tx.select({ id: t.orders.id }).from(t.orders).where(and(eq(t.orders.eventId, ev.id), inArray(t.orders.linkId, links)))).map((x) => x.id)
      : [];

    // 正式環境已開立的電子發票不能直接清掉（要先作廢）；測試環境的發票不影響
    if (orders.length) {
      const prod = await tx.select({ id: t.invoice.id }).from(t.invoice)
        .where(and(inArray(t.invoice.orderId, orders), eq(t.invoice.env, 'prod'), eq(t.invoice.status, 'issued')));
      if (prod.length) throw new BookingError('EINVOICE', `有 ${prod.length} 張正式電子發票還沒作廢，不能清除。請到「六、劃位確認」逐筆刪除劃位（會自動作廢發票）。`);
    }
    let seats = 0;
    if (orders.length) {
      seats = (await tx.update(t.eventSeat).set({ status: 'free', orderId: null, holdUntil: null, version: sql`${t.eventSeat.version} + 1` })
        .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.orderId, orders))).returning({ id: t.eventSeat.seatId })).length;
      await tx.delete(t.checkin).where(and(eq(t.checkin.eventId, ev.id), inArray(t.checkin.orderId, orders)));
      await tx.delete(t.notification).where(inArray(t.notification.orderId, orders));
      await tx.delete(t.payment).where(inArray(t.payment.orderId, orders));
      await tx.delete(t.orderSeat).where(inArray(t.orderSeat.orderId, orders));
      await tx.delete(t.orders).where(inArray(t.orders.id, orders));
    }
    // 沒有對應訂單卻被佔住的座位（理論上不會有）也一併釋放
    await tx.update(t.eventSeat).set({ status: 'free', holdUntil: null }).where(and(eq(t.eventSeat.eventId, ev.id), isNull(t.eventSeat.orderId), sql`${t.eventSeat.status} <> 'free'`));

    // 訂單（預購單送出的）：保留連結對應的那幾張，其他全刪
    const pre = await tx.delete(t.preorder).where(and(eq(t.preorder.eventId, ev.id),
      keep.length ? or(isNull(t.preorder.linkId), notInArray(t.preorder.linkId, keep)) : sql`true`)).returning({ id: t.preorder.id });
    if (links.length) {
      await tx.delete(t.notification).where(inArray(t.notification.linkId, links));
      await tx.delete(t.pushSub).where(inArray(t.pushSub.linkId, links));
      await tx.delete(t.inviteLink).where(inArray(t.inviteLink.id, links));
    }
    // 沒有歸屬的通知紀錄（例：收到訂單確認信）
    await tx.delete(t.notification).where(and(isNull(t.notification.orderId), isNull(t.notification.linkId)));

    if (o.close) {
      await tx.update(t.event).set({
        saleOpen: false, preorderOpen: false,
        published: ev.published ? { ...ev.published, open: false, at: new Date().toISOString() } : ev.published,
      }).where(eq(t.event.id, ev.id));
    }
    const result = { links: links.length, orders: orders.length, seats, preorders: pre.length, kept: keep.length, closed: !!o.close };
    await tx.insert(t.auditLog).values({ actor, action: 'reset_sales', target: `event:${ev.id}`, detail: JSON.stringify(result) });
    return result;
  });
}
