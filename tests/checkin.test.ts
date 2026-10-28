import { beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { checkinSummary, createGates, listGates, qrSecret, qrValue, scan, searchTickets, sideOf, undoCheckin, updateGate } from '@/lib/ticket';

const T0 = new Date('2026-11-15T10:00:00+08:00');
let db: Db; let tok: Record<string, string>; let orderId: number;

async function paidOrder(code: string, seats: string[], name = '王大明') {
  const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
  const h = await holdSeats(db, code, seats, single, T0);
  await submitOrder(db, code, { orderId: h.orderId, buyer: { name, phone: '0912345678', email: 'a@b.co' },
    holders: seats.map((s, i) => ({ seatId: s, name: i ? `${name}${i + 1}` : name, id4: 'A123' })), agree: true }, T0);
  return h.orderId;
}

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '法會', showAt: new Date('2026-12-20T19:30:00+08:00') });
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
  await A.publish(db, 'admin');
  await createGates(db, 'admin', ['左1', '右1']);
  tok = Object.fromEntries((await listGates(db)).map((g) => [g.name, g.token]));
  orderId = await paidOrder('AAA111', ['3-1', '3-2']);
  await A.confirmPayment(db, 'admin', orderId, { date: '2026-11-15', amount: 6400 }, T0);
});

describe('QR 入場', () => {
  it('購票頁的 QR 有簽章；掃描成功顯示座位、持票人與入口；同一張第二次掃顯示已入場', async () => {
    const s = await getBookingState(db, 'AAA111', T0);
    const qr = s.orders[0].seats[0].qr!;
    expect(qr).toMatch(/^TICC\|T1-00001-01\|[A-Za-z0-9_-]{12}$/);
    const r1 = await scan(db, tok['左1'], { qr });
    expect(r1).toMatchObject({ result: 'ok', serial: 'T1-00001-01', holderName: '王大明', holderId4: 'A123', side: '左側門', entered: 1, total: 2, here: 1 });
    const r2 = await scan(db, tok['右1'], { qr });
    expect(r2).toMatchObject({ result: 'used', gate: '左1' });
  });

  it('偽造：自己產生序號、改簽章、亂碼都無效', async () => {
    expect(await scan(db, tok['左1'], { qr: 'TICC|T1-00001-02|AAAAAAAAAAAA' })).toMatchObject({ result: 'invalid', reason: '偽造或已失效的 QR code' });
    expect(await scan(db, tok['左1'], { qr: 'TICC|T1-00001-02' })).toMatchObject({ result: 'invalid' });
    expect(await scan(db, tok['左1'], { qr: 'https://example.com' })).toMatchObject({ result: 'invalid', reason: '不是本活動的入場 QR code' });
  });

  it('多個門同時掃同一張：只有一個成功', async () => {
    const qr = qrValue(await qrSecret(db), 'T1-00001-02');
    const rs = await Promise.all([scan(db, tok['左1'], { qr }), scan(db, tok['右1'], { qr }), scan(db, tok['左1'], { qr })]);
    expect(rs.filter((r) => r.result === 'ok')).toHaveLength(1);
    expect(rs.filter((r) => r.result === 'used')).toHaveLength(2);
  });

  it('未確認劃位的訂單不能入場；查無此票', async () => {
    await paidOrder('AAA111', ['5-1'], '陳小美');
    const secret = await qrSecret(db);
    expect(await scan(db, tok['左1'], { qr: qrValue(secret, 'T1-00002-01') })).toMatchObject({ result: 'invalid', reason: '尚未確認劃位，不能入場' });
    expect(await scan(db, tok['左1'], { qr: qrValue(secret, 'T1-00099-01') })).toMatchObject({ result: 'invalid', reason: '查無此票' });
  });

  it('手動輸入序號與搜尋姓名', async () => {
    const found = await searchTickets(db, tok['左1'], '王大明');
    expect(found.map((x) => x.serial)).toEqual(['T1-00001-01', 'T1-00001-02']);
    expect(await scan(db, tok['左1'], { serial: 't1-00001-02' })).toMatchObject({ result: 'ok', manual: true });
    expect((await searchTickets(db, tok['左1'], '王大明'))[1].entered).not.toBeNull();
  });

  it('停用的驗票連結不能用；換新連結後舊的失效', async () => {
    const g = (await listGates(db)).find((x) => x.name === '左1')!;
    await updateGate(db, 'admin', g.id, { active: false });
    await expect(scan(db, tok['左1'], { serial: 'T1-00001-01' })).rejects.toThrow('已停用');
    await updateGate(db, 'admin', g.id, { active: true, renewToken: true });
    await expect(scan(db, tok['左1'], { serial: 'T1-00001-01' })).rejects.toThrow('不存在');
  });

  it('後台統計與撤銷：撤銷後可以再掃', async () => {
    await scan(db, tok['左1'], { serial: 'T1-00001-01' });
    let s = await checkinSummary(db);
    expect(s).toMatchObject({ total: 2, entered: 1 });
    expect(s.recent[0]).toMatchObject({ serial: 'T1-00001-01', gate: '左1', holder: '王大明', manual: true });
    await undoCheckin(db, 'admin', s.recent[0].id);
    s = await checkinSummary(db);
    expect(s.entered).toBe(0);
    expect(await scan(db, tok['右1'], { serial: 'T1-00001-01' })).toMatchObject({ result: 'ok' });
  });

  it('入口建議：單號左側門、雙號右側門', () => {
    expect(sideOf('03-15-L1')).toBe('左側門');
    expect(sideOf('03-02-C0')).toBe('右側門');
    expect(sideOf('WC-H12-R2')).toBe('右側門');
  });
});
