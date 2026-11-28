import { beforeEach, describe, expect, it } from 'vitest';
import { setLiveAt } from '@/lib/practice';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { holdSeats, submitOrder } from '@/lib/booking';
import { checkinSummary, createGates, listGates, qrSecret, qrValue, scan, undoCheckin } from '@/lib/ticket';
import { eraFloorOf, parseEraQr } from '@/lib/eraQr';
import { boardAdminState, boardByToken, boardData, saveBoxCfg, updateBoardLink } from '@/lib/checkinBoard';
import { createVip, listVips, setVipCat } from '@/lib/vip';

const T0 = new Date('2026-11-15T10:00:00+08:00');
let db: Db; let tok: Record<string, string>; let eventId: number;

/** 2026-11-23 實際從年代 App 截圖解出來的 QR */
const REAL = {
  t1a: 'C136DSP1IGZL8E-23033250027', // 125-1，3:32
  t1b: 'C136DSP1IGZL8E-2304201302R', // 125-1，轉贈接收後 4:20
  t2a: 'C136DSP1IGZL8F-2303395102G', // 125-2，3:39
  t2b: 'C136DSP1IGZL8F-2303434202W', // 125-2，3:43
  t2c: 'C136DSP1IGZL8F-2303470602O', // 125-2，3:47
  t4: 'C136DSP1IGZL8H-2303473602B',
  t5: 'C136DSP1IGZL8I-23034744021',
  t6: 'C136DSP1IGZL8J-23034750029',
  o292: 'C136DSP1IHJCM9-2303475802O',
};

async function paidOrder(code: string, seats: string[], name = '王大明') {
  const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
  const h = await holdSeats(db, code, seats, single, T0);
  await submitOrder(db, code, { orderId: h.orderId, buyer: { name, phone: '0912345678', email: 'a@b.co' },
    holders: seats.map((s, i) => ({ seatId: s, name: i ? `${name}${i + 1}` : name, id4: 'A123' })), agree: true }, T0);
  await A.confirmPayment(db, 'admin', h.orderId, { date: '2026-11-15', amount: 0 }, T0);
  return h.orderId;
}

beforeEach(async () => {
  db = await createPgliteDb();
  await setLiveAt(db, 'test', '2020-01-01T00:00:00Z'); // 這些測試驗正式入場（不是練習）
  await seedVenue(db);
  const ev = await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00') });
  eventId = ev.id;
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-09T23:59:59+08:00') });
  await A.publish(db, 'admin');
  await createGates(db, 'admin', ['左1', '右1']);
  tok = Object.fromEntries((await listGates(db)).map((g) => [g.name, g.token]));
});

describe('年代 QR 解析', () => {
  it('實際的年代 QR：同一張票 ID 固定（不同時間、轉贈後都一樣），不同票不同', () => {
    const id = (s: string) => { const r = parseEraQr(s); return r?.kind === 'era' ? r.id : null; };
    expect(id(REAL.t1a)).toBe('C136DSP1IGZL8E');
    expect(id(REAL.t1b)).toBe(id(REAL.t1a));
    expect(new Set([REAL.t2a, REAL.t2b, REAL.t2c].map(id)).size).toBe(1);
    expect(new Set(Object.values(REAL).map(id)).size).toBe(6); // E F H I J＋另一筆訂單
  });
  it('轉贈待接收、我們的 QR、網址、亂碼', () => {
    expect(parseEraQr('轉贈待接收')).toEqual({ kind: 'pending' });
    expect(parseEraQr('TICC|T1-00001-01|AAAAAAAAAAAA')).toBeNull();
    expect(parseEraQr('https://example.com/a-12345678901')).toBeNull();
    expect(parseEraQr('')).toBeNull();
  });
  it('年代名單樓層', () => {
    expect(['3樓', '4樓', '5 樓', '三樓', '3F', '包廂'].map(eraFloorOf)).toEqual(['3F', '4F', '5F', '3F', '3F', '']);
  });
});

describe('驗票頁：年代票', () => {
  it('掃到就算（不分樓層）；同一張換時間再掃＝已入場；轉贈待接收無效；不影響我們的應到人數', async () => {
    const oid = await paidOrder('AAA111', ['3-1']);
    expect(oid).toBeGreaterThan(0);
    const r1 = await scan(db, tok['左1'], { qr: REAL.t2a });
    expect(r1).toMatchObject({ result: 'ok', label: '年代票', isEra: true, entered: 0, total: 1, era: 1, here: 1 });
    // 3:43 的動態 QR、別的門：還是同一張
    expect(await scan(db, tok['右1'], { qr: REAL.t2b })).toMatchObject({ result: 'used', gate: '左1', isEra: true, era: 1 });
    expect(await scan(db, tok['右1'], { qr: '轉贈待接收' })).toMatchObject({ result: 'invalid' });
    expect(await scan(db, tok['右1'], { qr: REAL.t1a })).toMatchObject({ result: 'ok', era: 2 });
    // 舊版手機還帶著樓層也照樣可以（多的欄位不理）
    expect(await scan(db, tok['右1'], { qr: REAL.t4, eraFloor: '3F' } as { qr: string })).toMatchObject({ result: 'ok', era: 3 });
    // 我們的票照舊
    const qr = qrValue(await qrSecret(db), 'T1-00001-01');
    expect(await scan(db, tok['右1'], { qr })).toMatchObject({ result: 'ok', entered: 1, total: 1, era: 3 });
    const sum = await checkinSummary(db);
    expect(sum).toMatchObject({ entered: 1, era: 3, total: 1 });
    expect(sum.recent.find((r) => r.serial === 'ERA:C136DSP1IGZL8F')?.holder).toBe('年代票');
    // 誤掃撤銷後可再掃
    await undoCheckin(db, 'admin', sum.recent.find((r) => r.serial === 'ERA:C136DSP1IGZL8F')!.id);
    expect(await scan(db, tok['右1'], { qr: REAL.t2c })).toMatchObject({ result: 'ok', isEra: true });
  });
});

describe('驗票即時看板', () => {
  it('連結：未建立／錯的／停用都看不到；換新後舊的失效；只有數字', async () => {
    await expect(boardByToken(db, 'x')).rejects.toThrow();
    const l1 = await updateBoardLink(db, 'admin', { renew: true });
    expect(l1.active).toBe(true);
    const d = await boardByToken(db, l1.token);
    expect(JSON.stringify(d)).not.toMatch(/王大明|0912345678/);
    await updateBoardLink(db, 'admin', { active: false });
    await expect(boardByToken(db, l1.token)).rejects.toThrow(/停用/);
    const l2 = await updateBoardLink(db, 'admin', { renew: true });
    expect(l2.token).not.toBe(l1.token);
    await expect(boardByToken(db, l1.token)).rejects.toThrow();
    await expect(boardByToken(db, l2.token)).resolves.toBeTruthy();
  });

  it('框：VIP／公益依類別分列、VIP 排另一框、年代依名單樓層算應驗、掃到的算已驗；框可改名與改歸屬', async () => {
    await paidOrder('AAA111', ['3-1', '3-2'], '陳小美');
    const v1 = await createVip(db, 'admin', { name: '王董', phone: '', email: '', seatIds: ['1-1', '1-2'], mode: 'none' });
    await createVip(db, 'admin', { name: '偏鄉甲', phone: '', email: '', seatIds: ['1-5'], mode: 'none', cat: '偏鄉' });
    await db.insert(t.joinEraTicket).values([
      { eventId, ticketNo: 'ER1-1', orderNo: 'ER1', floor: '3樓', rowNo: '13排', seatNo: '1號', price: 3000 },
      { eventId, ticketNo: 'ER1-2', orderNo: 'ER1', floor: '3樓', rowNo: '13排', seatNo: '3號', price: 3000 },
      { eventId, ticketNo: 'ER2-1', orderNo: 'ER2', floor: '4樓', rowNo: '1排', seatNo: '1號', price: 1000 },
      { eventId, ticketNo: 'ER3-1', orderNo: 'ER3', floor: '5樓', rowNo: '1排', seatNo: '1號', price: 800, status: 'refunded' },
    ]);
    await scan(db, tok['左1'], { qr: REAL.t1a });
    await scan(db, tok['左1'], { qr: REAL.t4 });
    // 11-23 版留下的「分樓層」入場紀錄也算進年代
    await db.insert(t.checkin).values({ eventId, serial: 'ERA:OLDFLOOR00001', orderId: 0, seatId: 'ERA-5F', at: T0 });
    const secret = await qrSecret(db);
    const vipNo = (await listVips(db)).list.find((x) => x.id === v1.orderId)!.orderNo!;
    await scan(db, tok['右1'], { qr: qrValue(secret, `${vipNo}-01`) });

    let d = await boardData(db);
    const box = (n: string) => d.boxes.find((b) => b.name === n);
    expect(box('公益')).toMatchObject({ total: 3, done: 1 }); // 沒選類別＝公益（不再用「招待」）
    expect(box('公益')!.lines).toEqual([{ label: '公益', total: 2, done: 1 }, { label: '偏鄉', total: 1, done: 0 }]);
    expect(box('年代')).toMatchObject({ total: 3, done: 3, lines: [] }); // 3–5 樓合計；已退不算
    expect(box('年代 3F')).toBeUndefined();
    expect(box('3F 贈票')).toMatchObject({ total: 0, done: 0 });
    expect(d).toMatchObject({ total: 2 + 3 + 3, done: 4 });
    expect(d.gates).toEqual([{ name: '左1', n: 2 }, { name: '右1', n: 1 }, { name: '後台', n: 1 }]);

    // 類別改偏鄉 → 公益框裡的分列跟著變
    await setVipCat(db, 'admin', v1.orderId, '偏鄉');
    d = await boardData(db);
    expect(box('公益')).toMatchObject({ total: 3, done: 1, lines: [] }); // 只有一種就不分列

    // 後台改設定：偏鄉另開一框、年代隱藏
    const st = await boardAdminState(db);
    const assign = Object.fromEntries(st.sources.map((s) => [s.key, s.key === 'vip:偏鄉' ? '偏鄉' : s.box]));
    await saveBoxCfg(db, 'admin', { boxes: [...st.boxes.map((b) => ({ name: b.name, hidden: b.name === '年代' })), { name: '偏鄉' }], assign });
    d = await boardData(db);
    expect(box('偏鄉')).toMatchObject({ total: 3, done: 1 });
    expect(box('公益')).toBeUndefined(); // 沒票的框不顯示
    expect(box('年代')).toBeUndefined();
  });

  it('新增招待：座位全在 VIP 排自動標 VIP，看板算 VIP 框；清單有類別與入場數', async () => {
    await db.update(t.event).set({ vipInstalled: true });
    await A.publish(db, 'admin');
    const r = await createVip(db, 'admin', { name: '貴賓甲', phone: '', email: '', seatIds: ['V-7', 'V-8'], mode: 'none' });
    const row = (await listVips(db)).list.find((x) => x.id === r.orderId)!;
    expect(row).toMatchObject({ cat: 'VIP', entered: 0 });
    expect(row.seats.every((s) => s.vipRow)).toBe(true);
    const d = await boardData(db);
    expect(d.boxes.find((b) => b.name === 'VIP')).toMatchObject({ total: 2, done: 0 });
    expect(d.boxes.find((b) => b.name === '公益')).toBeUndefined();
  });
});
