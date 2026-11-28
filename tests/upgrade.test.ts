import { beforeEach, describe, expect, it } from 'vitest';
import { setLiveAt } from '@/lib/practice';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { createGates, listGates, qrSecret, qrValue, scan } from '@/lib/ticket';
import { applyUpgrade, cancelUpgrade, createUpgrade, listUpgrades, upgradeView } from '@/lib/upgrade';

const T0 = new Date('2026-11-15T10:00:00+08:00');
let db: Db; let eventId: number;

async function paidOrder(seats: string[], name = '王大明') {
  const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
  const h = await holdSeats(db, 'AAA111', seats, single, T0);
  await submitOrder(db, 'AAA111', { orderId: h.orderId, buyer: { name, phone: '0912345678', email: 'a@b.co' },
    holders: seats.map((s, i) => ({ seatId: s, name: `${name}${i + 1}`, id4: 'A123' })), agree: true }, T0);
  await A.confirmPayment(db, 'admin', h.orderId, { date: '2026-11-15', amount: 0 }, T0);
  return h.orderId;
}
async function seatInfo(id: string) {
  const [s] = await db.select({ zoneId: t.eventSeat.zoneId, block: t.venueSeat.block, status: t.eventSeat.status, usage: t.seatUsage.code, orderId: t.eventSeat.orderId })
    .from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.eventSeat.seatId, id)));
  return s;
}
/** 找跟 ref 同票種、同區、空著的座位 */
async function freeLike(ref: string, n: number, not: string[] = []) {
  const r = await seatInfo(ref);
  const rows = await db.select({ id: t.eventSeat.seatId, block: t.venueSeat.block, y: t.venueSeat.y, x: t.venueSeat.x }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, eventId), eq(t.eventSeat.zoneId, r.zoneId), eq(t.eventSeat.status, 'free'), eq(t.seatUsage.sellable, true), eq(t.venueSeat.floor, '2M'), eq(t.venueSeat.seatType, 'normal')));
  return rows.filter((x) => x.block === r.block && !not.includes(x.id)).sort((a, b) => a.y - b.y || a.x - b.x).slice(0, n).map((x) => x.id);
}

beforeEach(async () => {
  db = await createPgliteDb();
  await setLiveAt(db, 'test', '2020-01-01T00:00:00Z'); // 這些測試驗正式入場（不是練習）
  await seedVenue(db);
  const ev = await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00') });
  eventId = ev.id;
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-09T23:59:59+08:00') });
  await A.publish(db, 'admin');
});

describe('免費升等（換座位）', () => {
  it('買方選新座位 → 換好；持票人與序號不變，原本的 QR 照樣入場並顯示新座位；舊座位改「保留：攝影」', async () => {
    const oid = await paidOrder(['5-3', '5-4', '5-5']);
    const before = (await A.ticketData(db, [oid])).tickets.map((x) => [x.serial, x.seatId, x.holderName]);
    expect(before.map((x) => x[0])).toEqual(['T1-00001-01', 'T1-00001-02', 'T1-00001-03']);
    const serial54 = before.find((x) => x[1] === '5-4')![0];
    const zone = (await seatInfo('5-4')).zoneId, block = (await seatInfo('1-1')).block;
    // 換到第 1 排（位置在原本座位前面，舊的排法序號會整個重排）
    const target = await freeLike('1-1', 1);
    expect((await seatInfo(target[0])).zoneId).toBe(zone);
    const u = await createUpgrade(db, 'admin', { orderId: oid, seatIds: ['5-4'], zoneIds: [zone], blocks: [block], oldTo: 'photo' });
    const v = await upgradeView(db, u.token);
    expect(v).toMatchObject({ status: 'open', n: 1, old: ['第5排 4號'] });
    expect(v.seats.find((s) => s.id === target[0])!.status).toBe('free');
    expect(v.seats.find((s) => s.id === '5-4')!.status).toBe('mine');
    expect(JSON.stringify(v)).not.toMatch(/0912345678|a@b\.co/);

    await expect(applyUpgrade(db, u.token, [target[0], '5-6'])).rejects.toThrow('請選 1 席');
    const r = await applyUpgrade(db, u.token, target);
    expect(r.moves).toEqual([expect.objectContaining({ from: '5-4', to: target[0], fromLabel: '第5排 4號' })]);
    const after = (await A.ticketData(db, [oid])).tickets.map((x) => [x.serial, x.seatId, x.holderName]);
    expect(after).toEqual(before.map((x) => (x[1] === '5-4' ? [x[0], target[0], x[2]] : x)));
    // 買方劃位頁的序號、QR 也一樣
    const bs = await getBookingState(db, 'AAA111', T0);
    expect(bs.orders[0].seats.map((s) => [s.serial, s.holder])).toEqual(before.map((x) => [x[0], x[2]]));
    // 原本的 QR 入場，顯示新座位
    await createGates(db, 'admin', ['左1']);
    const [g] = await listGates(db);
    const res = await scan(db, g.token, { qr: qrValue(await qrSecret(db), serial54) });
    expect(res).toMatchObject({ result: 'ok', holderName: '王大明2' });
    expect((res as { label: string }).label).toMatch(/^第1排/);
    // 舊座位：空著但不能賣
    expect(await seatInfo('5-4')).toMatchObject({ status: 'free', usage: 'hold-photo', orderId: null });
    expect(await seatInfo(target[0])).toMatchObject({ status: 'sold', orderId: oid });
    expect((await listUpgrades(db))[0]).toMatchObject({ status: 'done' });
    await expect(applyUpgrade(db, u.token, target)).rejects.toThrow('已經換好');
    await expect(cancelUpgrade(db, 'admin', u.token)).rejects.toThrow('已經換好');
  });

  it('預設：舊座位釋出成空位（照原本用途、可再賣）；舊連結沒有 oldTo 欄位＝保留：攝影', async () => {
    const oid = await paidOrder(['7-3', '7-4']);
    const usage0 = (await seatInfo('7-3')).usage;
    const zone = (await seatInfo('7-3')).zoneId, block = (await seatInfo('1-1')).block;
    const u = await createUpgrade(db, 'admin', { orderId: oid, seatIds: ['7-3'], zoneIds: [zone], blocks: [block] });
    expect(u.oldTo).toBe('free');
    const target = await freeLike('1-1', 1);
    await applyUpgrade(db, u.token, target);
    expect(await seatInfo('7-3')).toMatchObject({ status: 'free', usage: usage0, orderId: null });
    expect(usage0).not.toBe('hold-photo');
    // 11/27 之前建立的連結（存的資料沒有 oldTo）→ 照舊保留：攝影
    const u2 = await createUpgrade(db, 'admin', { orderId: oid, seatIds: ['7-4'], zoneIds: [zone], blocks: [block] });
    const { oldTo: _drop, ...legacy } = u2;
    await db.update(t.appSetting).set({ value: JSON.stringify(legacy) }).where(eq(t.appSetting.key, `upgrade.${u2.token}`));
    await applyUpgrade(db, u2.token, await freeLike('1-1', 1));
    expect(await seatInfo('7-4')).toMatchObject({ status: 'free', usage: 'hold-photo', orderId: null });
  });

  it('擋下：範圍外、已被訂走、取消的連結、已入場、重複建立', async () => {
    const oid = await paidOrder(['6-3', '6-4']);
    const zone = (await seatInfo('6-3')).zoneId, block = (await seatInfo('6-3')).block;
    const u = await createUpgrade(db, 'admin', { orderId: oid, seatIds: ['6-3'], zoneIds: [zone], blocks: [block] });
    await expect(createUpgrade(db, 'admin', { orderId: oid, seatIds: ['6-3'], zoneIds: [zone], blocks: [block] })).rejects.toThrow('已經有升等連結');
    // 別區的座位
    const other = (await db.select({ id: t.eventSeat.seatId, block: t.venueSeat.block }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .where(and(eq(t.eventSeat.eventId, eventId), eq(t.eventSeat.status, 'free'), eq(t.venueSeat.floor, '2M')))).find((x) => x.block !== block)!.id;
    await expect(applyUpgrade(db, u.token, [other])).rejects.toThrow('範圍');
    // 剛被別人訂走
    const [x] = await freeLike('6-3', 1, ['6-3', '6-4']);
    await paidOrder([x], '林');
    await expect(applyUpgrade(db, u.token, [x])).rejects.toThrow(/訂走/);
    await cancelUpgrade(db, 'admin', u.token);
    const [y] = await freeLike('6-3', 1, ['6-3', '6-4']);
    await expect(applyUpgrade(db, u.token, [y])).rejects.toThrow('取消');
    // 已入場的座位不能建立升等
    await createGates(db, 'admin', ['左1']);
    const [g] = await listGates(db);
    await scan(db, g.token, { qr: qrValue(await qrSecret(db), 'T1-00001-01') });
    await expect(createUpgrade(db, 'admin', { orderId: oid, seatIds: ['6-3'], zoneIds: [zone], blocks: [block] })).rejects.toThrow('入場');
  });

  it('沒換過座位的訂單序號照舊（依座位位置）', async () => {
    const oid = await paidOrder(['7-5', '7-4']);
    const pos = await db.select({ id: t.venueSeat.id, y: t.venueSeat.y, x: t.venueSeat.x }).from(t.venueSeat).where(inArray(t.venueSeat.id, ['7-4', '7-5']));
    pos.sort((a, b) => a.y - b.y || a.x - b.x);
    expect((await A.ticketData(db, [oid])).tickets.map((x) => [x.serial, x.seatId])).toEqual([['T1-00001-01', pos[0].id], ['T1-00001-02', pos[1].id]]);
  });
});
