import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { checkMac, ECPAY_PAY_TEST, handleGatewayResult, cardStatus, floor3State } from '@/lib/card';
import { createCardLink, createLinkOrder, linkMenu, listCardLinks, policyText, stock2M, updateCardLink } from '@/lib/cardLink';
import { ensureFloor3 } from '@/lib/floor';

const T0 = new Date('2026-11-15T12:00:00+08:00');
const SHOW = new Date('2026-12-09T19:30:00+08:00');
const ORIGIN = 'https://ticket.example.com';
let db: Db; let evId: number; let comboId: number; let zA: number; let zB: number;
const buyer = { name: '王大明', phone: '0912345678', email: 'b@example.com', invType: 'member', invCode: '', invTitle: '', agree: true };

function gw(tradeNo: string, amount: number) {
  const f: Record<string, string> = { MerchantID: ECPAY_PAY_TEST.merchantId, MerchantTradeNo: tradeNo, RtnCode: '1', RtnMsg: '交易成功', TradeNo: '2611151200000001', TradeAmt: String(amount), PaymentDate: '2026/11/15 12:01:00', PaymentType: 'Credit_CreditCard', SimulatePaid: '0' };
  f.CheckMacValue = checkMac(f, ECPAY_PAY_TEST.hashKey, ECPAY_PAY_TEST.hashIV);
  return f;
}
const freeIn = async (zoneId: number, n: number) => (await db.select({ id: t.eventSeat.seatId }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
  .where(and(eq(t.eventSeat.eventId, evId), eq(t.eventSeat.zoneId, zoneId), eq(t.eventSeat.status, 'free'), eq(t.venueSeat.floor, '2M'), sql`coalesce(${t.eventSeat.bundle}, '') = ''`, eq(t.venueSeat.seatType, 'normal')))).slice(0, n).map((x) => x.id);

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '萬變中', showAt: SHOW, vipInstalled: false, holdMinutes: 60 });
  evId = ev.id;
  await ensureFloor3(db);
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, evId));
  zA = zones.find((z) => z.name === 'A區')!.id; zB = zones.find((z) => z.name === 'B區')!.id;
  const c = await A.createCombo(db, 'admin');
  await A.updateCombo(db, 'admin', c.id, { name: '刷卡 A2B1', price: 9000, items: [{ zoneId: zA, qty: 2 }, { zoneId: zB, qty: 1 }], hidden: true });
  comboId = c.id;
  // 2M 公開販售關閉：刷卡連結仍然能買、能劃
  await A.updateEventSettings(db, 'admin', { saleOpen: false });
  await A.publish(db, 'admin', T0);
});

async function pay(code: string, qty = 1, now = T0) {
  const r = await createLinkOrder(db, code, { ...buyer, items: [{ id: comboId, qty }] }, ORIGIN, now);
  const amount = Number(r.fields.TotalAmount);
  const res = await handleGatewayResult(db, gw(r.fields.MerchantTradeNo, amount), 'return', now);
  return { ...r, amount, tradeNo: r.fields.MerchantTradeNo, pickCode: res.code! };
}

describe('2M 刷卡專屬連結', () => {
  it('建立連結；只能選 2M 有價格的組合；退票規則可每條不同', async () => {
    await expect(createCardLink(db, 'admin', { comboIds: [] })).rejects.toThrow('至少');
    const three = (await db.select().from(t.combo).where(eq(t.combo.floor, '3F')))[0];
    await expect(createCardLink(db, 'admin', { comboIds: [three.id] })).rejects.toThrow('2M');
    const { code } = await createCardLink(db, 'admin', { name: '某公司', comboIds: [comboId], maxSets: 3 });
    const m = await linkMenu(db, code, T0);
    expect(m.items.map((i) => [i.name, i.price, i.seats])).toEqual([['刷卡 A2B1', 9000, 3]]);
    expect(m.terms).toContain('恕不退票，但可轉讓');
    expect(m.terms).toContain('12/6');
    expect(policyText({ policy: 'refund', transferDays: 3, refundDays: 10, refundFeePct: 10 }, SHOW)).toContain('11/29');
    expect(m.room).toBe(3);
  });

  it('刷卡 → 付款成功 → 劃位送出就成功（不用後台確認），2M 關閉也能劃', async () => {
    const { code } = await createCardLink(db, 'admin', { comboIds: [comboId] });
    const p = await pay(code, 2);
    expect(p.tradeNo.startsWith('2M')).toBe(true);
    expect(p.amount).toBe(18000);
    const [co] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.tradeNo, p.tradeNo));
    expect(co.terms).toContain('可轉讓');
    const [link] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, p.pickCode));
    expect([link.floor, link.paidCard]).toEqual(['2M', true]);
    const mail = (await db.select().from(t.notification).where(eq(t.notification.linkId, link.id)))[0];
    expect(mail.content).toContain('退票與轉讓');
    expect((await cardStatus(db, co.token, T0)).back).toBe(`/c/${code}`);
    // 劃位：只能劃付了錢的方案與組數
    const st = await getBookingState(db, p.pickCode, T0);
    expect(st.sale).toBe('open');
    const seats = [...await freeIn(zA, 4), ...await freeIn(zB, 2)];
    const h = await holdSeats(db, p.pickCode, seats, comboId, T0);
    const r = await submitOrder(db, p.pickCode, { orderId: h.orderId, buyer: { name: buyer.name, phone: buyer.phone, email: buyer.email }, holders: seats.map((s) => ({ seatId: s, name: '王大明', id4: '' })), agree: true }, T0);
    expect(r.orderNo).toBeTruthy();
    const [o] = await db.select().from(t.orders).where(eq(t.orders.id, h.orderId));
    expect(o.status).toBe('paid'); // 直接成功、有 QR
    await expect(holdSeats(db, p.pickCode, await freeIn(zA, 2).then(async (a) => [...a, ...await freeIn(zB, 1)]), comboId, T0)).rejects.toThrow();
  });

  it('不超賣：付款中先佔、已付未劃也扣；上限組數；停用的連結不能買', async () => {
    const { code, id } = await createCardLink(db, 'admin', { comboIds: [comboId], maxSets: 2 });
    const before = (await stock2M(db, evId, T0))[comboId];
    await createLinkOrder(db, code, { ...buyer, items: [{ id: comboId, qty: 1 }] }, ORIGIN, T0); // 付款中
    expect((await stock2M(db, evId, T0))[comboId]).toBe(before - 1);
    await expect(createLinkOrder(db, code, { ...buyer, items: [{ id: comboId, qty: 3 }] }, ORIGIN, T0)).rejects.toThrow('還可以買 2 組'); // 重按付款：舊的放掉
    await pay(code, 2);
    expect((await stock2M(db, evId, T0))[comboId]).toBe(before - 2); // 已付未劃
    await expect(createLinkOrder(db, code, { ...buyer, items: [{ id: comboId, qty: 1 }] }, ORIGIN, T0)).rejects.toThrow('用完');
    await updateCardLink(db, 'admin', id, { active: false });
    await expect(linkMenu(db, code, T0)).rejects.toThrow('停用');
    const l = await listCardLinks(db, T0);
    expect(l!.links[0]).toMatchObject({ paid: 1, sets: 2, revenue: 18000, active: false });
  });

  it('三樓統計不算 2M 刷卡；沒勾同意不能付款', async () => {
    const { code } = await createCardLink(db, 'admin', { comboIds: [comboId] });
    await expect(createLinkOrder(db, code, { ...buyer, agree: false, items: [{ id: comboId, qty: 1 }] }, ORIGIN, T0)).rejects.toThrow('同意');
    await pay(code, 1);
    const f3 = await floor3State(db, T0);
    expect(f3!.stats.orders).toBe(0);
    expect(f3!.orders).toHaveLength(1); // 清單裡看得到（可退款、查詢）
  });
});
