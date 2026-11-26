import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { cancelCharity, charityUsage, charityView, createCharity, listCharity, renameCharity, submitCharity } from '@/lib/charity';
import { listVips } from '@/lib/vip';

const T0 = new Date('2026-11-27T10:00:00+08:00');
let db: Db; let eventId: number;
const POOL = ['10-1', '10-2', '10-3', '10-4', '10-5'];

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  eventId = (await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00') })).id;
  await A.setSeatUsage(db, 'admin', await charityUsage(db, eventId), POOL);
});
const mk = (o: Partial<{ org: string; n: number; email: string; cat: string }> = {}) =>
  createCharity(db, 'admin', { org: '乙基金會', name: '張三', email: 'z3@y.org', n: 2, deadline: '2026-12-06', ...o }, T0);

describe('公益劃位專屬連結', () => {
  it('負責人從「保留：公益」選 N 席、填姓名職稱 → 建一筆公益（單位、持票人）並排好立即寄 QR 給後台填的 Email', async () => {
    const c = await mk();
    const v = await charityView(db, c.code, T0);
    expect(v).toMatchObject({ org: '乙基金會', n: 2, free: 5, done: false, closed: false, email: 'z3***@y.org' });
    expect(v.seats.find((s) => s.id === '10-1')!.status).toBe('free');
    expect(v.seats.find((s) => s.id === '9-1')!.status).toBe('blocked'); // 池子外不能選
    expect(JSON.stringify(v)).not.toContain('z3@y.org');

    await expect(submitCharity(db, c.code, { seatIds: ['10-1'], names: ['甲'] }, undefined, T0)).rejects.toThrow('請選 2 席');
    await expect(submitCharity(db, c.code, { seatIds: ['10-1', '10-2'], names: ['甲', ' '] }, undefined, T0)).rejects.toThrow('姓名職稱');
    await expect(submitCharity(db, c.code, { seatIds: ['10-1', '9-1'], names: ['甲', '乙'] }, undefined, T0)).rejects.toThrow('範圍');
    const r = await submitCharity(db, c.code, { seatIds: ['10-2', '10-1'], names: ['林小華 執行長', '張三 秘書'] }, undefined, T0);
    expect(r.orderNo).toBeTruthy();

    const vip = (await listVips(db)).list[0];
    expect(vip).toMatchObject({ cat: '公益', org: '乙基金會', name: '張三', email: 'z3@y.org', mode: 'now' });
    const hs = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, vip.id));
    expect(Object.fromEntries(hs.map((h) => [h.seatId, h.holderName]))).toEqual({ '10-2': '林小華 執行長', '10-1': '張三 秘書' });
    const n = await db.select().from(t.notification).where(eq(t.notification.orderId, vip.id));
    expect(n.map((x) => [x.channel, x.recipient, x.status])).toEqual([['email', 'z3@y.org', 'queued']]);

    const after = await charityView(db, c.code, T0);
    expect(after).toMatchObject({ done: true, mine: [{ seatId: '10-1', name: '張三 秘書' }, { seatId: '10-2', name: '林小華 執行長' }] });
    await expect(submitCharity(db, c.code, { seatIds: ['10-3', '10-4'], names: ['a', 'b'] }, undefined, T0)).rejects.toThrow('已經送出');
    expect((await listCharity(db)).links[0]).toMatchObject({ status: 'done' });
    expect((await listCharity(db))).toMatchObject({ pool: 3, owed: 0 });
  });

  it('截止前可改姓名，截止後不行；截止後也不能選', async () => {
    const c = await mk();
    await submitCharity(db, c.code, { seatIds: ['10-1', '10-2'], names: ['甲', '乙'] }, undefined, T0);
    expect(await renameCharity(db, c.code, [{ seatId: '10-1', name: '甲 理事長' }], T0)).toEqual({ changed: 1 });
    const [h] = await db.select().from(t.orderSeat).where(eq(t.orderSeat.seatId, '10-1'));
    expect(h.holderName).toBe('甲 理事長');
    await expect(renameCharity(db, c.code, [{ seatId: '10-3', name: 'x' }], T0)).rejects.toThrow('不屬於');
    const late = new Date('2026-12-07T00:00:00+08:00');
    await expect(renameCharity(db, c.code, [{ seatId: '10-1', name: 'x' }], late)).rejects.toThrow('截止');
    const c2 = await mk({ org: '丙' });
    expect((await charityView(db, c2.code, late)).closed).toBe(true);
    await expect(submitCharity(db, c2.code, { seatIds: ['10-3', '10-4'], names: ['a', 'b'] }, undefined, late)).rejects.toThrow('截止');
  });

  it('兩個單位搶同一席：後送出的被擋；停用的連結打不開；VIP 不能建連結', async () => {
    const a = await mk(); const b = await mk({ org: '丙協會' });
    expect((await listCharity(db))).toMatchObject({ pool: 5, owed: 4 });
    await submitCharity(db, a.code, { seatIds: ['10-1', '10-2'], names: ['a', 'b'] }, undefined, T0);
    await expect(submitCharity(db, b.code, { seatIds: ['10-2', '10-3'], names: ['c', 'd'] }, undefined, T0)).rejects.toThrow('剛被選走');
    expect((await charityView(db, b.code, T0)).seats.find((s) => s.id === '10-2')!.status).toBe('sold');
    await cancelCharity(db, 'admin', b.code);
    await expect(charityView(db, b.code, T0)).rejects.toThrow('停用');
    await expect(cancelCharity(db, 'admin', a.code)).rejects.toThrow('已選好');
    await expect(mk({ cat: 'VIP' })).rejects.toThrow('VIP');
    await expect(mk({ email: 'bad' })).rejects.toThrow('Email');
    const es = await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, eventId), eq(t.eventSeat.seatId, '10-3')));
    expect(es[0].status).toBe('free');
  });
});
