import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState } from '@/lib/booking';
import { dispatchQueued, type Senders } from '@/lib/notify';
import { cancelVip, createVip, listVips, setVipDays, setVipMode, updateVip, updateVipSeats, vipSendAt } from '@/lib/vip';

let db: Db;
const SHOW = new Date('2026-12-20T19:30:00+08:00');
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '祈福音樂會', showAt: SHOW, bankName: 'b', bankAccount: '1', accountName: 'c' });
  await A.publish(db, 'admin');
  // 有 Email 帳號，才會真的寄（測試用假寄件）
  await db.insert(t.appSetting).values([{ key: 'email.user', value: 'x@gmail.com' }, { key: 'email.pass', value: 'p' }]);
});

function fake() {
  const sent: { to: string; text: string; html?: string }[] = [];
  const s: Senders = { email: async (_c, to, _s, text, extra) => { sent.push({ to, text, html: extra?.html }); }, sms: async () => undefined };
  return { s, sent };
}
const status = async (ids: string[]) => (await db.select().from(t.eventSeat)).filter((s) => ids.includes(s.seatId)).map((s) => s.status);

describe('招待（VIP）', () => {
  it('演出前 3 天上午 10 點自動寄出：之前不寄、時間到才寄；座位保留、金額 0、不算收入', async () => {
    expect(vipSendAt(SHOW, 3, new Date('2026-11-01T00:00:00+08:00'))!.toISOString()).toBe('2026-12-17T02:00:00.000Z');
    const r = await createVip(db, '網管', { name: '王董', phone: '0911222333', email: 'wang@example.com', seatIds: ['1-1', '1-3'], mode: 'scheduled' }, 'https://x.example');
    expect(r.sendAt).toBe('2026-12-17T02:00:00.000Z');
    expect(await status(['1-1', '1-3'])).toEqual(['sold', 'sold']);
    const [o] = await db.select().from(t.orders).where(eq(t.orders.id, r.orderId));
    expect(o).toMatchObject({ vip: true, amount: 0, status: 'paid', buyerName: '王董' });

    const f = fake();
    await dispatchQueued(db, f.s, () => new Date('2026-12-16T12:00:00+08:00'));
    expect(f.sent).toHaveLength(0);
    await dispatchQueued(db, f.s, () => new Date('2026-12-17T10:01:00+08:00'));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].to).toBe('wang@example.com');
    expect(f.sent[0].text).toContain('已為您保留座位');
    expect(f.sent[0].html).toContain('QR code');

    const st = await A.getAdminState(db);
    expect(st.stats).toMatchObject({ vipSeats: 2, revenue: 0 });
    const v = await listVips(db);
    expect(v.list[0]).toMatchObject({ name: '王董', mode: 'scheduled', sendAt: null });
    expect(v.list[0].sentAt).toBeTruthy();
  });

  it('不寄（紙本）：沒有通知；立即寄：馬上寄；招待的劃位頁不能再多訂', async () => {
    const a = await createVip(db, '網管', { name: '李處長', phone: '', email: '', seatIds: ['2-1'], mode: 'none' });
    expect(await db.select().from(t.notification).where(eq(t.notification.orderId, a.orderId))).toHaveLength(0);
    await expect(createVip(db, '網管', { name: '陳', phone: '', email: '', seatIds: ['2-3'], mode: 'now' })).rejects.toThrow('Email 或手機');
    const b = await createVip(db, '網管', { name: '陳', phone: '', email: 'chen@example.com', seatIds: ['2-3'], mode: 'now' });
    const f = fake();
    await dispatchQueued(db, f.s);
    expect(f.sent.map((x) => x.to)).toEqual(['chen@example.com']);
    const lk = (await listVips(db)).list.find((x) => x.id === b.orderId)!.code;
    expect((await getBookingState(db, lk)).canBuy).toBe(0);
  });

  it('只拿連座的一部分：該組其他座位改回單人；已有訂單的座位不能選', async () => {
    await A.bundleAuto(db, 'admin', { rows: [2], blocks: ['C0'], size: 2, shape: 'row', crossAisle: false, skip: [] });
    const before = (await db.select().from(t.eventSeat)).find((s) => s.seatId === '2-1')!.bundle;
    const mates = (await db.select().from(t.eventSeat)).filter((s) => s.bundle === before).map((s) => s.seatId);
    expect(mates.length).toBe(2);
    const r = await createVip(db, '網管', { name: '王', phone: '', email: '', seatIds: ['2-1'], mode: 'none' });
    expect(r.brokeBundles).toBe(1);
    expect((await db.select().from(t.eventSeat)).filter((s) => mates.includes(s.seatId)).every((s) => !s.bundle)).toBe(true);
    await expect(createVip(db, '網管', { name: '甲', phone: '', email: '', seatIds: ['2-1'], mode: 'none' })).rejects.toThrow('已有人訂');
  });

  it('改座位、改寄送方式、改天數、取消', async () => {
    const r = await createVip(db, '網管', { name: '王董', phone: '', email: 'wang@example.com', seatIds: ['1-1', '1-3'], mode: 'scheduled' });
    await updateVipSeats(db, '網管', r.orderId, ['1-5', '1-7', '1-9']);
    expect(await status(['1-1', '1-3'])).toEqual(['free', 'free']);
    expect(await status(['1-5', '1-7', '1-9'])).toEqual(['sold', 'sold', 'sold']);
    const [n] = await db.select().from(t.notification).where(eq(t.notification.orderId, r.orderId));
    expect(n.content).toContain('1-5'.replace('1-', '第1排 ').replace('5', '5號'));

    const d = await setVipDays(db, '網管', 5);
    expect(d.sendAt).toBe('2026-12-15T02:00:00.000Z');
    expect((await db.select().from(t.notification).where(eq(t.notification.orderId, r.orderId)))[0].sendAfter!.toISOString()).toBe('2026-12-15T02:00:00.000Z');

    await setVipMode(db, '網管', r.orderId, 'none');
    expect(await db.select().from(t.notification).where(eq(t.notification.orderId, r.orderId))).toHaveLength(0);
    await cancelVip(db, '網管', r.orderId);
    expect(await status(['1-5', '1-7', '1-9'])).toEqual(['free', 'free', 'free']);
    expect((await listVips(db)).list[0].status).toBe('cancelled');
  });
});

describe('招待：推薦人與改資料', () => {
  it('推薦人存下來；用過的推薦人去重、最近的在前、附上次 Email；「無」不列入', async () => {
    await createVip(db, '網管', { name: '甲', phone: '', email: 'a@x.example', seatIds: ['1-1'], mode: 'none', referrer: '王小明' });
    await createVip(db, '網管', { name: '乙', phone: '', email: 'b@x.example', seatIds: ['1-3'], mode: 'none', referrer: '陳大華' });
    await createVip(db, '網管', { name: '丙', phone: '', email: 'c@x.example', seatIds: ['1-5'], mode: 'none', referrer: '王小明' });
    await createVip(db, '網管', { name: '丁', phone: '', email: '', seatIds: ['1-7'], mode: 'none', referrer: '無' });
    const v = await listVips(db);
    expect(v.referrers).toEqual([{ name: '王小明', email: 'c@x.example' }, { name: '陳大華', email: 'b@x.example' }]);
    expect(v.list.map((x) => x.referrer)).toEqual(['王小明', '陳大華', '王小明', '無']);
  });

  it('沒留 Email 的「不寄」：補 Email 後改「立即寄」就寄得出去', async () => {
    const r = await createVip(db, '網管', { name: '王董', phone: '', email: '', seatIds: ['1-1'], mode: 'none', referrer: '無' }, 'https://x.example');
    await expect(setVipMode(db, '網管', r.orderId, 'now')).rejects.toThrow('請填 Email 或手機');
    await updateVip(db, '網管', r.orderId, { name: '王董', phone: '', email: 'wang@x.example', referrer: '王小明', note: '第三位' });
    await setVipMode(db, '網管', r.orderId, 'now', 'https://x.example');
    const f = fake();
    await dispatchQueued(db, f.s, () => new Date());
    expect(f.sent.map((x) => x.to)).toEqual(['wang@x.example']);
    const x = (await listVips(db)).list[0];
    expect(x).toMatchObject({ email: 'wang@x.example', referrer: '王小明', note: '第三位' });
  });

  it('改姓名：持票人自動名字跟著改，排程中的信換成新姓名；座位、QR 不變', async () => {
    const r = await createVip(db, '網管', { name: '王董', phone: '', email: 'w@x.example', seatIds: ['1-1', '1-3'], mode: 'scheduled', referrer: '無' }, 'https://x.example');
    const before = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, r.orderId));
    await db.update(t.orderSeat).set({ holderName: '李四' }).where(eq(t.orderSeat.seatId, before.find((s) => s.holderName === '王董02')!.seatId));
    await updateVip(db, '網管', r.orderId, { name: '王大董', phone: '', email: 'w@x.example', referrer: '無', note: '' });
    const after = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, r.orderId));
    expect(after.map((s) => s.holderName).sort()).toEqual(['李四', '王大董']);
    expect(after.map((s) => s.seatId).sort()).toEqual(before.map((s) => s.seatId).sort());
    const q = await db.select().from(t.notification).where(eq(t.notification.orderId, r.orderId));
    expect(q).toHaveLength(1);
    expect(q[0].content).toContain('王大董 您好');
    const log = await db.select().from(t.auditLog).where(eq(t.auditLog.action, 'vip_update'));
    expect(log[0].detail).toContain('王董');
  });

  it('已取消的招待不能改資料', async () => {
    const r = await createVip(db, '網管', { name: '王董', phone: '', email: '', seatIds: ['1-1'], mode: 'none', referrer: '無' });
    await cancelVip(db, '網管', r.orderId);
    await expect(updateVip(db, '網管', r.orderId, { name: 'x', phone: '', email: '', referrer: '無', note: '' })).rejects.toThrow('已取消');
  });
});
