import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { createVip } from '@/lib/vip';
import { sendVipOtp, setVipCard, verifyVipOtp, vipCardAction, vipCardBook, vipCardName, vipCardPage, vipCardSeatMap, vipCardSend } from '@/lib/vipCard';
import { qrSecret, qrValue } from '@/lib/qr';

let db: Db;
const BASE = 'https://ticket.example.com';
const T0 = new Date('2026-11-28T10:00:00+08:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
});
const mails = async (template: string) => db.select().from(t.notification).where(eq(t.notification.template, template));
async function login(code: string, now = at(0)) {
  await sendVipOtp(db, code, 'Boss@Example.com', now);
  const m = (await mails('vip_otp')).at(-1)!;
  const otp = m.content.match(/驗證碼是 (\d{6})/)![1];
  return (await verifyVipOtp(db, code, otp, now)).token;
}

describe('VIP 票卡連結', () => {
  it('鎖負責人 Email：驗證碼、錯誤次數、手機記住 7 天、換新連結舊的失效', async () => {
    const l = await setVipCard(db, '網管', { name: '陳秘書', email: 'boss@example.com' });
    expect(await msg(vipCardPage(db, l!.code, '', at(0)))).toContain('驗證');
    expect(await msg(sendVipOtp(db, l!.code, 'other@example.com', at(0)))).toContain('沒有權限');
    await sendVipOtp(db, l!.code, 'boss@example.com', at(0), BASE);
    expect((await mails('vip_otp')).map((m) => m.recipient)).toEqual(['boss@example.com']);
    expect((await mails('vip_otp'))[0].content).toContain(`${BASE}/vc/${l!.code}`); // 信裡有回到票卡頁的連結
    expect(await msg(sendVipOtp(db, l!.code, 'boss@example.com', at(0)))).toContain('1 分鐘');
    expect(await msg(verifyVipOtp(db, l!.code, '000000', at(1)))).toContain('還可以試 4 次');
    const otp = (await mails('vip_otp'))[0].content.match(/驗證碼是 (\d{6})/)![1];
    expect(await msg(verifyVipOtp(db, l!.code, otp, at(11)))).toContain('過期');
    const token = await login(l!.code, at(12));
    expect((await vipCardPage(db, l!.code, token, at(13))).cards).toEqual([]);
    // 手機記到演出當天 23:00
    expect((await vipCardPage(db, l!.code, token, new Date('2026-12-09T22:59:00+08:00'))).cards).toEqual([]);
    expect(await msg(vipCardPage(db, l!.code, token, new Date('2026-12-09T23:01:00+08:00')))).toContain('驗證');
    const r = await vipCardAction(db, '網管', 'renew');
    expect(await msg(vipCardPage(db, l!.code, token, at(14)))).toContain('已更換');
    expect(await msg(vipCardPage(db, r!.code, token, at(14)))).toContain('驗證');
    await vipCardAction(db, '網管', 'off');
    expect(await msg(sendVipOtp(db, r!.code, 'boss@example.com', at(20)))).toContain('停用');
  });

  it('只列類別 VIP；每席一張（依座位）、QR 與訂單一致；寄給本人：存 Email、只寄一封、不再演出前自動寄、2 分鐘內不重寄', async () => {
    const a = await createVip(db, '網管', { name: '王董事長', phone: '', email: '', seatIds: ['V-2', 'V-1'], mode: 'none', cat: 'VIP', org: '甲公司', holders: ['王董事長', '王夫人'] }, BASE);
    const b = await createVip(db, '網管', { name: '李理事長', phone: '', email: 'li@x.org', seatIds: ['W-H15'], mode: 'scheduled', cat: 'VIP' }, BASE);
    await createVip(db, '網管', { name: '公益甲', phone: '', email: 'c@x.org', seatIds: ['5-1'], mode: 'none', cat: '公益' }, BASE);
    const l = await setVipCard(db, '網管', { name: '陳秘書', email: 'boss@example.com' });
    const token = await login(l!.code);
    let p = await vipCardPage(db, l!.code, token, at(1));
    expect(p.total).toBe(2);
    expect(p.cards.map((c) => c.seat)).toEqual(['VIP排 23號', 'VIP排 1號', 'VIP排 2號']); // 依座位由左到右
    expect(p.cards.map((c) => c.name)).toContain('王夫人');
    const sec = await qrSecret(db);
    expect(p.cards.every((c) => c.value === qrValue(sec, c.serial))).toBe(true);
    expect(p.cards.find((c) => c.orderId === b.orderId)!.email).toBe('l***@x.org');
    // 沒有 Email：要填
    expect(await msg(vipCardSend(db, l!.code, token, { orderId: a.orderId }, BASE, at(2)))).toContain('Email');
    const r = await vipCardSend(db, l!.code, token, { orderId: a.orderId, email: 'Wang@Corp.com' }, BASE, at(2));
    expect(r.to).toBe('w***@corp.com');
    const [oa] = await db.select().from(t.orders).where(eq(t.orders.id, a.orderId));
    expect(oa).toMatchObject({ buyerEmail: 'wang@corp.com', notifyMode: 'now' });
    expect((await mails('order_confirmed')).filter((m) => m.orderId === a.orderId).map((m) => m.recipient)).toEqual(['wang@corp.com']);
    expect(await msg(vipCardSend(db, l!.code, token, { orderId: a.orderId }, BASE, at(3)))).toContain('2 分鐘');
    // 原本排程演出前寄的：寄給本人後排程清掉，只剩這一封
    await vipCardSend(db, l!.code, token, { orderId: b.orderId }, BASE, at(4));
    const bm = (await db.select().from(t.notification).where(eq(t.notification.orderId, b.orderId)));
    expect(bm.filter((m) => m.channel === 'email')).toHaveLength(1);
    expect(bm[0].sendAfter).toBeNull();
    // 公益訂單不能從這裡寄
    const charity = (await db.select().from(t.orders).where(eq(t.orders.vipCat, '公益')))[0];
    expect(await msg(vipCardSend(db, l!.code, token, { orderId: charity.id }, BASE, at(5)))).toContain('找不到');
    p = await vipCardPage(db, l!.code, token, at(6));
    expect(p.cards.filter((c) => c.orderId === a.orderId).every((c) => c.email === 'w***@corp.com')).toBe(true);
  });

  it('沒姓名的票卡可以補填（只填空白、QR 不變）；已有姓名不能改', async () => {
    const a = await createVip(db, '網管', { name: '王董事長', phone: '', email: '', seatIds: ['V-1', 'V-3'], mode: 'none', cat: 'VIP', holders: ['王董事長', '王夫人'] }, BASE);
    await db.update(t.orderSeat).set({ holderName: '' }).where(eq(t.orderSeat.seatId, 'V-3'));
    const l = await setVipCard(db, '網管', { name: '陳秘書', email: 'boss@example.com' });
    const token = await login(l!.code);
    let p = await vipCardPage(db, l!.code, token, at(1));
    const blank = p.cards.find((c) => c.seatId === 'V-3')!;
    expect(blank).toMatchObject({ name: '', needName: true });
    const qr = blank.value;
    expect(await msg(vipCardName(db, l!.code, token, { orderId: a.orderId, seatId: 'V-3', name: '  ' }, at(1)))).toContain('請填');
    await vipCardName(db, l!.code, token, { orderId: a.orderId, seatId: 'V-3', name: '林小姐 執行長' }, at(1));
    p = await vipCardPage(db, l!.code, token, at(2));
    expect(p.cards.find((c) => c.seatId === 'V-3')).toMatchObject({ name: '林小姐 執行長', needName: false, value: qr });
    expect(await msg(vipCardName(db, l!.code, token, { orderId: a.orderId, seatId: 'V-1', name: '別人' }, at(2)))).toContain('已經有姓名');
    expect(await msg(vipCardName(db, l!.code, '', { orderId: a.orderId, seatId: 'V-3', name: 'x' }, at(2)))).toContain('驗證');
  });

  it('負責人自己劃位：只能選 VIP 排與 2 樓第 1–12 排的空位；每席一筆 VIP、不寄信；不行的座位整批不建立', async () => {
    await db.update(t.event).set({ vipInstalled: true });
    const l = await setVipCard(db, '網管', { name: '陳秘書', email: 'boss@example.com' });
    const token = await login(l!.code);
    const m = await vipCardSeatMap(db, l!.code, token, at(1));
    const rows = new Set(m.seats.map((s) => s.label.match(/^第(\d+)排/)?.[1]).filter(Boolean).map(Number));
    expect(Math.max(...rows)).toBe(12);
    expect(m.seats.some((s) => s.id === 'V-1' && s.status === 'free')).toBe(true);
    expect(m.seats.some((s) => s.id.startsWith('13-'))).toBe(false);
    expect(await msg(vipCardBook(db, l!.code, token, { seats: [{ seatId: '13-1', name: 'x' }] }, at(1)))).toContain('第 1–12 排');
    expect(await msg(vipCardBook(db, l!.code, token, { seats: [{ seatId: '3-1', name: '' }] }, at(1)))).toContain('姓名');
    // 已有人的座位 → 整批不建立
    await createVip(db, '網管', { name: '已有人', phone: '', email: '', seatIds: ['3-2'], mode: 'none', cat: 'VIP' }, BASE);
    expect(await msg(vipCardBook(db, l!.code, token, { seats: [{ seatId: '3-1', name: '甲' }, { seatId: '3-2', name: '乙' }] }, at(1)))).toContain('不能選');
    expect((await vipCardPage(db, l!.code, token, at(1))).total).toBe(1);
    const n0 = (await db.select().from(t.notification)).length;
    const r = await vipCardBook(db, l!.code, token, { seats: [{ seatId: 'V-5', name: '甲 理事' }, { seatId: '3-1', name: '乙 董事' }], org: '丙會' }, at(2));
    expect(r.count).toBe(2);
    const p = await vipCardPage(db, l!.code, token, at(3));
    expect(p.total).toBe(3);
    expect(p.cards.filter((c) => c.org === '丙會').map((c) => c.name).sort()).toEqual(['乙 董事', '甲 理事']);
    expect((await db.select().from(t.notification)).length).toBe(n0); // 不寄信
    expect((await vipCardSeatMap(db, l!.code, token, at(3))).seats.find((s) => s.id === '3-1')!.status).toBe('sold');
  });
});
