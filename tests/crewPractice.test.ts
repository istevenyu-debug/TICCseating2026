import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { createGates, gateInfo, listGates, scan } from '@/lib/ticket';
import { PRACTICE_QR, clearPractice, liveAt, practiceStats, setLiveAt } from '@/lib/practice';
import { parseEraQr } from '@/lib/eraQr';
import { crewFriend, crewSignup, getLead, joinInfo, leadAction as leadAction0, leadState as leadState0, mailLead, renewLeadLink, saveLead, sendLeadOtp, setLeadActive, verifyLeadOtp } from '@/lib/crew';

// 系統管理員身分（後台登入）；驗證流程另外測
const ADM = { admin: '測試管理員' };
const leadState = (db: Db, token: string, base: string, now?: Date) => leadState0(db, token, ADM, base, now);
const leadAction = (db: Db, token: string, a: Parameters<typeof leadAction0>[3], base: string) => leadAction0(db, token, ADM, a, base);

const BASE = 'https://ticket.example.com';
const T0 = new Date('2026-11-29T10:00:00+08:00');
const LIVE = new Date('2026-12-09T17:00:00+08:00');
const before = new Date('2026-12-09T16:59:00+08:00');
const after = new Date('2026-12-09T17:01:00+08:00');
let db: Db; let tok: Record<string, string>; let qr: string;
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00') });
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
  await A.publish(db, 'admin');
  await createGates(db, 'admin', ['4F左-A', '4F左-B']);
  tok = Object.fromEntries((await listGates(db)).map((g) => [g.name, g.token]));
  const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
  const h = await holdSeats(db, 'AAA111', ['3-1'], single, T0);
  await submitOrder(db, 'AAA111', { orderId: h.orderId, buyer: { name: '王大明', phone: '0912345678', email: 'a@b.co' }, holders: [{ seatId: '3-1', name: '王大明', id4: 'A123' }], agree: true }, T0);
  await A.confirmPayment(db, 'admin', h.orderId, { date: '2026-11-29', amount: 3200 }, T0);
  qr = (await getBookingState(db, 'AAA111', T0)).orders[0].seats[0].qr!;
});

describe('練習模式：正式驗票時間前只算練習', () => {
  it('預設演出當天 17:00；之前掃＝練習（不寫入場紀錄）；同一支手機再掃＝已入場過，另一支照樣可以練；17:00 後正式入場', async () => {
    expect((await liveAt(db)).toISOString()).toBe(LIVE.toISOString());
    const r1 = await scan(db, tok['4F左-A'], { qr }, before);
    expect(r1).toMatchObject({ result: 'ok', practice: true, prac: 1, entered: 0 });
    expect(await db.select().from(t.checkin)).toHaveLength(0);
    expect((await scan(db, tok['4F左-A'], { qr }, before)).result).toBe('used');
    expect((await scan(db, tok['4F左-B'], { qr }, before)).result).toBe('ok');
    // 正式：練習過的票照樣可以入場一次
    const r2 = await scan(db, tok['4F左-A'], { qr }, after);
    expect(r2).toMatchObject({ result: 'ok', practice: false, entered: 1 });
    expect((await scan(db, tok['4F左-B'], { qr }, after))).toMatchObject({ result: 'used', gate: '4F左-A' });
    // 時間可以改
    await setLiveAt(db, 'admin', '2026-12-09T16:30:00+08:00');
    expect((await gateInfo(db, tok['4F左-A'], before)).practice).toBe(false);
  });

  it('特例練習票：練習時照劇本顯示；17:00 後一律「練習票，不可入場」；不會算進年代或入場', async () => {
    const s = (qr2: string) => scan(db, tok['4F左-A'], { qr: qr2 }, before);
    expect(await s(PRACTICE_QR.ok)).toMatchObject({ result: 'ok', practice: true });
    expect(await s(PRACTICE_QR.ok)).toMatchObject({ result: 'used' });
    expect(await s(PRACTICE_QR.used)).toMatchObject({ result: 'used' });
    expect(await s(PRACTICE_QR.cancel)).toMatchObject({ result: 'invalid' });
    expect(await s(PRACTICE_QR.vip)).toMatchObject({ result: 'ok', zoneName: 'VIP' });
    expect(await s(PRACTICE_QR.era)).toMatchObject({ result: 'ok', isEra: true });
    expect(await s(PRACTICE_QR.eraPaper)).toMatchObject({ result: 'ok', isEra: true, eraPaper: true });
    expect(await s(PRACTICE_QR.pending)).toMatchObject({ result: 'invalid' });
    expect(await s(PRACTICE_QR.invalid)).toMatchObject({ result: 'invalid' });
    expect(await scan(db, tok['4F左-A'], { serial: 'p-0001' }, before)).toMatchObject({ result: 'used' }); // 跟練習 QR 同一張
    expect(await scan(db, tok['4F左-A'], { paper: -1 }, before)).toMatchObject({ result: 'ok', giftPaper: true });
    for (const x of [PRACTICE_QR.ok, PRACTICE_QR.vip, PRACTICE_QR.era, PRACTICE_QR.eraPaper]) {
      expect(await scan(db, tok['4F左-B'], { qr: x }, after)).toMatchObject({ result: 'invalid', reason: expect.stringContaining('練習票') });
    }
    expect(await scan(db, tok['4F左-B'], { serial: 'P-0001' }, after)).toMatchObject({ result: 'invalid', reason: expect.stringContaining('練習票') });
    expect(await scan(db, tok['4F左-B'], { paper: -1 }, after)).toMatchObject({ result: 'invalid' });
    expect(await db.select().from(t.checkin)).toHaveLength(0);
    const st = await practiceStats(db);
    expect(st.total).toBeGreaterThan(8);
    expect(st.recent.some((x) => x.raw === PRACTICE_QR.invalid && x.result === 'invalid')).toBe(true);
  });

  it('年代紙本票：15 碼固定英數算年代（紙本），同一張只算一次；我們的 QR、網址、純數字不會被當成年代', async () => {
    expect(parseEraQr('D136DSP1IL8XQYN')).toEqual({ kind: 'era', id: 'D136DSP1IL8XQYN', paper: true });
    expect(parseEraQr('C136DSP1IGZL8E-23033250027')).toEqual({ kind: 'era', id: 'C136DSP1IGZL8E' });
    expect(parseEraQr(qr)).toBeNull();
    expect(parseEraQr('https://example.com/abc123def456')).toBeNull();
    expect(parseEraQr('123456789012345')).toBeNull();
    expect(parseEraQr('ABCDEFGHIJKLMNO')).toBeNull();
    const r = await scan(db, tok['4F左-A'], { qr: 'D136DSP1IL8XQYN' }, after);
    expect(r).toMatchObject({ result: 'ok', isEra: true, eraPaper: true, era: 1, total: 1 });
    expect(await scan(db, tok['4F左-B'], { qr: 'D136DSP1IL8XQYN' }, after)).toMatchObject({ result: 'used', isEra: true, gate: '4F左-A' });
  });

  it('清除練習資料：只刪練習，正式入場紀錄不動', async () => {
    await scan(db, tok['4F左-A'], { qr }, before);
    await scan(db, tok['4F左-A'], { qr: PRACTICE_QR.ok }, before);
    await scan(db, tok['4F左-B'], { qr }, after);
    expect((await clearPractice(db, 'admin')).count).toBe(2);
    expect(await db.select().from(t.checkinPractice)).toHaveLength(0);
    expect(await db.select().from(t.checkin)).toHaveLength(1);
  });
});

describe('驗票志工：報名、分配、寄連結（防誤寄）、換人換連結', () => {
  async function setupLead() {
    await saveLead(db, 'admin', { name: '林組長', email: 'lead@example.com', lineId: 'lead123' });
    return getLead(db);
  }
  const mails = async () => db.select().from(t.notification).where(eq(t.notification.template, 'crew_link'));

  it('連結：錯的、換新後舊的都不能用；寄管理連結只寄負責人', async () => {
    const l = await setupLead();
    expect(await msg(leadState(db, 'wrong', BASE))).toContain('不存在');
    expect(await msg(joinInfo(db, 'wrong'))).toContain('不存在');
    expect((await joinInfo(db, l.joinToken)).lineId).toBe('lead123');
    await mailLead(db, 'admin', BASE);
    const lm = await db.select().from(t.notification).where(eq(t.notification.template, 'crew_lead'));
    expect(lm.map((x) => x.recipient)).toEqual(['lead@example.com']);
    expect(lm[0].content).toContain(`/crew/m/${l.token}`);
    await renewLeadLink(db, 'admin', 'manage');
    expect(await msg(leadState(db, l.token, BASE))).toContain('不存在');
    expect(await msg(joinInfo(db, l.joinToken))).toBe(''); // 報名連結沒換
  });

  it('報名：必填檢查；同 Email 再填＝更新；加好友有記錄', async () => {
    const l = await setupLead();
    expect(await msg(crewSignup(db, l.joinToken, { name: '', email: 'a@x.co', phone: '0912345678' }))).toContain('姓名');
    expect(await msg(crewSignup(db, l.joinToken, { name: '王', email: 'bad', phone: '0912345678' }))).toContain('Email');
    expect(await msg(crewSignup(db, l.joinToken, { name: '王', email: 'a@x.co', phone: '12' }))).toContain('手機');
    const r1 = await crewSignup(db, l.joinToken, { name: '王小明', email: 'A@X.co', phone: '0912-345-678' });
    const r2 = await crewSignup(db, l.joinToken, { name: '王小明２', email: 'a@x.co', phone: '0912345678' });
    expect(r2).toMatchObject({ code: r1.code, again: true });
    await crewFriend(db, l.joinToken, r1.code);
    const st = await leadState(db, l.token, BASE);
    expect(st.crew).toHaveLength(1);
    expect(st.crew[0]).toMatchObject({ name: '王小明２', email: 'a@x.co', phone: '0912345678', friend: true, gateId: null });
  });

  it('分配＋一鍵寄：只寄已分配、有 Email、沒寄過的；再按 0 封；換位置要重寄；換人後舊連結失效', async () => {
    const l = await setupLead();
    const a = await crewSignup(db, l.joinToken, { name: '王小明', email: 'a@x.co', phone: '0912345678' });
    await crewSignup(db, l.joinToken, { name: '李美華', email: 'b@x.co', phone: '0912345679' });
    await crewSignup(db, l.joinToken, { name: '陳大同', email: 'c@x.co', phone: '0912345670' });
    await leadAction(db, l.token, { action: 'pos.add', names: ['5F右-A'] }, BASE);
    let st = await leadState(db, l.token, BASE);
    const id = (n: string) => st.crew.find((c) => c.name === n)!.id;
    const pos = (n: string) => st.positions.find((p) => p.name === n)!.id;
    await leadAction(db, l.token, { action: 'assign', gateId: pos('4F左-A'), crewId: id('王小明') }, BASE);
    await leadAction(db, l.token, { action: 'assign', gateId: pos('4F左-B'), crewId: id('李美華') }, BASE);
    const pv = await leadAction(db, l.token, { action: 'mail.preview' }, BASE) as { send: { id: number; email: string }[]; skipNoGate: number };
    expect(pv.send.map((x) => x.email).sort()).toEqual(['a@x.co', 'b@x.co']);
    expect(pv.skipNoGate).toBe(1);
    // 塞一個沒分配的人進 ids：伺服器擋掉
    expect(await leadAction(db, l.token, { action: 'mail.send', ids: [...pv.send.map((x) => x.id), id('陳大同')] }, BASE)).toEqual({ sent: 2 });
    expect((await mails()).map((x) => x.recipient).sort()).toEqual(['a@x.co', 'b@x.co']);
    expect((await mails())[0].content).toContain('/scan/');
    expect(await leadAction(db, l.token, { action: 'mail.send', ids: pv.send.map((x) => x.id) }, BASE)).toEqual({ sent: 0 });
    // 換人：4F左-A 改給陳大同 → 舊連結（已寄給王小明）失效
    const oldTok = tok['4F左-A'];
    const r = await leadAction(db, l.token, { action: 'assign', gateId: pos('4F左-A'), crewId: id('陳大同') }, BASE) as { renewed: boolean };
    expect(r.renewed).toBe(true);
    expect(await msg(gateInfo(db, oldTok))).toContain('不存在');
    st = await leadState(db, l.token, BASE);
    expect(st.crew.find((c) => c.name === '王小明')!.gateId).toBeNull();
    // 王小明改排到 5F右-A：他的舊信是 4F左-A 的 → 標「要重寄」，一鍵寄會寄給他和陳大同
    await leadAction(db, l.token, { action: 'assign', gateId: pos('5F右-A'), crewId: id('王小明') }, BASE);
    st = await leadState(db, l.token, BASE);
    expect(st.crew.find((c) => c.name === '王小明')!.mailStale).toBe(true);
    const pv2 = await leadAction(db, l.token, { action: 'mail.preview' }, BASE) as { send: { email: string; again: boolean }[] };
    expect(pv2.send.map((x) => x.email).sort()).toEqual(['a@x.co', 'c@x.co']);
    expect(pv2.send.find((x) => x.email === 'a@x.co')!.again).toBe(true);
    expect(a.code).toBeTruthy();
  });

  it('LINE 傳送：記錄時間、訊息含姓名位置連結；移除志工後連結換新；別的活動資料不受影響', async () => {
    const l = await setupLead();
    await crewSignup(db, l.joinToken, { name: '王小明', email: 'a@x.co', phone: '0912345678' });
    let st = await leadState(db, l.token, BASE);
    const cid = st.crew[0].id; const gid = st.positions.find((p) => p.name === '4F左-A')!.id;
    expect(await msg(leadAction(db, l.token, { action: 'line', crewId: cid }, BASE))).toContain('還沒分配');
    await leadAction(db, l.token, { action: 'assign', gateId: gid, crewId: cid }, BASE);
    st = await leadState(db, l.token, BASE);
    expect(st.crew[0].line).toContain('王小明');
    expect(st.crew[0].line).toContain('4F左-A');
    expect(st.crew[0].line).toContain(`/scan/${tok['4F左-A']}`);
    await leadAction(db, l.token, { action: 'line', crewId: cid }, BASE);
    expect((await leadState(db, l.token, BASE)).crew[0].lineAt).not.toBeNull();
    await leadAction(db, l.token, { action: 'crew.remove', crewId: cid }, BASE);
    expect(await msg(gateInfo(db, tok['4F左-A']))).toContain('不存在');
    expect((await leadState(db, l.token, BASE)).crew).toHaveLength(0);
    expect(await mails()).toHaveLength(0); // 全程沒按寄信就沒有信
  });

  it('狀態：打開連結＝已開啟、1 分鐘內有回報＝在線；練習張數', async () => {
    const l = await setupLead();
    const now = new Date('2026-12-05T19:00:00+08:00');
    await gateInfo(db, tok['4F左-A'], now);
    await scan(db, tok['4F左-A'], { qr }, now);
    const st = await leadState(db, l.token, BASE, new Date(now.getTime() + 30_000));
    const p = st.positions.find((x) => x.name === '4F左-A')!;
    expect(p).toMatchObject({ online: true, prac: 1, here: 0 });
    expect(p.openedAt).not.toBeNull();
    expect(p.kinds).toContain('我們的票');
    const later = await leadState(db, l.token, BASE, new Date(now.getTime() + 5 * 60_000));
    expect(later.positions.find((x) => x.name === '4F左-A')!.online).toBe(false);
    expect(later.positions.find((x) => x.name === '4F左-B')!.openedAt).toBeNull();
  });
});

describe('驗票管理頁驗證：只有負責人 Email；系統管理員直接進', () => {
  it('沒驗證不能看；Email 不對不寄；驗證碼對了這支手機可用；換 Email、換新連結後要重驗；停用時負責人不能用、系統管理員可以', async () => {
    await saveLead(db, 'admin', { name: '林組長', email: 'lead@example.com', lineId: 'lead123' });
    const l = await getLead(db);
    expect(await msg(leadState0(db, l.token, '', BASE))).toContain('驗證');
    expect(await msg(leadState0(db, l.token, 'random', BASE))).toContain('驗證');
    expect(await msg(sendLeadOtp(db, l.token, 'other@example.com'))).toContain('沒有權限');
    const now = new Date('2026-12-01T10:00:00+08:00');
    expect((await sendLeadOtp(db, l.token, 'LEAD@example.com', now)).sentTo).toBe('l***@example.com');
    expect(await msg(sendLeadOtp(db, l.token, 'lead@example.com', new Date(now.getTime() + 30_000)))).toContain('1 分鐘');
    const [n] = await db.select().from(t.notification).where(eq(t.notification.template, 'crew_otp'));
    expect(n.recipient).toBe('lead@example.com');
    const code = n.content.match(/驗證碼是 (\d{6})/)![1];
    expect(await msg(verifyLeadOtp(db, l.token, code === '000000' ? '111111' : '000000', now))).toContain('不對');
    const { token: dev } = await verifyLeadOtp(db, l.token, code, now);
    const st = await leadState0(db, l.token, dev, BASE, now);
    expect(st.asAdmin).toBe(false);
    expect(await msg(leadAction0(db, l.token, dev, { action: 'pos.add', names: ['2M-A'] }, BASE, now))).toBe('');
    // 演出當天 23:00 後失效
    expect(await msg(leadState0(db, l.token, dev, BASE, new Date('2026-12-09T23:30:00+08:00')))).toContain('驗證');
    // 停用：負責人不能用，系統管理員照樣可以看
    await setLeadActive(db, 'admin', false);
    expect(await msg(leadState0(db, l.token, dev, BASE, now))).toContain('停用');
    expect((await leadState0(db, l.token, ADM, BASE, now)).asAdmin).toBe(true);
    await setLeadActive(db, 'admin', true);
    // 換負責人 Email：已驗證的手機要重驗
    await saveLead(db, 'admin', { name: '林組長', email: 'new@example.com', lineId: 'lead123' });
    expect(await msg(leadState0(db, l.token, dev, BASE, now))).toContain('驗證');
  });
});

describe('負責人設定驗票位置', () => {
  it('新增、改名（不能重名）、停用（連結不能用）、刪除（已有正式入場的不能刪）', async () => {
    await saveLead(db, 'admin', { name: '林組長', email: 'lead@example.com', lineId: '' });
    const l = await getLead(db);
    await leadAction(db, l.token, { action: 'pos.add', names: ['2M-A', '2M-B'] }, BASE);
    let st = await leadState(db, l.token, BASE);
    const pid = (n: string) => st.positions.find((p) => p.name === n)!.id;
    expect(await msg(leadAction(db, l.token, { action: 'pos.edit', gateId: pid('2M-A'), name: '2M-B' }, BASE))).toContain('已經有');
    await leadAction(db, l.token, { action: 'pos.edit', gateId: pid('2M-A'), name: '2M 左門-A' }, BASE);
    st = await leadState(db, l.token, BASE);
    expect(st.positions.map((p) => p.name)).toContain('2M 左門-A');
    await leadAction(db, l.token, { action: 'pos.edit', gateId: pid('4F左-A'), active: false }, BASE);
    expect(await msg(gateInfo(db, tok['4F左-A']))).toContain('停用');
    // 4F左-B 有正式入場紀錄：不能刪
    await scan(db, tok['4F左-B'], { qr }, after);
    expect(await msg(leadAction(db, l.token, { action: 'pos.delete', gateId: pid('4F左-B') }, BASE))).toContain('不能刪除');
    // 2M-B 有人、有練習：可以刪，人回到未分配
    const c = await crewSignup(db, l.joinToken, { name: '王', email: 'w@x.co', phone: '0912345678' });
    st = await leadState(db, l.token, BASE);
    await leadAction(db, l.token, { action: 'assign', gateId: pid('2M-B'), crewId: st.crew[0].id }, BASE);
    await leadAction(db, l.token, { action: 'pos.delete', gateId: pid('2M-B') }, BASE);
    st = await leadState(db, l.token, BASE);
    expect(st.positions.map((p) => p.name)).not.toContain('2M-B');
    expect(st.crew[0].gateId).toBeNull();
    expect(c.code).toBeTruthy();
  });
});
