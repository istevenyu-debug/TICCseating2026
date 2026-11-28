import { beforeEach, describe, expect, it } from 'vitest';
import { setLiveAt } from '@/lib/practice';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { createVip } from '@/lib/vip';
import { ensureFloor3 } from '@/lib/floor';
import { charityUsage } from '@/lib/charity';
import { ticketMail } from '@/lib/notify';
import { createGates, scan } from '@/lib/ticket';
import { qrSecret, qrValue } from '@/lib/qr';
import {
  receiptConfirm, receiptView, sendVipOtp, setVipCard, verifyVipOtp, vipCardBook, vipCardCancel, vipCardName, vipCardPage, vipCardSeatMap, vipCardSend, vipCardSendAll,
} from '@/lib/vipCard';

let db: Db;
const BASE = 'https://ticket.example.com';
const T0 = new Date('2026-11-29T10:00:00+08:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };
let pool: string[] = [];
beforeEach(async () => {
  db = await createPgliteDb();
  await setLiveAt(db, 'test', '2020-01-01T00:00:00Z'); // 這些測試驗正式入場（不是練習）
  await seedVenue(db);
  const ev = await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
  // 三樓極左（L2）前 4 席塗成「保留：公益」
  const uid = await charityUsage(db, ev.id);
  const s3 = await db.select({ id: t.venueSeat.id }).from(t.venueSeat).where(and(eq(t.venueSeat.floor, '3F'), eq(t.venueSeat.block, 'L2'))).orderBy(t.venueSeat.y, t.venueSeat.x).limit(4);
  pool = s3.map((s) => s.id);
  await db.update(t.eventSeat).set({ usageId: uid }).where(inArray(t.eventSeat.seatId, pool));
});
const emails = async () => db.select().from(t.notification).where(eq(t.notification.channel, 'email'));
async function login(code: string, email: string, now = at(0)) {
  await sendVipOtp(db, code, email, now);
  const m = (await emails()).filter((x) => x.template === 'vip_otp').at(-1)!;
  const otp = m.content.match(/驗證碼是 (\d{6})/)![1];
  return (await verifyVipOtp(db, code, otp, now)).token;
}
async function setup() {
  const vip = await setVipCard(db, '網管', { name: '陳秘書', email: 'vip@example.com' });
  const ch = await setVipCard(db, '網管', { name: '林公益', email: 'charity@example.com' }, 'charity');
  return { vip: vip!.code, ch: ch!.code, vt: await login(vip!.code, 'vip@example.com'), ct: await login(ch!.code, 'charity@example.com') };
}

describe('公益票卡連結', () => {
  it('兩條連結各管各的：VIP 只看 VIP、公益只看公益；驗證碼只寄各自的負責人', async () => {
    const a = await createVip(db, '網管', { name: '王董', phone: '', email: '', seatIds: ['V-1'], mode: 'none', cat: 'VIP' }, BASE);
    const b = await createVip(db, '網管', { name: '甲基金會', phone: '', email: 'g@x.org', seatIds: ['5-1', '5-2'], mode: 'none', cat: '公益', org: '甲基金會', holders: ['張三', '李四'] }, BASE);
    const { vip, ch, vt, ct } = await setup();
    expect(vip).not.toBe(ch);
    expect(await msg(sendVipOtp(db, ch, 'vip@example.com', at(5)))).toContain('沒有權限');
    expect(await msg(vipCardPage(db, ch, vt, at(1)))).toContain('驗證'); // VIP 的手機進不了公益頁
    const pv = await vipCardPage(db, vip, vt, at(1));
    const pc = await vipCardPage(db, ch, ct, at(1));
    expect(pv.cards.map((c) => c.orderId)).toEqual([a.orderId]);
    expect(pc.kind).toBe('charity');
    expect(pc.cards.map((c) => c.name).sort()).toEqual(['張三', '李四']);
    expect(pc.cards[0].email).toBe('g@x.org'); // 匯入帶入的 Email 預填，但沒寄
    expect((await emails()).filter((m) => m.template === 'order_confirmed')).toHaveLength(0);
    // 跨頁寄不行
    expect(await msg(vipCardSend(db, vip, vt, { orderId: b.orderId }, BASE, at(2)))).toContain('找不到');
    expect(await msg(vipCardSend(db, ch, ct, { orderId: a.orderId, email: 'x@y.com' }, BASE, at(2)))).toContain('找不到');
  });

  it('公益自己劃位：只能選「保留：公益」的空位（三樓）；Email 選填只存不寄', async () => {
    const { ch, ct } = await setup();
    const m = await vipCardSeatMap(db, ch, ct, at(1));
    expect(m.floors).toEqual(['3F']);
    expect(m.free).toBe(4);
    expect(m.seats.filter((s) => s.status === 'free').map((s) => s.id).sort()).toEqual([...pool].sort());
    const other = m.seats.find((s) => !pool.includes(s.id))!.id;
    expect(await msg(vipCardBook(db, ch, ct, { seats: [{ seatId: other, name: '甲' }] }, at(1)))).toContain('不能選');
    expect(await msg(vipCardBook(db, ch, ct, { seats: [{ seatId: '5-1', name: '甲' }] }, at(1)))).toContain('保留：公益');
    expect(await msg(vipCardBook(db, ch, ct, { seats: [{ seatId: pool[0], name: '甲', email: 'bad' }] }, at(1)))).toContain('Email');
    const n0 = (await emails()).length;
    await vipCardBook(db, ch, ct, { seats: [{ seatId: pool[0], name: '甲 主任', email: 'A@X.org' }, { seatId: pool[1], name: '乙 老師' }], org: '丙會' }, at(2));
    const p = await vipCardPage(db, ch, ct, at(3));
    expect(p.cards.map((c) => [c.name, c.email, c.org])).toEqual(expect.arrayContaining([['甲 主任', 'a@x.org', '丙會'], ['乙 老師', '', '丙會']]));
    expect((await emails()).length).toBe(n0); // 不寄信
    const [o] = await db.select().from(t.orders).where(eq(t.orders.buyerName, '甲 主任'));
    expect(o.vipCat).toBe('公益');
    expect(p.log.map((x) => x.what)).toEqual(['book', 'book']);
  });

  it('全部寄出（防誤寄）：先列出「還沒寄、有 Email」的；已寄過、沒 Email、別頁的不寄；Email 改過的跳過；寄完再按沒有要寄的', async () => {
    const a = await createVip(db, '網管', { name: '甲', phone: '', email: 'a@x.org', seatIds: ['5-1'], mode: 'none', cat: '公益' }, BASE);
    const b = await createVip(db, '網管', { name: '乙', phone: '', email: 'b@x.org', seatIds: ['5-2', '5-3'], mode: 'none', cat: '公益', holders: ['乙', '乙夫人'] }, BASE);
    const c = await createVip(db, '網管', { name: '丙', phone: '', email: '', seatIds: ['5-4'], mode: 'none', cat: '公益' }, BASE);
    const d = await createVip(db, '網管', { name: '丁', phone: '', email: 'd@x.org', seatIds: ['5-5'], mode: 'none', cat: '公益' }, BASE);
    await createVip(db, '網管', { name: 'VIP 戊', phone: '', email: 'vip5@x.org', seatIds: ['V-1'], mode: 'none', cat: 'VIP' }, BASE);
    const { ch, ct } = await setup();
    await vipCardSend(db, ch, ct, { orderId: a.orderId }, BASE, at(1)); // 甲已個別寄過
    await db.update(t.notification).set({ status: 'sent', sentAt: at(1) }).where(eq(t.notification.orderId, a.orderId));
    const pv = await vipCardSendAll(db, ch, ct, { dry: true }, BASE, at(5));
    expect(pv.list.map((x) => x.orderId).sort()).toEqual([b.orderId, d.orderId].sort());
    expect(pv.list.find((x) => x.orderId === b.orderId)).toMatchObject({ email: 'b@x.org', seats: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    expect(pv.sentCount).toBe(1);
    expect(pv.noEmail.map((x) => x.orderId)).toEqual([c.orderId]);
    expect((await emails()).filter((m) => m.template === 'order_confirmed')).toHaveLength(1); // 預覽不寄
    // 預覽後丁的 Email 被改：跳過；有人塞了不在清單（甲已寄、VIP）的也不寄
    await db.update(t.orders).set({ buyerEmail: 'd2@x.org' }).where(eq(t.orders.id, d.orderId));
    const r = await vipCardSendAll(db, ch, ct, { dry: false, pick: [...pv.list.map((x) => ({ orderId: x.orderId, email: x.email })), { orderId: a.orderId, email: 'a@x.org' }] }, BASE, at(6));
    expect(r.done.map((x) => x.orderId)).toEqual([b.orderId]);
    expect(r.skipped.map((x) => x.orderId).sort()).toEqual([d.orderId, a.orderId].sort());
    const sent = (await emails()).filter((m) => m.template === 'order_confirmed');
    expect(sent.map((m) => m.recipient).sort()).toEqual(['a@x.org', 'b@x.org']); // 沒有 d、d2、vip5、丙
    expect(sent.filter((m) => m.recipient === 'b@x.org')).toHaveLength(1); // 兩席合一封
    const again = await vipCardSendAll(db, ch, ct, { dry: true }, BASE, at(7));
    expect(again.list.map((x) => x.orderId)).toEqual([d.orderId]); // 只剩改過 Email 的丁（要重新核對）
  });

  it('確認收到：信裡有按鈕；打開頁面不算，要按「我收到了」；同一筆重寄同一條；錯的連結不行', async () => {
    const a = await createVip(db, '網管', { name: '王大明 董事長', phone: '', email: 'w@x.org', seatIds: ['V-1'], mode: 'none', cat: 'VIP' }, BASE);
    const { vip, vt } = await setup();
    await vipCardSend(db, vip, vt, { orderId: a.orderId }, BASE, at(1));
    const m = (await emails()).find((x) => x.template === 'order_confirmed')!;
    const url = m.content.match(/https:\/\/\S+\/vr\/(\S+)$/)!;
    const html = (await ticketMail(db, a.orderId, m.content)).html;
    expect(html).toContain('確認收到');
    expect(html).toContain(`/vr/${url[1]}`);
    const v = await receiptView(db, url[1]);
    expect(v).toMatchObject({ confirmedAt: null, name: '王○○' });
    expect((await vipCardPage(db, vip, vt, at(2))).cards[0].receivedAt).toBeNull(); // 只打開不算
    await receiptConfirm(db, url[1], at(3));
    await receiptConfirm(db, url[1], at(9)); // 再按只記第一次
    expect((await vipCardPage(db, vip, vt, at(10))).cards[0].receivedAt).toBe(at(3).toISOString());
    expect(await msg(receiptView(db, `${a.orderId}-${'0'.repeat(20)}`))).toContain('不正確');
    expect(await msg(receiptView(db, 'abc'))).toContain('不正確');
    await vipCardSend(db, vip, vt, { orderId: a.orderId }, BASE, at(20));
    const m2 = (await emails()).filter((x) => x.template === 'order_confirmed').at(-1)!;
    expect(m2.content).toContain(url[1]);
    expect((await vipCardPage(db, vip, vt, at(21))).log.map((x) => x.what)).toEqual(['send', 'receipt', 'send']);
  });

  it('取消這席：同一筆其他座位 QR 不變、座位釋出、不寄信；已入場不行；只剩一席＝整筆取消；已有姓名不能改', async () => {
    const a = await createVip(db, '網管', { name: '甲會', phone: '', email: 'a@x.org', seatIds: ['5-1', '5-2', '5-3'], mode: 'none', cat: '公益', holders: ['張三', '李四', '王五'] }, BASE);
    const { ch, ct } = await setup();
    let p = await vipCardPage(db, ch, ct, at(1));
    const before = Object.fromEntries(p.cards.map((c) => [c.seatId, c.serial]));
    expect(await msg(vipCardName(db, ch, ct, { orderId: a.orderId, seatId: '5-2', name: '別人' }, at(1)))).toContain('取消這席');
    const n0 = (await db.select().from(t.notification)).length;
    // 第一席（序號 -01）取消：其他兩席序號不變
    await vipCardCancel(db, ch, ct, { orderId: a.orderId, seatId: '5-1' }, at(2));
    p = await vipCardPage(db, ch, ct, at(3));
    expect(p.cards.map((c) => c.seatId).sort()).toEqual(['5-2', '5-3']);
    for (const c of p.cards) expect(c.serial).toBe(before[c.seatId]);
    const [es] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, '5-1'));
    expect(es).toMatchObject({ status: 'free', orderId: null });
    expect((await db.select().from(t.notification)).length).toBe(n0);
    // 驗票：取消的舊 QR 不能入場、留下的照常
    await createGates(db, '網管', ['A 門']);
    const [g] = await db.select().from(t.gate);
    const sec = await qrSecret(db);
    const old = await scan(db, g.token, { qr: qrValue(sec, before['5-1']) }, at(2));
    expect(old.result).toBe('invalid');
    // 已入場的不能取消
    const ev = (await db.select().from(t.event))[0];
    await db.insert(t.checkin).values({ eventId: ev.id, serial: before['5-2'], orderId: a.orderId, seatId: '5-2' });
    expect(await msg(vipCardCancel(db, ch, ct, { orderId: a.orderId, seatId: '5-2' }, at(4)))).toContain('已經入場');
    await vipCardCancel(db, ch, ct, { orderId: a.orderId, seatId: '5-3' }, at(5));
    // 單席：整筆取消
    const b = await createVip(db, '網管', { name: '乙', phone: '', email: '', seatIds: ['6-1'], mode: 'none', cat: '公益' }, BASE);
    await vipCardCancel(db, ch, ct, { orderId: b.orderId, seatId: '6-1' }, at(6));
    const [ob] = await db.select().from(t.orders).where(eq(t.orders.id, b.orderId));
    expect(ob.status).toBe('cancelled');
    p = await vipCardPage(db, ch, ct, at(7));
    expect(p.cards.map((c) => c.seatId)).toEqual(['5-2']);
    expect(p.log.filter((x) => x.what === 'cancel').map((x) => x.text)).toHaveLength(3);
    expect(p.log.find((x) => x.text.includes('張三'))!.text).toContain('舊 QR 已失效');
    // 取消後可以重新劃（VIP 頁不能劃 5-1 以外的公益保留席，這裡只確認座位已空出）
    expect(await msg(vipCardCancel(db, ch, ct, { orderId: b.orderId, seatId: '6-1' }, at(8)))).toContain('找不到');
  });
});
