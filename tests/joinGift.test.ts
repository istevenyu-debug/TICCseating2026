import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { exportAll, importAll } from '@/lib/backup';
import { ensureFloor3 } from '@/lib/floor';
import { addVenues, decideReg, paintFloor3, setJoinSettings, submitJoin } from '@/lib/join';
import { clearJoinTest, pickPage, submitPick, submitReport, tickQueue, uploadEra, voidSlot } from '@/lib/joinQueue';
import {
  getGiftSettings, giftAdminState, giftSerial, giftTicketPage, resendGiftQr, saveGiftSeats, saveGiftSettings, sendGiftSurvey, DEFAULT_GIFT,
} from '@/lib/joinGift';
import { checkinList, checkinSummary, createGates, listGates, scan, searchTickets } from '@/lib/ticket';
import { giftQrMail } from '@/lib/notify';
import { qrSecret, qrValue } from '@/lib/qr';

let db: Db;
let ipN = 0;
const ip = () => `10.1.${Math.floor(++ipN / 200)}.${ipN % 200}`;
const BASE = 'https://ticket.example.com';
const T0 = new Date('2026-11-20T10:00:00+08:00');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const H = 3600_000;
let phoneN = 0;
const nextPhone = () => `09${String(20000000 + ++phoneN).slice(-8)}`;
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
});

async function venueReg(name: string, email = `${name}@example.com`) {
  await setJoinSettings(db, '網管', { open: true });
  await addVenues(db, '網管', [name]);
  const [v] = await db.select().from(t.joinVenue).where(eq(t.joinVenue.name, name));
  const r = await submitJoin(db, { venueId: v.id, headName: `${name}負責人`, headPhone: nextPhone(), email: email || 'x@example.com' }, ip());
  await decideReg(db, '網管', r.id, 'approved');
  if (!email) await db.update(t.joinReg).set({ email: '' }).where(eq(t.joinReg.id, r.id));
  return (await db.select().from(t.joinReg).where(eq(t.joinReg.id, r.id)))[0];
}
const reg = async (id: number) => (await db.select().from(t.joinReg).where(eq(t.joinReg.id, id)))[0];
const mails = async (template: string) => db.select().from(t.notification).where(eq(t.notification.template, template));
const slotsOf = async (regId: number) => db.select().from(t.joinSlot).where(eq(t.joinSlot.regId, regId)).orderBy(t.joinSlot.no);

/** A 群 3 席、C 群 2 席都劃好位；B 群有登記但沒有座位 */
async function setup() {
  const a = await venueReg('A場');
  const b = await venueReg('B場');
  const c = await venueReg('C場');
  const seats = await db.select({ id: t.venueSeat.id }).from(t.venueSeat).where(and(eq(t.venueSeat.floor, '3F'), inArray(t.venueSeat.block, ['L2', 'R2']))).orderBy(t.venueSeat.y, t.venueSeat.x);
  const ids = seats.slice(0, 5).map((s) => s.id);
  await paintFloor3(db, '網管', 'gift', ids);
  await uploadEra(db, '網管', [{ orderNo: 'A1', qty: 30, status: 'sold' }, { orderNo: 'C1', qty: 20, status: 'sold' }]);
  await setJoinSettings(db, '網管', { auto: true, reportOpen: true, pickOpen: true, hourFrom: '', hourTo: '' });
  await submitReport(db, a.reportCode!, { reporter: '甲', rows: [{ orderNo: 'A1', qty: 30 }] }, ip(), T0, BASE);
  await submitReport(db, c.reportCode!, { reporter: '丙', rows: [{ orderNo: 'C1', qty: 20 }] }, ip(), at(1), BASE);
  await tickQueue(db, BASE, at(2));
  await pickPage(db, a.pickCode!, at(2), BASE);
  await submitPick(db, a.pickCode!, { seatIds: ids.slice(0, 3), repName: '陳', repPhone: '0912345678' }, at(3), BASE);
  await pickPage(db, c.pickCode!, at(4), BASE);
  await submitPick(db, c.pickCode!, { seatIds: ids.slice(3, 5), repName: '林', repPhone: '0912345679' }, at(5), BASE);
  await db.delete(t.notification);
  return { a: await reg(a.id), b: await reg(b.id), c: await reg(c.id) };
}
async function gate() {
  await createGates(db, '網管', ['左1']);
  return (await listGates(db))[0].token;
}
const leader = async (code: string, now: Date) => (await pickPage(db, code, now, BASE)).gift;

describe('調查信：先試寄一群，再一鍵寄全部（不重寄、不誤寄）', () => {
  it('試寄只寄那一群；寄全部只寄沒寄過、有座位、有 Email 的；再按一次 0 封', async () => {
    const { a, b, c } = await setup();
    expect((await sendGiftSurvey(db, '網管', BASE, { dry: true })).count).toBe(2); // A、C；B 沒座位
    const r1 = await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    expect(r1.count).toBe(1);
    expect((await mails('join_gift')).map((x) => x.recipient)).toEqual(['A場@example.com']);
    // 試寄那群再按一次（非重寄）會擋下
    expect(await msg(sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(11)))).toContain('已經寄過');
    // B 沒有座位：單寄也擋下
    expect(await msg(sendGiftSurvey(db, '網管', BASE, { ids: [b.id] }, at(11)))).toContain('還沒有選好的座位');
    const r2 = await sendGiftSurvey(db, '網管', BASE, {}, at(20));
    expect(r2.count).toBe(1);
    expect((await mails('join_gift')).map((x) => x.recipient)).toEqual(['A場@example.com', 'C場@example.com']);
    expect((await sendGiftSurvey(db, '網管', BASE, {}, at(30))).count).toBe(0);
    expect(await mails('join_gift')).toHaveLength(2);
    // 重寄單一群：截止時間不變
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id], resend: true }, at(40));
    expect((await reg(a.id)).giftSentAt!.getTime()).toBe(at(10).getTime());
    expect(await mails('join_gift')).toHaveLength(3);
    expect(await msg(sendGiftSurvey(db, '網管', BASE, { resend: true }, at(41)))).toContain('一次一群');
    const m = (await mails('join_gift'))[0];
    expect(m.content).toContain(`${BASE}/join/p/${a.pickCode}`);
    expect(m.content).toContain('改用本活動專屬電子票 QR code（推薦）');
    expect(m.content).toContain('逾期未回覆將視為選擇');
    expect(c.giftSentAt).toBeNull();
  });

  it('沒有 Email 的群不寄（後台複製連結用 LINE 傳）', async () => {
    const { a } = await setup();
    await db.update(t.joinReg).set({ email: '' }).where(eq(t.joinReg.id, a.id));
    const r = await sendGiftSurvey(db, '網管', BASE, {}, at(10));
    expect(r.count).toBe(1);
    expect(r.skipped.noEmail).toBe(1);
    expect((await reg(a.id)).giftSentAt).toBeNull();
  });
});

describe('負責人劃位頁：每席選方式、填入座者', () => {
  it('調查信寄出前不顯示；寄出後每席預設負責人姓名、還沒有 QR', async () => {
    const { a } = await setup();
    expect(await leader(a.pickCode!, at(9))).toBeNull();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const g = (await leader(a.pickCode!, at(11)))!;
    expect(g.open).toBe(true);
    expect(g.seats).toHaveLength(3);
    expect(g.seats.every((x) => x.name === 'A場負責人' && !x.qr && !x.effectiveKey)).toBe(true);
    expect(g.options.map((o) => o.key)).toEqual(['qr', 'shop', 'mail', 'onsite']);
  });

  it('選 QR＋Email：寄一次 QR 信；同樣內容再存不重寄；換 Email 才再寄', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    const rows = s.map((x, i) => ({ slotId: x.slotId, optionKey: 'qr', name: ['王一', '王二', '王三'][i], email: i === 0 ? 'one@example.com' : '' }));
    const r = await saveGiftSeats(db, '負責人', a.id, { seats: rows }, at(12), BASE);
    expect(r).toEqual({ changed: 3, mailed: 1 });
    const qm = await mails('join_qr');
    expect(qm.map((x) => x.recipient)).toEqual(['one@example.com']);
    expect(qm[0].content).toContain('王一 您好');
    const g = (await leader(a.pickCode!, at(13)))!;
    expect(g.seats.every((x) => x.qr)).toBe(true);
    expect(g.seats[0].mailedTo).toBe('one@example.com');
    expect((await saveGiftSeats(db, '負責人', a.id, { seats: rows }, at(14), BASE)).mailed).toBe(0);
    rows[0].email = 'new@example.com';
    expect((await saveGiftSeats(db, '負責人', a.id, { seats: rows }, at(15), BASE)).mailed).toBe(1);
    expect((await mails('join_qr')).map((x) => x.recipient)).toEqual(['one@example.com', 'new@example.com']);
    // QR 信內容：內嵌 QR、連結是這一席
    const html = await giftQrMail(db, (await mails('join_qr'))[1].content);
    expect(html.attachments).toHaveLength(1);
    expect(html.html).toContain('揪團贈席入場 QR');
    // 重寄（負責人）：2 分鐘內擋下
    expect(await msg(resendGiftQr(db, '負責人', a.id, s[0].slotId, at(16), BASE))).toContain('2 分鐘');
    expect((await resendGiftQr(db, '負責人', a.id, s[0].slotId, at(20), BASE)).to).toBe('new@example.com');
  });

  it('改姓名：QR 換新版、舊 QR 與舊連結失效；舊 QR 信不寄出', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    const rows = s.map((x) => ({ slotId: x.slotId, optionKey: 'qr', name: '王一', email: 'one@example.com' }));
    await saveGiftSeats(db, '負責人', a.id, { seats: rows }, at(12), BASE);
    const old = (await leader(a.pickCode!, at(13)))!.seats[0];
    const oldMail = (await mails('join_qr'))[0];
    const [g0] = await db.select().from(t.joinGift).where(eq(t.joinGift.slotId, old.slotId));
    rows[0].name = '李四';
    await saveGiftSeats(db, '負責人', a.id, { seats: rows }, at(14), BASE);
    const now = (await leader(a.pickCode!, at(15)))!.seats[0];
    expect(now.qr!.serial).not.toBe(old.qr!.serial);
    expect(now.qr!.serial).toBe(giftSerial(old.no, 2));
    expect(await msg(giftTicketPage(db, g0.code))).toContain('已更換或無效');
    await expect(giftQrMail(db, oldMail.content)).rejects.toThrow('已更換');
    const tk = await giftTicketPage(db, now.qr!.url.split('/').pop()!, at(15));
    expect(tk.name).toBe('李四');
    const token = await gate();
    const sec = await qrSecret(db);
    const bad = await scan(db, token, { qr: qrValue(sec, old.qr!.serial) }, at(16));
    expect(bad.result).toBe('invalid');
    expect(bad.result === 'invalid' && bad.reason).toContain('已更換');
    const ok = await scan(db, token, { qr: now.qr!.value }, at(17));
    expect(ok.result).toBe('ok');
    expect(ok.result === 'ok' && ok.holderName).toBe('李四');
    expect((await scan(db, token, { qr: now.qr!.value }, at(18))).result).toBe('used');
    // 入場後不能再改姓名、不能改成紙本
    rows[0].name = '張五';
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [rows[0]] }, at(19), BASE))).toContain('已經入場');
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [{ ...rows[0], name: '李四', optionKey: 'shop' }] }, at(19), BASE))).toContain('已經入場');
  });

  it('紙本：不出 QR；從 QR 改紙本，原 QR 失效；郵寄要填地址與手機', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[0].slotId, optionKey: 'mail', name: '王一' }] }, at(12), BASE))).toContain('收件地址');
    await saveGiftSeats(db, '負責人', a.id, { seats: [
      { slotId: s[0].slotId, optionKey: 'mail', name: '王一', phone: '0911-222-333', address: '台北市信義區信義路五段 7 號' },
      { slotId: s[1].slotId, optionKey: 'shop', name: '王二' },
      { slotId: s[2].slotId, optionKey: 'qr', name: '王三' },
    ] }, at(12), BASE);
    let g = (await leader(a.pickCode!, at(13)))!;
    expect(g.seats.map((x) => !!x.qr)).toEqual([false, false, true]);
    expect(g.seats[0].phone).toBe('0911222333');
    const qr = g.seats[2].qr!;
    await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[2].slotId, optionKey: 'onsite', name: '王三' }] }, at(14), BASE);
    g = (await leader(a.pickCode!, at(15)))!;
    expect(g.seats[2].qr).toBeNull();
    const token = await gate();
    const r = await scan(db, token, { qr: qr.value }, at(16));
    expect(r.result).toBe('invalid');
    // 再改回 QR：新版序號（舊截圖仍無效）
    await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[2].slotId, optionKey: 'qr', name: '王三' }] }, at(17), BASE);
    g = (await leader(a.pickCode!, at(18)))!;
    expect(g.seats[2].qr!.serial).not.toBe(qr.serial);
    expect((await scan(db, token, { qr: qr.value }, at(19))).result).toBe('invalid');
    // 驗票搜尋：紙本的列出但沒有序號
    const found = await searchTickets(db, token, '王一');
    expect(found).toHaveLength(1);
    expect(found[0].serial).toBe('');
    expect(found[0].label).toContain('紙本票');
  });

  it('只能改自己群的座位；未寄調查信不能存', async () => {
    const { a, c } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const cs = await slotsOf(c.id);
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: cs[0].id, optionKey: 'qr', name: 'x' }] }, at(11), BASE))).toContain('重新整理');
    await pickPage(db, c.pickCode!, at(11), BASE); // 補建取票資料
    expect(await msg(saveGiftSeats(db, '負責人', c.id, { seats: [{ slotId: cs[0].id, optionKey: 'qr', name: 'x' }] }, at(11), BASE))).toContain('尚未開始');
  });
});

describe('回覆截止（做活的：寄出後幾小時）', () => {
  it('截止後不能改方式（姓名可改）；沒選的視為預設（QR），可以入場', async () => {
    const { a } = await setup();
    await saveGiftSettings(db, '網管', { ...DEFAULT_GIFT, hours: 24 });
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[0].slotId, optionKey: 'shop', name: '王一' }] }, at(12), BASE);
    const late = new Date(at(10).getTime() + 24 * H + 60_000);
    const g = (await leader(a.pickCode!, late))!;
    expect(g.open).toBe(false);
    expect(g.seats.map((x) => x.effectiveKey)).toEqual(['shop', 'qr', 'qr']);
    expect(g.seats[1].defaulted).toBe(true);
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[0].slotId, optionKey: 'qr', name: '王一' }] }, late, BASE))).toContain('截止');
    expect((await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[1].slotId, optionKey: 'qr', name: '陳二' }] }, late, BASE)).changed).toBe(1);
    // 後台不受截止限制
    expect((await saveGiftSeats(db, '網管', null, { seats: [{ slotId: s[0].slotId, optionKey: 'qr', name: '王一' }] }, late, BASE, true)).changed).toBe(1);
    const token = await gate();
    const g2 = (await leader(a.pickCode!, late))!;
    expect((await scan(db, token, { qr: g2.seats[2].qr!.value }, late)).result).toBe('ok');
    // 改成 48 小時：又可以改
    await saveGiftSettings(db, '網管', { ...DEFAULT_GIFT, hours: 48 });
    expect((await leader(a.pickCode!, late))!.open).toBe(true);
  });
});

describe('取票選項（做活的）', () => {
  it('可新增、改名、停用、排序；已有人選的不能刪、不能改類型；預設要是啟用的', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[0].slotId, optionKey: 'shop', name: '王一' }] }, at(12), BASE);
    const base = await getGiftSettings(db);
    expect(await msg(saveGiftSettings(db, '網管', { ...base, options: base.options.filter((o) => o.key !== 'shop') }))).toContain('不能刪除');
    expect(await msg(saveGiftSettings(db, '網管', { ...base, options: base.options.map((o) => (o.key === 'shop' ? { ...o, kind: 'qr' } : o)) }))).toContain('不能改類型');
    expect(await msg(saveGiftSettings(db, '網管', { ...base, defaultKey: 'qr', options: base.options.map((o) => (o.key === 'qr' ? { ...o, active: false } : o)) }))).toContain('預設');
    const v = await saveGiftSettings(db, '網管', {
      hours: 12, defaultKey: 'qr',
      options: [base.options[0], { ...base.options[1], name: '微風小棧自取', active: false }, base.options[3], { key: '', name: '團練場代領', desc: '', kind: 'paper', needAddress: false, active: true }],
    });
    expect(v.options).toHaveLength(4);
    expect(v.options[3].key).toMatch(/^[a-z0-9]{6}$/);
    const g = (await leader(a.pickCode!, at(13)))!;
    // 停用的選項：已選的群仍看得到；新選不能選
    expect(g.options.map((o) => o.name)).toContain('微風小棧自取');
    expect(await msg(saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[1].slotId, optionKey: 'shop', name: '王二' }] }, at(13), BASE))).toContain('不開放');
    expect((await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[1].slotId, optionKey: v.options[3].key, name: '王二' }] }, at(13), BASE)).changed).toBe(1);
  });
});

describe('驗票、入場名單、後台', () => {
  it('應到人數含贈席 QR；搜尋姓名、群名；斷線名單列出贈席；劃位序取消後 QR 無效', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, {}, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    await saveGiftSeats(db, '負責人', a.id, { seats: s.map((x, i) => ({ slotId: x.slotId, optionKey: i === 2 ? 'onsite' : 'qr', name: ['王一', '王二', '王三'][i] })) }, at(12), BASE);
    const token = await gate();
    const g = (await leader(a.pickCode!, at(13)))!;
    const r = await scan(db, token, { serial: g.seats[0].qr!.serial }, at(14));
    expect(r.result).toBe('ok');
    expect(r.total).toBe(2); // 只算選 QR 的 2 席（C 群還沒選、未截止）
    expect(r.entered).toBe(1);
    expect((await searchTickets(db, token, 'A場')).length).toBe(3);
    expect((await checkinSummary(db)).total).toBe(2);
    const list = await checkinList(db, 'seat');
    const mine = list.rows.filter((x) => x.zoneName === '揪團贈席');
    expect(mine).toHaveLength(5);
    expect(mine.filter((x) => x.serial.startsWith('JG'))).toHaveLength(2);
    expect(mine.find((x) => x.holderName === '王三')!.serial).toContain('紙本');
    expect(mine.find((x) => x.holderName === '王一')!.entered).not.toBeNull();
    // 後台狀態
    const st = await giftAdminState(db, BASE, at(15));
    expect(st.tally.find((x) => x.key === 'qr')!.seats).toBe(2);
    expect(st.undecided).toBe(2);
    expect(st.groups.map((x) => x.group)).toEqual(['A場', 'C場']);
    // 後台取消劃位序：QR 失效
    await voidSlot(db, '網管', s[1].slotId, '測試');
    expect((await scan(db, token, { qr: g.seats[1].qr!.value }, at(16))).result).toBe('invalid');
  });

  it('清除揪團測試資料：連贈席入場紀錄、調查信寄出時間一起清', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    const s = (await leader(a.pickCode!, at(11)))!.seats;
    await saveGiftSeats(db, '負責人', a.id, { seats: [{ slotId: s[0].slotId, optionKey: 'qr', name: '王一' }] }, at(12), BASE);
    const token = await gate();
    await scan(db, token, { serial: giftSerial(s[0].no, 1) }, at(13));
    expect(await db.select().from(t.checkin)).toHaveLength(1);
    await clearJoinTest(db, '網管');
    expect(await db.select().from(t.checkin)).toHaveLength(0);
    expect(await db.select().from(t.joinGift)).toHaveLength(0);
    expect((await reg(a.id)).giftSentAt).toBeNull();
  });

  it('備份含取票資料；沒有 join_gift 的舊備份照樣能還原', async () => {
    const { a } = await setup();
    await sendGiftSurvey(db, '網管', BASE, { ids: [a.id] }, at(10));
    await leader(a.pickCode!, at(11));
    const b = await exportAll(db);
    expect(b.tables.join_gift).toHaveLength(5); // 打開頁面時所有已選位的席都補建
    const db2 = await createPgliteDb();
    await importAll(db2, b);
    expect(await db2.select().from(t.joinGift)).toHaveLength(5);
    const old = { ...b, tables: { ...b.tables } };
    delete old.tables.join_gift;
    const db3 = await createPgliteDb();
    await importAll(db3, old);
    expect(await db3.select().from(t.joinGift)).toHaveLength(0);
  });
});
