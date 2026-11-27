import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { createVip } from '@/lib/vip';
import { sendVipOtp, setVipCard, verifyVipOtp, vipCardAction, vipCardPage, vipCardSend } from '@/lib/vipCard';
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
});
