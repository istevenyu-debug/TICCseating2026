import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue, setUsage } from '@/db/seed';
import * as t from '@/db/schema';
import { BookingError, getBookingState, holdSeats, releaseHold, submitOrder } from '@/lib/booking';
import { buildSeats } from '@/lib/layout';

const T0 = new Date('2026-11-15T10:00:00+08:00');
const min = (m: number) => new Date(T0.getTime() + m * 60_000);
const EXP = new Date('2026-12-10T23:59:59+08:00');

let db: Db;
let eventId: number;

async function setup() {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '測試場次', showAt: new Date('2026-12-20T19:30:00+08:00'), vipInstalled: false });
  eventId = ev.id;
  await createLink(db, { eventId, code: 'AAA111', name: '甲', phone: '0911111111', quota: 6, expiresAt: EXP });
  await createLink(db, { eventId, code: 'BBB222', name: '乙', phone: '0922222222', quota: 4, expiresAt: EXP });
}

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
});

describe('訂位流程', () => {
  beforeEach(setup);

  it('兩人同時搶同一座位，只有一人成功', async () => {
    const r = await Promise.allSettled([
      holdSeats(db, 'AAA111', ['3-1', '3-2'], 'single', T0),
      holdSeats(db, 'BBB222', ['3-2', '3-4'], 'single', T0),
    ]);
    const ok = r.filter((x) => x.status === 'fulfilled');
    const bad = r.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0].reason as BookingError).code).toBe('SEAT_TAKEN');
    const held = await db.select().from(t.eventSeat).where(eq(t.eventSeat.status, 'held'));
    expect(held).toHaveLength(2); // 失敗方的 3-4 沒有被留住
  });

  it('暫存 20 分鐘後自動釋放', async () => {
    await holdSeats(db, 'AAA111', ['5-11'], 'single', T0);
    let s = await getBookingState(db, 'BBB222', min(19));
    expect(s.seats.find((x) => x.id === '5-11')!.status).toBe('held');
    s = await getBookingState(db, 'BBB222', min(21));
    expect(s.seats.find((x) => x.id === '5-11')!.status).toBe('free');
    await expect(holdSeats(db, 'BBB222', ['5-11'], 'single', min(21))).resolves.toBeTruthy();
  });

  it('暫存者看到自己的座位為 mine，可放棄釋放', async () => {
    await holdSeats(db, 'AAA111', ['2-1'], 'single', T0);
    let s = await getBookingState(db, 'AAA111', T0);
    expect(s.seats.find((x) => x.id === '2-1')!.status).toBe('mine');
    expect(s.held?.seatIds).toEqual(['2-1']);
    await releaseHold(db, 'AAA111', T0);
    s = await getBookingState(db, 'AAA111', T0);
    expect(s.held).toBeNull();
    expect(s.seats.find((x) => x.id === '2-1')!.status).toBe('free');
  });

  it('重新暫存會取代同一連結先前的暫存', async () => {
    await holdSeats(db, 'AAA111', ['2-1'], 'single', T0);
    await holdSeats(db, 'AAA111', ['2-3'], 'single', min(1));
    const s = await getBookingState(db, 'AAA111', min(1));
    expect(s.seats.find((x) => x.id === '2-1')!.status).toBe('free');
    expect(s.held?.seatIds).toEqual(['2-3']);
  });

  it('組合票：張數與同區限制、折扣計價', async () => {
    await expectCode(holdSeats(db, 'AAA111', ['3-1'], 'pair', T0), 'COMBO');
    await expectCode(holdSeats(db, 'AAA111', ['3-1', '8-11'], 'pair', T0), 'COMBO'); // A 區 + B 區
    const r = await holdSeats(db, 'AAA111', ['3-1', '3-2'], 'pair', T0);
    expect(r.amount).toBe(Math.round((3200 * 2 * 0.95) / 10) * 10);
  });

  it('不可訂保留席與未加裝的 VIP 排', async () => {
    await setUsage(db, eventId, 'hold-pr', ['6-1']);
    await expectCode(holdSeats(db, 'AAA111', ['6-1'], 'single', T0), 'SEAT_UNAVAILABLE');
    await expectCode(holdSeats(db, 'AAA111', ['V-1'], 'single', T0), 'SEAT_UNAVAILABLE');
  });

  it('張數上限：連結可購張數跨訂單累計', async () => {
    const h = await holdSeats(db, 'BBB222', ['4-1', '4-2', '4-3'], 'single', T0);
    await submitOrder(db, 'BBB222', submitBody(h.orderId, ['4-1', '4-2', '4-3'], h.amount), min(5));
    await expectCode(holdSeats(db, 'BBB222', ['4-4', '4-5'], 'single', min(6)), 'QUOTA');
    await expect(holdSeats(db, 'BBB222', ['4-4'], 'single', min(6))).resolves.toBeTruthy();
  });

  it('送出資料後座位轉為待確認，48 小時未確認自動取消並通知', async () => {
    const h = await holdSeats(db, 'AAA111', ['7-1', '7-2'], 'single', T0);
    const r = await submitOrder(db, 'AAA111', submitBody(h.orderId, ['7-1', '7-2'], h.amount), min(10));
    expect(r.amountMismatch).toBe(false);
    let s = await getBookingState(db, 'BBB222', min(11));
    expect(s.seats.find((x) => x.id === '7-1')!.status).toBe('pending');
    const mine = await getBookingState(db, 'AAA111', min(11));
    expect(mine.orders[0]).toMatchObject({ status: 'pending', amount: h.amount });
    expect(mine.link.used).toBe(2);

    s = await getBookingState(db, 'BBB222', min(10 + 48 * 60 + 1));
    expect(s.seats.find((x) => x.id === '7-1')!.status).toBe('free');
    const n = await db.select().from(t.notification).where(eq(t.notification.template, 'order_expired'));
    expect(n).toHaveLength(2);
  });

  it('暫存逾時後不可送出', async () => {
    const h = await holdSeats(db, 'AAA111', ['9-1'], 'single', T0);
    await expectCode(submitOrder(db, 'AAA111', submitBody(h.orderId, ['9-1'], h.amount), min(25)), 'HOLD_EXPIRED');
  });

  it('送出資料欄位驗證', async () => {
    const h = await holdSeats(db, 'AAA111', ['9-3'], 'single', T0);
    const bad = submitBody(h.orderId, ['9-3'], h.amount);
    bad.holders[0].id4 = '12';
    await expectCode(submitOrder(db, 'AAA111', bad, min(1)), 'INVALID');
    const missing = submitBody(h.orderId, ['9-3'], h.amount);
    missing.holders = [];
    await expectCode(submitOrder(db, 'AAA111', missing, min(1)), 'INVALID');
  });

  it('過期或停用的連結無法使用', async () => {
    await expectCode(getBookingState(db, 'AAA111', new Date('2026-12-11T00:00:00+08:00')), 'LINK_EXPIRED');
    await db.update(t.inviteLink).set({ status: 'disabled' }).where(eq(t.inviteLink.code, 'BBB222'));
    await expectCode(getBookingState(db, 'BBB222', T0), 'LINK_DISABLED');
    await expectCode(getBookingState(db, 'NOPE00', T0), 'LINK_NOT_FOUND');
  });

  it('未開放訂購時不能暫存', async () => {
    await db.update(t.event).set({ saleOpen: false }).where(eq(t.event.id, eventId));
    await expectCode(holdSeats(db, 'AAA111', ['3-1'], 'single', T0), 'SALE_CLOSED');
  });
});
