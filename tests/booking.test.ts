import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue, setUsage } from '@/db/seed';
import * as t from '@/db/schema';
import { BookingError, getBookingState, holdSeats, releaseHold, submitOrder } from '@/lib/booking';
import { buildSeats } from '@/lib/layout';
import * as A from '@/lib/admin';

const T0 = new Date('2026-11-15T10:00:00+08:00');
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const EXP = new Date('2026-12-10T23:59:59+08:00');

let db: Db;
let eventId: number;
let combo: Record<string, number>;
let zone: Record<string, number>;

async function setup() {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '測試場次', showAt: new Date('2026-12-20T19:30:00+08:00'), vipInstalled: false });
  eventId = ev.id;
  // vipInstalled:false 需重新發布不影響；VIP 座位因未加裝不可訂
  combo = Object.fromEntries((await db.select().from(t.combo)).map((c) => [c.name, c.id]));
  zone = Object.fromEntries((await db.select().from(t.priceZone)).map((z) => [z.name, z.id]));
  await createLink(db, { eventId, code: 'AAA111', name: '甲', phone: '0911111111', quota: 6, expiresAt: EXP });
  await createLink(db, { eventId, code: 'BBB222', name: '乙', phone: '0922222222', quota: 4, expiresAt: EXP });
}

const SINGLE = () => combo['單張購票'];

const submitBody = (orderId: number, seatIds: string[], amount: number) => ({
  orderId,
  buyer: { name: '甲', phone: '0911-111-111', email: 'a@example.com' },
  holders: seatIds.map((s, i) => ({ seatId: s, name: `持票人${i}`, id4: '12a4' })),
  transfer: { last5: '12345', amount, time: '2026-11-15 10:05' },
  agree: true,
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof BookingError && e.code === code);
}

describe('座位模板', () => {
  it('第 1–12 排共 484 席，另有 VIP 21 席、輪椅席 16 席', () => {
    const seats = buildSeats();
    expect(seats.filter((s) => s.seatType === 'normal')).toHaveLength(484);
    expect(seats.filter((s) => s.seatType === 'vip')).toHaveLength(21);
    expect(seats.filter((s) => s.seatType === 'wheelchair')).toHaveLength(16);
    expect(new Set(seats.map((s) => s.id)).size).toBe(seats.length);
    expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(seats.length);
  });
  it('座位編號為 排-席次-區，且不重複', () => {
    const seats = buildSeats();
    const byId = Object.fromEntries(seats.map((s) => [s.id, s.code]));
    expect(byId['3-15']).toBe('03-15-L1');
    expect(byId['3-2']).toBe('03-02-C0');
    expect(byId['12-34']).toBe('12-34-R1');
    expect(byId['5-35']).toBe('05-35-L2');
    expect(byId['5-36']).toBe('05-36-R2');
    expect(byId['V-7']).toBe('V-07-C0');
    expect(byId['W-H11']).toBe('WC-H11-L2');
    expect(new Set(seats.map((s) => s.code)).size).toBe(seats.length);
  });
});

describe('購票端', () => {
  beforeEach(setup);

  it('兩人同時搶同一座位，只有一人成功', async () => {
    const r = await Promise.allSettled([
      holdSeats(db, 'AAA111', ['3-1', '3-2'], SINGLE(), T0),
      holdSeats(db, 'BBB222', ['3-2', '3-4'], SINGLE(), T0),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const bad = r.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect((bad[0].reason as BookingError).code).toBe('SEAT_TAKEN');
    const held = await db.select().from(t.eventSeat).where(eq(t.eventSeat.status, 'held'));
    expect(held).toHaveLength(2);
  });

  it('暫存 20 分鐘後自動釋放', async () => {
    await holdSeats(db, 'AAA111', ['5-11'], SINGLE(), T0);
    let s = await getBookingState(db, 'BBB222', min(19));
    expect(s.seats.find((x) => x.id === '5-11')!.status).toBe('held');
    s = await getBookingState(db, 'BBB222', min(21));
    expect(s.seats.find((x) => x.id === '5-11')!.status).toBe('free');
  });

  it('暫存者看到自己的座位為 mine，可放棄釋放', async () => {
    await holdSeats(db, 'AAA111', ['2-1'], SINGLE(), T0);
    let s = await getBookingState(db, 'AAA111', T0);
    expect(s.seats.find((x) => x.id === '2-1')!.status).toBe('mine');
    await releaseHold(db, 'AAA111', T0);
    s = await getBookingState(db, 'AAA111', T0);
    expect(s.held).toBeNull();
    expect(s.seats.find((x) => x.id === '2-1')!.status).toBe('free');
  });

  it('組合票「買一A送二B」：須剛好 A 區 1 張＋B 區 2 張，金額為套票價', async () => {
    const id = combo['買一A送二B'];
    await expectCode(holdSeats(db, 'AAA111', ['3-1', '3-2', '3-4'], id, T0), 'COMBO'); // 三張都是 A
    await expectCode(holdSeats(db, 'AAA111', ['3-1', '8-11'], id, T0), 'COMBO'); // 張數不足
    const r = await holdSeats(db, 'AAA111', ['3-1', '8-11', '8-13'], id, T0);
    expect(r.amount).toBe(3200);
    const units = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, r.orderId));
    expect(units.reduce((a, u) => a + u.unitPrice, 0)).toBe(3200);
  });

  it('組合票可買多組：金額為套票價 × 組數，張數須為整組倍數', async () => {
    const id = combo['買一A送二B'];
    await expectCode(holdSeats(db, 'AAA111', ['3-1', '3-2', '8-11', '8-13', '8-15'], id, T0), 'COMBO'); // A×2＋B×3 不成組
    const r = await holdSeats(db, 'AAA111', ['3-1', '3-2', '8-11', '8-13', '8-15', '8-17'], id, T0); // A×2＋B×4 = 2 組
    expect(r.amount).toBe(6400);
    const [o] = await db.select().from(t.orders).where(eq(t.orders.id, r.orderId));
    expect(o.sets).toBe(2);
  });

  it('不可訂保留席與未加裝的 VIP 排', async () => {
    await setUsage(db, eventId, 'hold-pr', ['6-1']);
    await expectCode(holdSeats(db, 'AAA111', ['6-1'], SINGLE(), T0), 'SEAT_UNAVAILABLE');
    await expectCode(holdSeats(db, 'AAA111', ['V-1'], SINGLE(), T0), 'SEAT_UNAVAILABLE');
  });

  it('張數上限：連結可購張數跨訂單累計', async () => {
    const h = await holdSeats(db, 'BBB222', ['4-1', '4-2', '4-3'], SINGLE(), T0);
    await submitOrder(db, 'BBB222', submitBody(h.orderId, ['4-1', '4-2', '4-3'], h.amount), min(5));
    await expectCode(holdSeats(db, 'BBB222', ['4-4', '4-5'], SINGLE(), min(6)), 'QUOTA');
    await expect(holdSeats(db, 'BBB222', ['4-4'], SINGLE(), min(6))).resolves.toBeTruthy();
  });

  it('送出後 48 小時未確認到帳自動取消並通知', async () => {
    const h = await holdSeats(db, 'AAA111', ['7-1', '7-2'], SINGLE(), T0);
    await submitOrder(db, 'AAA111', submitBody(h.orderId, ['7-1', '7-2'], h.amount), min(10));
    let s = await getBookingState(db, 'BBB222', min(11));
    expect(s.seats.find((x) => x.id === '7-1')!.status).toBe('pending');
    s = await getBookingState(db, 'BBB222', min(10 + 48 * 60 + 1));
    expect(s.seats.find((x) => x.id === '7-1')!.status).toBe('free');
    const n = await db.select().from(t.notification).where(eq(t.notification.template, 'order_expired'));
    expect(n).toHaveLength(2);
  });

  it('暫存逾時後不可送出；欄位驗證', async () => {
    const h = await holdSeats(db, 'AAA111', ['9-1'], SINGLE(), T0);
    const bad = submitBody(h.orderId, ['9-1'], h.amount);
    bad.holders[0].id4 = '12';
    await expectCode(submitOrder(db, 'AAA111', bad, min(1)), 'INVALID');
    await expectCode(submitOrder(db, 'AAA111', submitBody(h.orderId, ['9-1'], h.amount), min(25)), 'HOLD_EXPIRED');
  });

  it('過期或停用的連結無法使用', async () => {
    await expectCode(getBookingState(db, 'AAA111', new Date('2026-12-11T00:00:00+08:00')), 'LINK_EXPIRED');
    await db.update(t.inviteLink).set({ status: 'disabled' }).where(eq(t.inviteLink.code, 'BBB222'));
    await expectCode(getBookingState(db, 'BBB222', T0), 'LINK_DISABLED');
    await expectCode(getBookingState(db, 'NOPE00', T0), 'LINK_NOT_FOUND');
  });
});

describe('後台', () => {
  beforeEach(setup);
  const who = 'tester';

  it('勾選後未發布前，購票端不受影響；發布後才生效', async () => {
    await A.updateZone(db, who, zone['C區（側區）'], { open: false });
    await A.updateCombo(db, who, combo['親子四人套票'], { active: false });
    let s = await getBookingState(db, 'AAA111', T0);
    expect(s.seats.find((x) => x.id === '5-35')!.status).toBe('free');
    expect(s.combos.some((c) => c.name === '親子四人套票')).toBe(true);
    expect((await A.getAdminState(db, T0)).dirty).toBe(true);

    await A.publish(db, who, T0);
    s = await getBookingState(db, 'AAA111', T0);
    expect(s.seats.find((x) => x.id === '5-35')!.status).toBe('blocked');
    expect(s.combos.some((c) => c.name === '親子四人套票')).toBe(false);
    await expectCode(holdSeats(db, 'AAA111', ['5-35'], SINGLE(), T0), 'SEAT_UNAVAILABLE');
    expect((await A.getAdminState(db, T0)).dirty).toBe(false);
  });

  it('總開關關閉並發布後，購票端顯示未開放', async () => {
    await A.updateEventSettings(db, who, { saleOpen: false });
    await A.publish(db, who, T0);
    expect((await getBookingState(db, 'AAA111', T0)).sale).toBe('closed');
    await expectCode(holdSeats(db, 'AAA111', ['3-1'], SINGLE(), T0), 'SALE_CLOSED');
  });

  it('發布前檢查：開放的票種要有名稱與票價', async () => {
    await A.createZone(db, who);
    await expectCode(A.publish(db, who, T0), 'INVALID');
  });

  it('新增票種、依排數與區塊指定座位，已有訂單的座位不變', async () => {
    const z = await A.createZone(db, who);
    await A.updateZone(db, who, z.id, { name: '學生票', price: 1500, color: '#c0392b' });
    await holdSeats(db, 'AAA111', ['10-1'], SINGLE(), T0);
    const r = await A.assignZoneByRule(db, who, z.id, [10, 11, 12], ['L1', 'C0', 'R1']);
    expect(r).toEqual({ updated: 101, skipped: 1 });
    const all = await A.assignZoneByRule(db, who, z.id, [7], []);
    expect(all.updated).toBe(42); // 第 7 排全部區塊：12+10+12+4+4
    await A.publish(db, who, T0);
    const s = await getBookingState(db, 'BBB222', T0);
    expect(s.zones.find((x) => x.name === '學生票')?.price).toBe(1500);
    expect(s.seats.find((x) => x.id === '11-1')!.zoneId).toBe(z.id);
  });

  it('刪除票種前需先移走座位與組合使用', async () => {
    await expectCode(A.deleteZone(db, who, zone['A區']), 'BUSY');
    const z = await A.createZone(db, who);
    await A.deleteZone(db, who, z.id);
  });

  it('自訂組合票內容與價格', async () => {
    const c = await A.createCombo(db, who);
    await A.updateCombo(db, who, c.id, { name: '學生雙人', price: 2800, items: [{ zoneId: zone['B區'], qty: 2 }] });
    await A.publish(db, who, T0);
    const r = await holdSeats(db, 'AAA111', ['8-11', '8-13'], c.id, T0);
    expect(r.amount).toBe(2800);
  });

  it('完整流程：暫存出現在後台 → 送出成為新訂單 → 確認到帳 → 消費者收到劃位成功', async () => {
    const h = await holdSeats(db, 'AAA111', ['2-1', '2-2'], SINGLE(), T0);
    let st = await A.getAdminState(db, min(1));
    expect(st.orders[0]).toMatchObject({ status: 'held', isNew: false });
    expect(st.stats.held).toBe(2);

    await submitOrder(db, 'AAA111', submitBody(h.orderId, ['2-1', '2-2'], h.amount), min(5));
    st = await A.getAdminState(db, min(6));
    expect(st.orders[0]).toMatchObject({ status: 'pending', isNew: true });
    expect(st.stats.newOrders).toBe(1);

    await A.confirmPayment(db, who, h.orderId, { date: '2026-11-15', amount: h.amount }, min(30));
    st = await A.getAdminState(db, min(31));
    expect(st.orders[0].status).toBe('paid');
    expect(st.stats.sold).toBe(2);
    expect(st.stats.newOrders).toBe(0);

    const buyer = await getBookingState(db, 'AAA111', min(31));
    expect(buyer.orders[0].status).toBe('paid');
    expect(buyer.orders[0].seats.map((x) => x.serial)).toEqual([`${buyer.orders[0].orderNo}-01`, `${buyer.orders[0].orderNo}-02`]);
    expect(buyer.orders[0].seats[0].holderId4).toBe('12A4');
    expect(buyer.inbox[0].content).toContain('劃位成功');
    expect(buyer.inbox[0].content).toContain('02-01-C0');

    const tk = await A.ticketData(db, [h.orderId]);
    expect(tk.tickets.map((x) => x.code)).toEqual(['02-01-C0', '02-02-C0']);
  });

  it('取消與刪除訂單會釋放座位', async () => {
    const h = await holdSeats(db, 'AAA111', ['2-5'], SINGLE(), T0);
    await A.cancelOrder(db, who, h.orderId);
    expect((await getBookingState(db, 'BBB222', T0)).seats.find((x) => x.id === '2-5')!.status).toBe('free');
    const h2 = await holdSeats(db, 'AAA111', ['2-7'], SINGLE(), min(1));
    await submitOrder(db, 'AAA111', submitBody(h2.orderId, ['2-7'], h2.amount), min(2));
    await A.deleteOrder(db, who, h2.orderId);
    expect((await getBookingState(db, 'BBB222', min(3))).seats.find((x) => x.id === '2-7')!.status).toBe('free');
    expect((await A.getAdminState(db, min(3))).orders.find((o) => o.id === h2.orderId)).toBeUndefined();
  });

  it('席位用途：設為保留後購票端不可選', async () => {
    const st = await A.getAdminState(db, T0);
    const pr = st.usages.find((u) => u.code === 'hold-pr')!;
    await A.setSeatUsage(db, who, pr.id, ['9-1', '9-3']);
    expect((await getBookingState(db, 'AAA111', T0)).seats.find((x) => x.id === '9-1')!.status).toBe('blocked');
  });

  it('專屬連結：產生 8 碼代碼並排入簡訊', async () => {
    const l = await A.createInviteLink(db, who, { name: '丙', phone: '0933333333', quota: 2, expiresAt: EXP });
    expect(l.code).toMatch(/^[A-Z2-9]{8}$/);
    const s = await getBookingState(db, l.code, T0);
    expect(s.link.quota).toBe(2);
  });
});

describe('公開連結（先專屬、再公開）', () => {
  beforeEach(setup);
  const who = 'tester';
  const VA = 'visitorAAAAAAAAAAAAAA';
  const VB = 'visitorBBBBBBBBBBBBBB';

  it('同一條公開連結，不同訪客各自暫存，互不取消', async () => {
    const pub = await A.createPublicLink(db, who);
    await holdSeats(db, pub.code, ['3-1'], SINGLE(), T0, VA);
    await holdSeats(db, pub.code, ['3-2'], SINGLE(), T0, VB);
    const a = await getBookingState(db, pub.code, T0, VA);
    const b = await getBookingState(db, pub.code, T0, VB);
    expect(a.seats.find((x) => x.id === '3-1')!.status).toBe('mine');
    expect(a.seats.find((x) => x.id === '3-2')!.status).toBe('held');
    expect(b.seats.find((x) => x.id === '3-2')!.status).toBe('mine');
    expect(a.held?.seatIds).toEqual(['3-1']);
  });

  it('沒有訪客代碼不能操作公開連結', async () => {
    const pub = await A.createPublicLink(db, who);
    await expectCode(holdSeats(db, pub.code, ['3-1'], SINGLE(), T0), 'INVALID');
  });

  it('公開連結開始時間之前不能訂，專屬連結可以', async () => {
    const pub = await A.createPublicLink(db, who);
    await A.updateEventSettings(db, who, { publicSaleStart: min(60) });
    const s = await getBookingState(db, pub.code, T0, VA);
    expect(s.sale).toBe('not_started');
    expect(s.seats.length).toBeGreaterThan(0); // 仍可看座位
    await expectCode(holdSeats(db, pub.code, ['3-1'], SINGLE(), T0, VA), 'SALE_CLOSED');
    await expect(holdSeats(db, 'AAA111', ['3-1'], SINGLE(), T0)).resolves.toBeTruthy();
    await expect(holdSeats(db, pub.code, ['3-3'], SINGLE(), min(61), VA)).resolves.toBeTruthy();
  });

  it('公開連結每支手機上限（0 = 不限）', async () => {
    const pub = await A.createPublicLink(db, who);
    const h1 = await holdSeats(db, pub.code, ['4-1', '4-2'], SINGLE(), T0, VA);
    await submitOrder(db, pub.code, submitBody(h1.orderId, ['4-1', '4-2'], h1.amount), min(1), VA);
    await A.updateEventSettings(db, who, { publicPerPhone: 3 });
    const h2 = await holdSeats(db, pub.code, ['4-3', '4-5'], SINGLE(), min(2), VB);
    await expectCode(submitOrder(db, pub.code, submitBody(h2.orderId, ['4-3', '4-5'], h2.amount), min(3), VB), 'QUOTA');
    await A.updateEventSettings(db, who, { publicPerPhone: 0 });
    await expect(submitOrder(db, pub.code, submitBody(h2.orderId, ['4-3', '4-5'], h2.amount), min(3), VB)).resolves.toBeTruthy();
    const b = await getBookingState(db, pub.code, min(4), VB);
    expect(b.orders).toHaveLength(1); // 只看到自己的訂單
  });

  it('專屬連結張數 0 = 不限（仍受每筆上限）', async () => {
    await A.createInviteLink(db, who, { name: '丁', phone: '0944444444', quota: 0, expiresAt: EXP });
    const st = await A.getAdminState(db, T0);
    const code = st.links.find((l) => l.name === '丁')!.code;
    const s = await getBookingState(db, code, T0);
    expect(s.canBuy).toBe(6);
  });
});
