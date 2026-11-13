import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { exportAll, importAll } from '@/lib/backup';
import { ensureFloor3 } from '@/lib/floor';
import { createVip } from '@/lib/vip';
import { resetSales } from '@/lib/reset';
import {
  addVenues, decideReg, getJoinSettings, editReg, joinMenu, joinUsages, mergeVenue, paintFloor3, presetFloor3, sendLinks, sendPickLinks, setJoinSettings, setRegVenue, submitJoin,
} from '@/lib/join';
import {
  clearJoinTest, deleteOwnReport, eraSales, fixOwnReport, deleteReport, joinAdminState, lockSlots, markSent, nextRound, pickPage, rejoinQueue, reportPage, restoreSlot, skipTurn, submitPick, submitReport, tickQueue, unlockSlots, uploadEra, voidSlot,
} from '@/lib/joinQueue';

let db: Db;
let ipN = 0;
const ip = () => `10.0.${Math.floor(++ipN / 200)}.${ipN % 200}`; // 每次換來源，不受防灌次數影響
const BASE = 'https://ticket.example.com';
const T0 = new Date('2026-11-20T10:00:00+08:00'); // 劃位時段內
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
});

const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };
const venueId = async (name: string) => (await db.select().from(t.joinVenue).where(eq(t.joinVenue.name, name)))[0].id;
let phoneN = 0;
const nextPhone = () => `09${String(10000000 + ++phoneN).slice(-8)}`;

/** 開放登記、建團練場、登記並核准，回傳 reg（含連結代碼） */
async function venueReg(name: string, email = `${name}@example.com`) {
  await setJoinSettings(db, '網管', { open: true });
  await addVenues(db, '網管', [name]);
  const r = await submitJoin(db, { venueId: await venueId(name), headName: `${name}負責人`, headPhone: nextPhone(), email }, ip());
  await decideReg(db, '網管', r.id, 'approved');
  return (await db.select().from(t.joinReg).where(eq(t.joinReg.id, r.id)))[0];
}
async function eraList(orders: [string, number][]) { await uploadEra(db, '網管', orders.map(([orderNo, qty]) => ({ orderNo, qty, status: 'sold' }))); }
const report = (code: string, rows: [string, number | string][], reporter = '志工甲', now = T0) =>
  submitReport(db, code, { reporter, rows: rows.map(([orderNo, qty]) => ({ orderNo, qty })) }, ip(), now, BASE);
/** 三樓左側斜區前 n 個座位塗成贈席 */
async function giftSeats(n: number) {
  const seats = await db.select({ id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y }).from(t.venueSeat).where(and(eq(t.venueSeat.floor, '3F'), inArray(t.venueSeat.block, ['L2', 'R2']))).orderBy(t.venueSeat.y, t.venueSeat.x);
  const ids = seats.slice(0, n).map((s) => s.id);
  await paintFloor3(db, '網管', 'gift', ids);
  return ids;
}
const mails = async (template: string) => db.select().from(t.notification).where(eq(t.notification.template, template));
const slotsOf = async (regId: number) => db.select().from(t.joinSlot).where(eq(t.joinSlot.regId, regId)).orderBy(t.joinSlot.no);

describe('揪團登記（負責人 4 欄）', () => {
  it('預設關閉；開放後收 4 欄；Email 必填；一個團練場只能核准一位', async () => {
    await addVenues(db, '網管', ['台北微風小棧', '台北木柵']);
    expect((await joinMenu(db)).open).toBe(false);
    const v = await venueId('台北木柵');
    expect(await msg(submitJoin(db, { venueId: v, headName: '王', headPhone: '0912345678', email: 'a@b.co' }, ip()))).toContain('尚未開放');
    await setJoinSettings(db, '網管', { open: true, contact: '群票服務' });
    expect(await msg(submitJoin(db, { venueId: v, headName: '王', headPhone: '0912345678', email: '' }, ip()))).toContain('Email');
    expect(await msg(submitJoin(db, { venueId: v, headName: '王', headPhone: '0912345678', email: 'x@y' }, ip()))).toContain('格式');
    const a = await submitJoin(db, { venueId: v, headName: '王小明', headPhone: '0912-345-678', email: 'wang@example.com' }, ip());
    expect(a.contact).toBe('群票服務');
    expect(await msg(submitJoin(db, { venueId: v, headName: '陳', headPhone: '0912345678', email: 'c@example.com' }, ip()))).toContain('已經登記過');
    const b = await submitJoin(db, { venueId: v, headName: '陳', headPhone: '0922000111', email: 'c@example.com' }, ip());
    await decideReg(db, '網管', a.id, 'approved');
    expect(await msg(decideReg(db, '網管', b.id, 'approved'))).toContain('只能一位');
    expect(await msg(submitJoin(db, { venueId: v, headName: '林', headPhone: '0933000111', email: 'l@example.com' }, ip()))).toContain('已經有負責人');
    const [reg] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, a.id));
    expect(reg.reportCode).toBeTruthy();
    expect(reg.pickCode).toBeTruthy();
  });

  it('「其他」團練場要先指定才能核准；合併時兩邊都有負責人要先處理', async () => {
    await setJoinSettings(db, '網管', { open: true });
    const r = await submitJoin(db, { venueId: null, venueText: '新竹 竹北', headName: '陳', headPhone: '0966111222', email: 'c@example.com' }, ip());
    expect(await msg(decideReg(db, '網管', r.id, 'approved'))).toContain('先指定團練場');
    await setRegVenue(db, '網管', r.id, { newName: '新竹竹北' });
    await decideReg(db, '網管', r.id, 'approved');
    const other = await venueReg('竹北');
    expect(other.status).toBe('approved');
    expect(await msg(mergeVenue(db, '網管', await venueId('竹北'), await venueId('新竹竹北')))).toContain('兩邊都有');
  });

  it('連結分開寄：核准後只寄回報連結（含先收後核說明）；鎖定劃位序後才寄劃位連結，只寄有劃位序的', async () => {
    const reg = await venueReg('台北木柵');
    const other = await venueReg('台北微風小棧');
    expect(await sendLinks(db, '網管', BASE)).toEqual({ sent: 2, noEmail: 0 });
    expect(await sendLinks(db, '網管', BASE)).toEqual({ sent: 0, noEmail: 0 });
    const m = (await mails('join_rlink')).find((x) => x.recipient === '台北木柵@example.com')!;
    expect(m.content).toContain(`${BASE}/join/r/${reg.reportCode}`);
    expect(m.content).not.toContain('/join/p/');
    expect(m.content).toContain('先收後核');
    await editReg(db, '網管', reg.id, { headName: '新負責人', headPhone: '0977123456', email: 'new@example.com' });
    expect(await sendLinks(db, '網管', BASE, [reg.id])).toEqual({ sent: 1, noEmail: 0 });
    expect((await mails('join_rlink')).map((x) => x.recipient)).toContain('new@example.com');

    expect(await msg(sendPickLinks(db, '網管', BASE))).toContain('還沒鎖定');
    await eraList([['A1', 10]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    await report(reg.reportCode!, [['A1', 10]]);
    await lockSlots(db, '網管');
    expect(await sendPickLinks(db, '網管', BASE)).toEqual({ sent: 1, noEmail: 0 });
    expect(await sendPickLinks(db, '網管', BASE)).toEqual({ sent: 0, noEmail: 0 });
    const [pm] = await mails('join_plink');
    expect(pm.recipient).toBe('new@example.com');
    expect(pm.content).toContain(`${BASE}/join/p/${reg.pickCode}`);
    expect(pm.content).toContain('第 1 號');
    expect((await db.select().from(t.joinReg).where(eq(t.joinReg.id, other.id)))[0].pickSentAt).toBeNull();
  });
});

describe('志工回報：先收後核，劃位序依回報時間，鎖定後確定', () => {
  it('名單上有的當下核對；還沒有的先收「待核對」；上傳名單後自動核對；預計劃位序依回報時間', async () => {
    const a = await venueReg('台北木柵');
    const b = await venueReg('台北微風小棧');
    await eraList([['A001', 4], ['A002', 6]]);
    await uploadEra(db, '網管', [{ orderNo: 'R9', qty: 2, status: 'refunded' }]);
    expect(await msg(report(a.reportCode!, [['A001', 4]]))).toContain('沒有開放');
    await setJoinSettings(db, '網管', { reportOpen: true });

    const r1 = await report(a.reportCode!, [[' a001 ', 4], ['A002', 5], ['ZZZ1', 1], ['R9', 2], ['A001', 4], ['', 3], ['我的訂單', 1]], '志工甲', T0);
    expect(r1.accepted).toEqual([{ orderNo: 'A001', qty: 4, status: 'ok', note: '' }, { orderNo: 'ZZZ1', qty: 1, status: 'pending', note: '' }]);
    expect(r1.rejected.map((x) => x.reason)).toEqual(['張數不符（年代記錄為 6 張）', '此訂單已退票', '這次重複輸入了', '請輸入訂單編號（後 4 碼即可）', '訂單編號只能有英文字母、數字']);
    expect(r1).toMatchObject({ verified: 4, pending: 1, slots: [], next: 6 });

    // B 先回報一張名單上還沒有的 10 張（待核對），A 之後湊滿 10 張已核對
    const rb = await report(b.reportCode!, [['P100', 10]], '志工丙', at(1));
    expect(rb).toMatchObject({ verified: 0, pending: 10, slots: [] });
    expect((await report(b.reportCode!, [['A001', 4]], '志工丙', at(1))).rejected[0].reason).toContain('其他群');
    const r2 = await report(a.reportCode!, [['A002', 6], ['A001', 4]], '志工乙', at(2));
    expect(r2.rejected[0].reason).toBe('本群已回報過');
    expect(r2).toMatchObject({ verified: 10, slots: [1] });

    // 年代名單更新：P100 核對通過；B 回報較早，排到第 1 號，A 變第 2 號
    const up = await uploadEra(db, '網管', [{ orderNo: 'P100', qty: 10, status: 'sold' }]);
    expect(up).toMatchObject({ newlyVerified: 1, pending: 1 });
    expect((await reportPage(db, b.reportCode!)).slots).toEqual([1]);
    const page = await reportPage(db, a.reportCode!);
    expect(page).toMatchObject({ venue: '台北木柵', orders: 3, verified: 10, pending: 1, slots: [2], locked: false });
    expect(page.list.map((x) => [x.orderNo, x.status])).toEqual([['A001', 'ok'], ['ZZZ1', 'pending'], ['A002', 'ok']]);

    // 後來發現張數不符、退票：不計入
    await uploadEra(db, '網管', [{ orderNo: 'ZZZ1', qty: 3, status: 'sold' }, { orderNo: 'P100', qty: 10, status: 'refunded' }]);
    expect((await reportPage(db, a.reportCode!)).list.find((x) => x.orderNo === 'ZZZ1')).toMatchObject({ status: 'mismatch', eraQty: 3 });
    expect(await reportPage(db, b.reportCode!)).toMatchObject({ verified: 0, bad: 1, slots: [] });
    expect((await reportPage(db, a.reportCode!)).slots).toEqual([1]);
    const st = await joinAdminState(db, BASE, at(3));
    expect(st.locked).toBe(false);
    expect(st.provisional.map((x) => x.venue)).toEqual(['台北木柵']);
  });

  it('志工可刪自己打錯的；鎖定＝關閉回報、確定劃位序（待核對不算）；還沒開始劃位可解除鎖定', async () => {
    const a = await venueReg('台北木柵');
    const b = await venueReg('台北微風小棧');
    await eraList([['A1', 10], ['B1', 10]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    await report(b.reportCode!, [['B1', 10]], '丙', T0);
    await report(a.reportCode!, [['A1', 10], ['TYPO1', 2], ['WAIT1', 10]], '甲', at(1));
    const idOf = async (code: string, no: string) => (await reportPage(db, code)).list.find((x) => x.key === no)!.id;
    expect(await msg(deleteOwnReport(db, a.reportCode!, 99999, '甲'))).toContain('找不到');
    await deleteOwnReport(db, a.reportCode!, await idOf(a.reportCode!, 'TYPO1'), '甲');
    expect((await reportPage(db, a.reportCode!)).list.map((x) => x.key)).toEqual(['A1', 'WAIT1']);
    expect(await msg(deleteOwnReport(db, b.reportCode!, await idOf(a.reportCode!, 'A1'), '丙'))).toContain('找不到');
    expect((await pickPage(db, a.pickCode!, at(2), BASE)).locked).toBe(false);

    expect(await lockSlots(db, '網管', at(2))).toMatchObject({ slots: 2, venues: 2, notCounted: 1 });
    expect(await msg(lockSlots(db, '網管'))).toContain('已經鎖定');
    expect((await joinAdminState(db, BASE, at(2))).settings.reportOpen).toBe(false);
    expect(await msg(report(a.reportCode!, [['X9', 1]]))).toContain('沒有開放');
    expect(await msg(deleteOwnReport(db, a.reportCode!, await idOf(a.reportCode!, 'WAIT1'), '甲'))).toContain('截止');
    expect((await slotsOf(b.id)).map((x) => x.no)).toEqual([1]);
    expect((await slotsOf(a.id)).map((x) => x.no)).toEqual([2]);
    // 鎖定後名單才核對通過：不會多給劃位序（重新整理頁面看到的是正式的）
    await uploadEra(db, '網管', [{ orderNo: 'WAIT1', qty: 10, status: 'sold' }]);
    expect(await reportPage(db, a.reportCode!)).toMatchObject({ locked: true, verified: 20, slots: [2] });
    expect((await pickPage(db, a.pickCode!, at(3), BASE)).locked).toBe(true);
    // 解除鎖定後重新鎖定：WAIT1 算進去
    expect(await unlockSlots(db, '網管')).toEqual({ removed: 2 });
    expect((await lockSlots(db, '網管')).slots).toBe(3);
    await setJoinSettings(db, '網管', { pickOpen: true });
    expect(await msg(unlockSlots(db, '網管'))).toContain('已經開始');
  });

  it('一筆跨過好幾個 10 張：給好幾個連續劃位序；鎖定後刪回報不能讓劃位序不夠、不能改每幾張', async () => {
    const a = await venueReg('台北木柵');
    await eraList([['BIG', 25], ['S1', 1]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    expect((await report(a.reportCode!, [['BIG', 25]])).slots).toEqual([1, 2]);
    await setJoinSettings(db, '網管', { perSeat: 6 }); // 鎖定前可以改
    expect((await reportPage(db, a.reportCode!)).slots).toEqual([1, 2, 3, 4]);
    await setJoinSettings(db, '網管', { perSeat: 10 });
    await report(a.reportCode!, [['S1', 1]]);
    await lockSlots(db, '網管');
    const [rep] = await db.select().from(t.joinReport).where(eq(t.joinReport.orderNo, 'BIG'));
    expect(await msg(deleteReport(db, '網管', rep.id))).toContain('不夠');
    const [s1] = await db.select().from(t.joinReport).where(eq(t.joinReport.orderNo, 'S1'));
    await deleteReport(db, '網管', s1.id);
    expect(await msg(setJoinSettings(db, '網管', { perSeat: 5 }))).toContain('不能再改');
  });

  it('清除揪團測試資料：放回已選的贈席、清回報與名單；預設保留登記，勾選才連登記一起清', async () => {
    const a = await venueReg('台北木柵');
    await eraList([['T1', 10]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    await report(a.reportCode!, [['T1', 10]]);
    const seats = await giftSeats(3);
    await lockSlots(db, '網管');
    await sendPickLinks(db, '網管', BASE);
    await setJoinSettings(db, '網管', { pickOpen: true });
    await tickQueue(db, BASE, T0);
    await submitPick(db, a.pickCode!, { seatIds: [seats[0]], repName: '王', repPhone: '0912345678' }, T0, BASE);
    expect(await clearJoinTest(db, '網管')).toEqual({ slots: 1, seats: 1, reports: 1, era: 1, regs: 0 });
    const [es] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, seats[0]));
    expect(es.status).toBe('free');
    expect(es.usageId).toBeTruthy(); // 仍是揪團贈席
    const st = await joinAdminState(db, BASE, T0);
    expect(st.settings).toMatchObject({ reportOpen: false, pickOpen: false });
    expect(st.regs.find((r) => r.id === a.id)).toMatchObject({ status: 'approved', pickSentAt: null });
    expect(st.reports).toHaveLength(0);
    expect((await clearJoinTest(db, '網管', true)).regs).toBe(1);
    expect(await db.select().from(t.joinVenue)).toHaveLength(0);
  });
});

describe('自動輪號劃位', () => {
  async function setup() {
    const a = await venueReg('A場');
    const b = await venueReg('B場');
    const c = await venueReg('C場');
    const d = await venueReg('D場');
    await eraList([['A1', 20], ['B1', 10], ['C1', 10], ['D1', 10]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    await report(a.reportCode!, [['A1', 20]]); // 第 1、2 號
    await report(b.reportCode!, [['B1', 10]]); // 第 3 號
    await report(c.reportCode!, [['C1', 10]]); // 第 4 號
    await report(d.reportCode!, [['D1', 10]]); // 第 5 號
    await lockSlots(db, '網管');
    const seats = await giftSeats(12);
    return { a, b, c, d, seats };
  }

  it('一次只開放一位；連續序號一起選；送出後下一位自動開放；寄「輪到您了」「快輪到了」', async () => {
    const { a, b, c, seats } = await setup();
    expect(await msg(submitPick(db, a.pickCode!, { seatIds: seats.slice(0, 2), repName: '王', repPhone: '0912345678' }, T0))).toContain('不是您的劃位時間');
    await setJoinSettings(db, '網管', { pickOpen: true, notifyAhead: 2 });
    await tickQueue(db, BASE, T0);
    const pa = await pickPage(db, a.pickCode!, T0, BASE);
    expect(pa.current).toMatchObject({ nos: [1, 2], mine: true, seen: true });
    expect(pa.pickCount).toBe(2);
    expect((await pickPage(db, b.pickCode!, T0, BASE)).current).toMatchObject({ mine: false, venue: 'A場' });
    expect((await mails('join_turn')).map((x) => x.recipient)).toEqual(['A場@example.com']);
    expect((await mails('join_soon')).map((x) => x.recipient).sort()).toEqual(['B場@example.com', 'C場@example.com']);

    expect(await msg(submitPick(db, a.pickCode!, { seatIds: seats.slice(0, 1), repName: '王', repPhone: '0912345678' }, at(1)))).toContain('要選 2 席');
    const ok = await submitPick(db, a.pickCode!, { seatIds: seats.slice(0, 2), repName: '王代表', repPhone: '0912-345-678' }, at(1), BASE);
    expect(ok.nos).toEqual([1, 2]);
    const [es] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, seats[0]));
    expect(es.status).toBe('sold');
    const pb = await pickPage(db, b.pickCode!, at(1), BASE);
    expect(pb.current).toMatchObject({ nos: [3], mine: true });
    expect(pb.board.filter((x) => x.status === 'done').map((x) => x.seat)).toHaveLength(2);
    expect(await msg(submitPick(db, b.pickCode!, { seatIds: [seats[0]], repName: '陳', repPhone: '0922333444' }, at(2)))).toContain('已被選走');
    const st = await joinAdminState(db, BASE, at(2));
    expect(st.current?.venue).toBe('B場');
    expect(st.slots.filter((x) => x.status === 'done').map((x) => x.repPhone)).toEqual(['0912345678', '0912345678']);
    expect((await pickPage(db, c.pickCode!, at(2), BASE)).queue.find((x) => x.mine)?.place).toBe(0);
  });

  it('叫不到：第 1 次延後 3 號、第 2 次排到最後、第 3 次暫停；按「我回來了」排到最後', async () => {
    const { a, b } = await setup();
    await setJoinSettings(db, '網管', { pickOpen: true, turnMin: 3, pushBack: 3, notifyAhead: 0 });
    await tickQueue(db, BASE, T0); // A（1、2 號）輪到，但沒打開
    await tickQueue(db, BASE, at(4)); // 3 分鐘到 → 延後 3 號，B 輪到
    let order = (await pickPage(db, b.pickCode!, at(4), BASE)).queue.map((x) => x.no);
    expect(order).toEqual([3, 4, 5, 1, 2]);
    expect((await mails('join_missed'))[0].content).toContain('已延後 3 號');
    // B 打開了（pickPage），10 分鐘選位時間內都還在
    await tickQueue(db, BASE, at(12));
    expect((await joinAdminState(db, BASE, at(12))).current?.venue).toBe('B場');
    await skipTurn(db, '網管'); // 後台跳過 B：算一次叫不到 → 延後 3 號（後面只剩 3 個，排到最後）
    await tickQueue(db, BASE, at(13));
    order = (await joinAdminState(db, BASE, at(13))).slots.filter((x) => x.status === 'wait' || x.status === 'turn').sort((p, q) => p.pos - q.pos).map((x) => x.no);
    expect(order).toEqual([4, 5, 1, 2, 3]);
    // A 再叫不到兩次：第 2 次排到最後、第 3 次暫停
    for (const now of [at(20), at(30), at(40), at(50), at(60), at(70), at(80), at(90), at(100), at(110)]) await tickQueue(db, BASE, now);
    const sa = await slotsOf(a.id);
    expect(sa.map((x) => x.status)).toEqual(['skip', 'skip']);
    expect((await mails('join_missed')).some((x) => x.content.includes('我回來了'))).toBe(true);
    await rejoinQueue(db, a.pickCode!);
    expect((await slotsOf(a.id)).map((x) => [x.status, x.misses])).toEqual([['wait', 2], ['wait', 2]]);
  });

  it('時段外、暫停時不開始新的一輪', async () => {
    const { a } = await setup();
    await setJoinSettings(db, '網管', { pickOpen: true, paused: true });
    await tickQueue(db, BASE, T0);
    expect((await pickPage(db, a.pickCode!, T0, BASE)).current).toBeNull();
    await setJoinSettings(db, '網管', { paused: false, hourFrom: '09:00', hourTo: '21:00' });
    await tickQueue(db, BASE, new Date('2026-11-20T22:30:00+08:00'));
    expect((await pickPage(db, a.pickCode!, new Date('2026-11-20T22:30:00+08:00'), BASE)).current).toBeNull();
    await tickQueue(db, BASE, new Date('2026-11-21T09:00:00+08:00'));
    expect((await joinAdminState(db, BASE, new Date('2026-11-21T09:00:00+08:00'))).current?.nos).toEqual([1, 2]);
  });

  it('只能選揪團贈席；取消劃位序把座位放回；已送年代要先取消才能改', async () => {
    const { a, seats } = await setup();
    await setJoinSettings(db, '網管', { pickOpen: true });
    await tickQueue(db, BASE, T0);
    const [plain] = await db.select({ id: t.venueSeat.id }).from(t.venueSeat).where(and(eq(t.venueSeat.floor, '3F'), eq(t.venueSeat.rowNo, 27))).limit(1);
    expect(await msg(submitPick(db, a.pickCode!, { seatIds: [seats[0], plain.id], repName: '王', repPhone: '0912345678' }, T0))).toContain('揪團贈席');
    await submitPick(db, a.pickCode!, { seatIds: [seats[0], seats[1]], repName: '王', repPhone: '0912345678' }, T0, BASE);
    expect(await markSent(db, '網管', true)).toEqual({ count: 2 });
    const [s1] = await slotsOf(a.id);
    expect(await msg(voidSlot(db, '網管', s1.id, '退票'))).toContain('已送年代');
    await markSent(db, '網管', false, [s1.id]);
    await voidSlot(db, '網管', s1.id, '退票');
    const [es] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, s1.seatId!));
    expect(es.status).toBe('free');
    expect(await msg(restoreSlot(db, '網管', s1.id))).toContain('暫停排隊');
  });

  it('招待不能用揪團贈席、年代售出的座位；清除測試資料（保留連結）不會放掉已選的贈席', async () => {
    const { a, seats } = await setup();
    const ev = (await db.select().from(t.event))[0];
    const u = await joinUsages(db, ev.id);
    expect(u.gift).toBeGreaterThan(0);
    expect(await msg(createVip(db, '網管', { name: '貴賓', phone: '', email: '', seatIds: [seats[5]], mode: 'none' }))).toContain('揪團贈席');
    await setJoinSettings(db, '網管', { pickOpen: true });
    await tickQueue(db, BASE, T0);
    await submitPick(db, a.pickCode!, { seatIds: [seats[0], seats[1]], repName: '王', repPhone: '0912345678' }, T0, BASE);
    const [lk] = await db.insert(t.inviteLink).values({ eventId: ev.id, code: 'KEEP0001', name: 'x', phone: '', quota: 1, expiresAt: new Date('2027-01-01') }).returning();
    await resetSales(db, '網管', { keepLinkIds: [lk.id] });
    const [es] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, seats[0]));
    expect(es.status).toBe('sold');
    await resetSales(db, '網管', {});
    expect(await db.select().from(t.joinSlot)).toHaveLength(0);
    const [es2] = await db.select().from(t.eventSeat).where(eq(t.eventSeat.seatId, seats[0]));
    expect(es2.status).toBe('free');
  });
});

describe('備份', () => {
  it('包含揪團資料；沒有新資料表的舊備份照樣能還原', async () => {
    const a = await venueReg('台北木柵');
    await eraList([['A1', 10]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    await report(a.reportCode!, [['A1', 10]]);
    await lockSlots(db, '網管');
    const b = await exportAll(db);
    expect(b.tables.join_slot).toHaveLength(1);
    const db2 = await createPgliteDb();
    await importAll(db2, b);
    expect(await db2.select().from(t.joinReport)).toHaveLength(1);
    const old = { ...b, tables: { ...b.tables } };
    for (const k of ['join_venue', 'join_reg', 'join_leader', 'join_era', 'join_report', 'join_slot']) delete old.tables[k];
    const db3 = await createPgliteDb();
    await importAll(db3, old);
    expect(await db3.select().from(t.joinSlot)).toHaveLength(0);
  });
});

describe('志工只輸入訂單編號後 4 碼', () => {
  const era = (rows: [string, number, string?][]) =>
    uploadEra(db, '網管', rows.map(([orderNo, qty, soldAt]) => ({ orderNo, qty, status: 'sold' as const, soldAt: soldAt ?? null })));

  it('名單上只有一筆對得到：當下核對並記下完整編號；票號 -1、完整編號也可以', async () => {
    const a = await venueReg('台北木柵');
    await era([['ER2611120000109', 6], ['ER2611120000108', 1], ['ER2611120000222', 2]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    const r = await report(a.reportCode!, [['0109', 6], ['er2611120000108-1', 1], ['109', 1], ['0222', 3]]);
    expect(r.accepted).toEqual([{ orderNo: 'ER2611120000109', qty: 6, status: 'ok', note: '' }, { orderNo: 'ER2611120000108', qty: 1, status: 'ok', note: '' }]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['請輸入「-」前面最後 4 個數字（或完整訂單編號）', '年代記錄後 4 碼 0222 的訂單是 2 張。請確認張數；若不是這筆，請輸入完整訂單編號']);
    expect((await reportPage(db, a.reportCode!)).list[0]).toMatchObject({ key: '0109', orderNo: 'ER2611120000109', status: 'ok' });
    // 同一筆再報：後 4 碼、完整編號都擋
    expect((await report(a.reportCode!, [['0109', 6]])).rejected[0].reason).toContain('本群已回報過 0109');
    expect((await report(a.reportCode!, [['ER2611120000109', 6]])).rejected[0].reason).toBe('本群已回報過');
  });

  it('名單上有兩筆後 4 碼、張數都一樣：請他輸入完整編號', async () => {
    const a = await venueReg('台北木柵');
    await era([['ER2611120000109', 2], ['ER2611130000109', 2]]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    const r = await report(a.reportCode!, [['0109', 2]]);
    expect(r.rejected[0].reason).toBe('有好幾筆訂單後 4 碼都是 0109，請輸入完整訂單編號');
    expect((await report(a.reportCode!, [['ER2611130000109', 2]])).accepted[0].status).toBe('ok');
    // 本團練場已有一筆 …0109 × 2：後 4 碼再報會被當成重複，要用完整編號
    expect((await report(a.reportCode!, [['0109', 2]])).rejected[0].reason).toContain('本群已回報過 0109');
    expect((await report(a.reportCode!, [['ER2611120000109', 2]])).accepted[0]).toMatchObject({ orderNo: 'ER2611120000109', status: 'ok' });
  });

  it('先收後核：上傳名單時依回報先後認領；回報之後才賣出的不算；撞號的標「需補完整編號」並寄信，補上後保留回報時間', async () => {
    const a = await venueReg('台北木柵');
    const b = await venueReg('台北微風小棧');
    await setJoinSettings(db, '網管', { reportOpen: true });
    const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 13, h - 8, m));
    await report(a.reportCode!, [['0109', 6], ['0300', 2]], '甲', T(10));
    await report(b.reportCode!, [['0109', 6], ['0500', 3]], '丙', T(11)); // 允許兩個團練場都報 0109
    await report(b.reportCode!, [['0777', 1]], '丙', T(9));
    expect((await reportPage(db, a.reportCode!)).list.map((x) => x.status)).toEqual(['pending', 'pending']);
    const up = await era([
      ['ER2611130000109', 6, '2026-11-13T09:50:00+08:00'], // 甲 10:00 報、丙 11:00 報 → 甲先認領
      ['ER2611130010109', 6, '2026-11-13T10:30:00+08:00'], // 10:30 才賣：甲不能拿，丙可以
      ['ER2611130000300', 2, '2026-11-13T09:00:00+08:00'], ['ER2611120000300', 2, '2026-11-12T15:00:00+08:00'], // 撞號
      ['ER2611130000500', 3, '2026-11-13T12:00:00+08:00'], // 回報之後才賣出：不算，標「回報早於購買」
      ['ER2611130000777', 1, '2026-11-13T09:04:00+08:00'], // 9:00 報、9:04 賣：5 分鐘誤差內
    ]);
    expect(up).toMatchObject({ newlyVerified: 3, ambiguous: 1, pending: 0, early: 1, mailed: 2 });
    const pa = await reportPage(db, a.reportCode!);
    expect(pa.list.map((x) => [x.key, x.orderNo, x.status])).toEqual([['0109', 'ER2611130000109', 'ok'], ['0300', null, 'ambiguous']]);
    const pb = await reportPage(db, b.reportCode!);
    expect(pb.list.map((x) => [x.key, x.orderNo, x.status])).toEqual([['0109', 'ER2611130010109', 'ok'], ['0500', null, 'early'], ['0777', 'ER2611130000777', 'ok']]);
    expect(pb.list[1].note).toContain('11/13 12:00 才售出，晚於回報時間 11/13 11:00');
    const ms = await mails('join_issue');
    const fm = ms.find((x) => x.recipient === '台北木柵@example.com')!;
    expect(fm.content).toContain('0300');
    expect(fm.content).toContain('需補完整編號');
    expect(ms.find((x) => x.recipient === '台北微風小棧@example.com')!.content).toContain('回報早於購買');
    // 再上傳一次不重寄
    await era([['ER2611130000109', 6]]);
    expect(await mails('join_issue')).toHaveLength(2);

    const id = pa.list[1].id;
    expect(await msg(fixOwnReport(db, a.reportCode!, id, '0300', '甲'))).toContain('完整訂單編號');
    expect(await msg(fixOwnReport(db, a.reportCode!, id, 'ER2611130000301', '甲'))).toContain('要是 0300');
    expect(await fixOwnReport(db, a.reportCode!, id, 'er2611120000300', '甲')).toEqual({ orderNo: 'ER2611120000300', status: 'ok' });
    const after = (await reportPage(db, a.reportCode!)).list[1];
    expect(after).toMatchObject({ key: 'ER2611120000300', status: 'ok' });
    expect(after.at).toBe(T(10).toISOString());
  });
});

describe('後 4 碼＋購買日期（預設今天，可改）', () => {
  const send = (code: string, buyDate: string, rows: [string, number][], now: Date) =>
    submitReport(db, code, { reporter: '甲', buyDate, rows: rows.map(([orderNo, qty]) => ({ orderNo, qty })) }, ip(), now, BASE);
  const N = new Date('2026-11-14T10:00:00+08:00');

  it('只在那一天的訂單裡找：不同天同後 4 碼不撞號；不能選未來日期；補完整編號要同一天', async () => {
    const a = await venueReg('台北木柵');
    await uploadEra(db, '網管', [['ER2611130000109', 6], ['ER2611140000109', 6], ['ER2611130000222', 2]].map(([orderNo, qty]) => ({ orderNo: orderNo as string, qty: qty as number, status: 'sold' as const })));
    await setJoinSettings(db, '網管', { reportOpen: true });
    expect((await send(a.reportCode!, '2026-11-14', [['0109', 6]], N)).accepted[0]).toMatchObject({ orderNo: 'ER2611140000109', status: 'ok' });
    expect((await send(a.reportCode!, '2026-11-13', [['0109', 6]], N)).accepted[0]).toMatchObject({ orderNo: 'ER2611130000109', status: 'ok' });
    expect((await send(a.reportCode!, '2026-11-14', [['0109', 6]], N)).rejected[0].reason).toContain('本群已回報過 11/14 0109');
    expect(await msg(send(a.reportCode!, '2026-11-15', [['0109', 6]], N))).toContain('購買日期不正確');
    // 11/14 的 0222 還不在名單上：待核對；11/13 的 0222 不會被拿走
    const r = await send(a.reportCode!, '2026-11-14', [['0222', 2], ['0333', 1]], N);
    expect(r.accepted.map((x) => x.status)).toEqual(['pending', 'pending']);
    await uploadEra(db, '網管', [{ orderNo: 'ER2611140000222', qty: 2, status: 'sold', soldAt: '2026-11-14T09:30:00+08:00' }]);
    const list = (await reportPage(db, a.reportCode!)).list;
    expect(list.find((x) => x.key === '0222')).toMatchObject({ orderNo: 'ER2611140000222', status: 'ok', buyDate: '261114' });
    const id = list.find((x) => x.key === '0333')!.id;
    expect(await msg(fixOwnReport(db, a.reportCode!, id, 'ER2611130000333', '甲'))).toContain('日期不同');
    expect(await fixOwnReport(db, a.reportCode!, id, 'ER2611140000333', '甲')).toEqual({ orderNo: 'ER2611140000333', status: 'pending' });
  });
});

describe('核對不藏錯：非銀區、日期選錯、回報早於購買、找不到訂單、通知負責人', () => {
  const send = (code: string, buyDate: string, rows: [string, number][], now: Date, reporter = '甲') =>
    submitReport(db, code, { reporter, buyDate, rows: rows.map(([orderNo, qty]) => ({ orderNo, qty })) }, ip(), now, BASE);
  const up = (rows: { orderNo: string; qty: number; soldAt?: string; otherQty?: number; otherNote?: string }[]) =>
    uploadEra(db, '網管', rows.map((r) => ({ status: 'sold' as const, ...r })), new Date('2026-11-14T20:00:00+08:00'), BASE);
  const N = new Date('2026-11-14T10:00:00+08:00');

  it('非銀區（1000 元、4 樓）送出當下就說明不計；混買說明銀區幾張', async () => {
    const a = await venueReg('台北木柵');
    await up([
      { orderNo: 'ER2611140000012', qty: 0, otherQty: 2, otherNote: '4樓 2 張', soldAt: '2026-11-14T09:00:00+08:00' },
      { orderNo: 'ER2611140000011', qty: 2, otherQty: 1, otherNote: '售價 1000 1 張', soldAt: '2026-11-14T09:00:00+08:00' },
    ]);
    await setJoinSettings(db, '網管', { reportOpen: true });
    const r = await send(a.reportCode!, '2026-11-14', [['0012', 2], ['0011', 3]], N);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['非銀區（4樓 2 張），不計贈票', '這筆訂單銀區只有 2 張（售價 1000 1 張 不計贈票）。請把張數改成 2 張']);
    const ok = await send(a.reportCode!, '2026-11-14', [['0011', 2]], N);
    expect(ok.accepted[0]).toMatchObject({ orderNo: 'ER2611140000011', status: 'ok', note: '售價 1000 1 張 不計贈票' });
    expect(await msg(fixOwnReport(db, a.reportCode!, 0, 'ER2611140000012', '甲'))).toContain('找不到');
  });

  it('名單還沒到時先收；上傳後：非銀區、日期選錯自動更正、回報早於購買、找不到訂單；每群寄一封信', async () => {
    const a = await venueReg('台北木柵');
    const b = await venueReg('台北微風小棧');
    await setJoinSettings(db, '網管', { reportOpen: true });
    await send(a.reportCode!, '2026-11-14', [['0012', 2], ['0109', 6], ['0444', 4]], N, '甲'); // 0109 其實是 11/13 買的
    await send(b.reportCode!, '2026-11-14', [['0555', 1], ['0011', 13]], new Date('2026-11-14T08:00:00+08:00'), '乙');
    const res = await up([
      { orderNo: 'ER2611140000012', qty: 0, otherQty: 2, otherNote: '4樓 2 張', soldAt: '2026-11-14T09:00:00+08:00' },
      { orderNo: 'ER2611130000109', qty: 6, soldAt: '2026-11-13T11:36:00+08:00' },
      { orderNo: 'ER2611140000011', qty: 13, soldAt: '2026-11-14T08:49:00+08:00' }, // 乙 8:00 就報了
      { orderNo: 'ER2611140000999', qty: 1, soldAt: '2026-11-14T19:00:00+08:00' }, // 名單已涵蓋到 19:00
    ]);
    expect(res).toMatchObject({ newlyVerified: 1, dateFixed: 1, outsideReports: 1, early: 1, notfound: 2, mailed: 2 });
    const pa = (await reportPage(db, a.reportCode!)).list;
    expect(pa.map((x) => [x.key, x.status])).toEqual([['0012', 'outside'], ['0109', 'ok'], ['0444', 'notfound']]);
    expect(pa[1]).toMatchObject({ orderNo: 'ER2611130000109', buyDate: '261113', note: '購買日期已自動更正為 11/13' });
    expect(pa[2].note).toContain('仍找不到這筆');
    const pb = (await reportPage(db, b.reportCode!)).list;
    expect(pb.map((x) => x.status)).toEqual(['notfound', 'early']);
    expect(pb[1].note).toBe('年代記錄這筆訂單 11/14 08:49 才售出，晚於回報時間 11/14 08:00。請刪除後重新回報');
    const ms = await mails('join_issue');
    const ma = ms.find((x) => x.recipient === '台北木柵@example.com')!.content;
    expect(ma).toContain('有 2 筆回報需要修正');
    expect(ma).toContain('11/14 後 4 碼 0012（2 張，填寫人 甲）：非銀區');
    expect(ma).toContain(`${BASE}/join `);
    // 後台：名單看得到每筆被哪一群回報；只看有問題的看得到原因
    const st = await joinAdminState(db, BASE);
    expect(st.eraList.find((x) => x.orderNo === 'ER2611130000109')).toMatchObject({ group: '台北木柵', reportStatus: 'ok' });
    expect(st.eraList.find((x) => x.orderNo === 'ER2611140000999')).toMatchObject({ group: '', qty: 1 });
    expect(st.reports.find((x) => x.key === '0444')!.era).toContain('仍找不到這筆');
    // 再上傳同一份不重寄
    await up([{ orderNo: 'ER2611140000999', qty: 1, soldAt: '2026-11-14T19:00:00+08:00' }]);
    expect(await mails('join_issue')).toHaveLength(2);
  });
});

describe('三樓座位用途：贈席只在左2、右2；一鍵設定；志工席', () => {
  it('揪團贈席塗到中間會略過；一鍵設定兩側與中間；志工席不被一鍵覆蓋', async () => {
    const ev = (await db.select().from(t.event))[0];
    const u = await joinUsages(db, ev.id);
    const s3 = await db.select({ id: t.venueSeat.id, block: t.venueSeat.block }).from(t.venueSeat).where(eq(t.venueSeat.floor, '3F'));
    const side = s3.filter((s) => s.block === 'L2' || s.block === 'R2');
    const mid = s3.filter((s) => !['L2', 'R2'].includes(s.block));
    expect(side.length + mid.length).toBe(724);
    expect(await paintFloor3(db, '網管', 'gift', [mid[0].id, side[0].id])).toMatchObject({ updated: 1, notSide: 1 });
    expect(await paintFloor3(db, '網管', 'vol', side.slice(1, 4).map((s) => s.id))).toMatchObject({ updated: 3 });
    expect((await presetFloor3(db, '網管', 'side')).updated).toBe(side.length - 3);
    expect((await presetFloor3(db, '網管', 'middle')).updated).toBe(mid.length);
    const rows = await db.select({ usageId: t.eventSeat.usageId }).from(t.eventSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '3F')));
    const n = (id: number) => rows.filter((r) => r.usageId === id).length;
    expect([n(u.gift), n(u.vol), n(u.era)]).toEqual([side.length - 3, 3, mid.length]);
    // 年代銀區尚餘：中間 510 席 − 名單上已售的銀區張數（退票、非銀區不算）
    await uploadEra(db, '網管', [{ orderNo: 'E1', qty: 6, status: 'sold' }, { orderNo: 'E2', qty: 2, status: 'refunded' }, { orderNo: 'E3', qty: 0, otherQty: 3, otherNote: '4樓 3 張', status: 'sold' }]);
    expect(await eraSales(db, ev.id)).toMatchObject({ sold: 6, cap: 510, left: 504 });
  });
});

describe('分輪制：鎖定本輪 → 劃位 → 開放下一輪回報，號碼接續、零頭跨輪累計', () => {
  it('第 2 輪號碼接在後面；第 1 輪零頭累計；已選座位保留；劃位連結寄給有新號碼的；贈席不夠時停止給號', async () => {
    const a = await venueReg('A場');
    const b = await venueReg('B場');
    await eraList([['A1', 9], ['B1', 6], ['A2', 3], ['B2', 5], ['C9', 60]]);
    await setJoinSettings(db, '網管', { reportOpen: true, perSeat: 6 });
    await report(a.reportCode!, [['A1', 9]], '甲', at(0)); // A：第 1 號，零頭 3
    await report(b.reportCode!, [['B1', 6]], '乙', at(1)); // B：第 2 號
    const seats = await giftSeats(4);
    const r1 = await lockSlots(db, '網管');
    expect(r1).toMatchObject({ round: 1, slots: 2, from: 1, to: 2 });
    expect(await msg(report(a.reportCode!, [['A2', 3]], '甲', at(2)))).toContain('沒有開放');
    await sendPickLinks(db, '網管', BASE);
    expect(await mails('join_plink')).toHaveLength(2);
    // 第 1 輪劃位：A 選好
    await setJoinSettings(db, '網管', { pickOpen: true });
    await tickQueue(db, BASE, at(3));
    await submitPick(db, a.pickCode!, { seatIds: [seats[0]], repName: '王', repPhone: '0912345678' }, at(4), BASE);
    // 第 1 輪還沒選完也可以開下一輪回報
    expect(await nextRound(db, '網管')).toMatchObject({ round: 2, stillWaiting: 1 });
    expect((await getJoinSettings(db)).reportOpen).toBe(true);
    expect(await msg(unlockSlots(db, '網管'))).toContain('還沒鎖定');
    await report(a.reportCode!, [['A2', 3]], '甲', at(10)); // A：3+3＝6 → 第 3 號（零頭跨輪）
    await report(b.reportCode!, [['B2', 5]], '乙', at(11)); // B：5 張，還不到
    const pa = await reportPage(db, a.reportCode!);
    expect(pa).toMatchObject({ round: 2, locked: false, slots: [1, 3], fixed: [1] });
    const st = await joinAdminState(db, BASE);
    expect(st.provisional.map((x) => x.no)).toEqual([3]);
    const r2 = await lockSlots(db, '網管');
    expect(r2).toMatchObject({ round: 2, slots: 1, from: 3, to: 3 });
    expect((await slotsOf(a.id)).map((x) => [x.no, x.round, x.status])).toEqual([[1, 1, 'done'], [3, 2, 'wait']]);
    // 劃位連結：只寄給有新號碼的 A（B 已寄過、沒有新號碼）
    await sendPickLinks(db, '網管', BASE);
    const pl = await mails('join_plink');
    expect(pl).toHaveLength(3);
    expect(pl[2].recipient).toBe('A場@example.com');
    expect(pl[2].content).toContain('第 1、3 號');
    // 解除本輪鎖定只刪第 2 輪的
    expect(await unlockSlots(db, '網管')).toMatchObject({ removed: 1 });
    expect((await db.select().from(t.joinSlot)).length).toBe(2);
    // 贈席不夠：4 席贈席，已用 1、B 第 2 號還沒選 → 只剩 2 個號碼可給
    await setJoinSettings(db, '網管', { reportOpen: true });
    const c = await venueReg('C場');
    await report(c.reportCode!, [['C9', 60]], '丙', at(20)); // 10 個
    const r3 = await lockSlots(db, '網管');
    expect(r3).toMatchObject({ round: 2, slots: 2, from: 3, to: 4 });
    expect(r3.over).toBe(9);
    // 清除測試資料回到第 1 輪
    await clearJoinTest(db, '網管', false);
    expect((await getJoinSettings(db)).round).toBe(1);
  });
});
