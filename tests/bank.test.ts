import { beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { checkPaidMany, clearBank, ignoreBank, importBank, listBank } from '@/lib/bank';
import { listPreorders, payInfo, payUpdate, setPreorderRemits, submitPreorder } from '@/lib/preorder';
import { parseBankGrid, parseRemits, pasteToGrid, reconcile, type RecOrder } from '@/lib/reconcile';

// 假資料：與網銀下載的「交易明細」同樣的版面（帳號、金額都是虛構的）
const HEAD = [['交易明細查詢'], ['下載時間：2026/11/01'], [], ['統一編號/戶名', '', '', '00000000 測試'], [], [], [],
  ['交易日期', '交易時間', '幣別', '支出金額', '存入金額', '餘額', '票據號碼', '摘要', '備註', '']];
const row = (d: string, tm: string, amt: number, bal: number, acct: string) => [d, tm, '新臺幣', '-', String(amt), String(bal), '', '跨行轉帳', acct, ''];
const GRID = [...HEAD,
  row('2026/11/01', '09:00:00', 100000, 100000, '8220000000011111'), // 同一帳號分兩筆
  row('2026/11/01', '09:01:00', 50000, 150000, '8220000000011111'),
  row('2026/11/01', '10:00:00', 50000, 200000, '0120000000022222'), // 對到
  row('2026/11/01', '11:00:00', 40000, 240000, '0040000000033333'), // 金額不符（應付 50000）
  row('2026/11/01', '12:00:00', 50000, 290000, '0130000000099999'), // 找不到訂單
  ['2026/11/01', '13:00:00', '新臺幣', '1000', '-', '289000', '', '轉帳', '0000000000044444', ''], // 支出
  [], ['總計'],
];

describe('網銀明細解析', () => {
  it('依標題找欄位，只取存入，後五碼取自備註帳號；沒標題的貼上也能讀', () => {
    const r = parseBankGrid(GRID);
    expect(r.rows.map((x) => [x.at, x.amount, x.last5])).toEqual([
      ['2026-11-01T09:00:00+08:00', 100000, '11111'], ['2026-11-01T09:01:00+08:00', 50000, '11111'],
      ['2026-11-01T10:00:00+08:00', 50000, '22222'], ['2026-11-01T11:00:00+08:00', 40000, '33333'], ['2026-11-01T12:00:00+08:00', 50000, '99999'],
    ]);
    expect(r.skipped).toBe(1);
    const pasted = GRID.slice(8, 10).map((x) => x.join('\t')).join('\n');
    expect(parseBankGrid(pasteToGrid(pasted)).rows.map((x) => x.last5)).toEqual(['11111', '11111']);
    // 民國年、金額有逗號
    expect(parseBankGrid([['交易日期', '存入金額', '備註'], ['115/11/02 08:30', '1,500', '123456789']]).rows[0]).toMatchObject({ at: '2026-11-02T08:30:00+08:00', amount: 1500, last5: '56789' });
  });

  it('多筆匯款字串、未填', () => {
    expect(parseRemits('11111（NT$15,000）、22222（NT$360）', 15360)).toEqual([{ last5: '11111', amount: 15000 }, { last5: '22222', amount: 360 }]);
    expect(parseRemits('54321', 900)).toEqual([{ last5: '54321', amount: 900 }]);
    expect(parseRemits('', 900)).toEqual([]);
  });
});

describe('比對', () => {
  const o = (id: number, amount: number, last5: string, x: Partial<RecOrder> = {}): RecOrder => ({ id, no: `P${id}`, name: `買方${id}`, amount, last5, paidAmount: amount, paidOk: false, status: 'submitted', waitlist: false, ...x });
  const d = (id: number, amount: number, last5: string) => ({ id, at: '2026-11-01T00:00:00+08:00', amount, last5, ignored: false });
  it('同後五碼加總；多帳號；一個帳號付多筆；不符、未入帳、未填、找不到訂單', () => {
    const rec = reconcile([
      o(1, 150000, '11111'), // 100000+50000
      o(2, 50000, '22222（NT$30,000）、23333（NT$20,000）'), // 兩個帳號
      o(3, 50000, '44444'), o(4, 50000, '44444'), // 家人一起匯 100000
      o(5, 50000, '55555'), // 只匯 40000
      o(6, 50000, '66666'), // 還沒匯
      o(7, 50000, ''), // 沒填
      o(8, 50000, '77777', { status: 'cancelled' }),
    ], [d(1, 100000, '11111'), d(2, 50000, '11111'), d(3, 30000, '22222'), d(4, 20000, '23333'), d(5, 100000, '44444'), d(6, 40000, '55555'), d(7, 50000, '99999'), d(8, 50000, '77777')]);
    const s = (id: number) => rec.state.get(id)?.state;
    expect([1, 2, 3, 4, 5, 6, 7].map(s)).toEqual(['ok', 'ok', 'ok', 'ok', 'diff', 'waiting', 'nolast5']);
    expect(rec.state.has(8)).toBe(false);
    expect(rec.unknown).toEqual([7, 8]); // 取消的訂單不算，那筆入帳變成找不到
  });
  it('真的有兩個人都是 88888：加總不符就交給人工', () => {
    const rec = reconcile([o(1, 150000, '88888'), o(2, 50000, '88888')], [d(1, 150000, '88888')]);
    expect(rec.state.get(1)?.state).toBe('diff');
    expect(rec.state.get(2)?.state).toBe('diff');
  });
});

describe('匯入、勾已匯款、補填後五碼', () => {
  let db: Db; let combo2: number;
  const body = (o: Partial<Record<string, unknown>> = {}) => ({
    items: [{ kind: 'combo', id: combo2, qty: 1 }], name: '林大同', phone: '0912-345-678', email: 'lin@example.com',
    paidAmount: 6080, last5: '22222', agree: true, confirmDup: true, ...o,
  });
  beforeEach(async () => {
    db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123-456', accountName: '主辦' });
    combo2 = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
    await A.publish(db, 'admin');
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
  });

  it('重複匯入只算一次；不存完整帳號；略過；清除', async () => {
    const r1 = await importBank(db, 'admin', GRID);
    expect(r1).toMatchObject({ rows: 5, added: 5, dup: 0, skipped: 1 });
    expect(await importBank(db, 'admin', GRID)).toMatchObject({ added: 0, dup: 5 });
    const raw = JSON.stringify(await db.select().from(t.bankTx));
    expect(raw).not.toContain('8220000000011111');
    const list = await listBank(db);
    await ignoreBank(db, 'admin', list[0].id, true);
    expect((await listBank(db)).filter((x) => x.ignored)).toHaveLength(1);
    await expect(importBank(db, 'admin', [['你好']])).rejects.toThrow('存入');
    expect(await clearBank(db, 'admin')).toEqual({ removed: 5 });
  });

  it('送出時可「之後補填」；確認信附補填連結；買方自己填；核帳後鎖住；後台可改；一次勾多筆', async () => {
    const { token } = await submitPreorder(db, body({ last5: '', last5Later: true }));
    const [p] = await listPreorders(db);
    expect(p.last5).toBe('');
    const mail = (await db.select().from(t.notification)).at(-1)!;
    expect(mail.content).toContain(`/buy/pay/${token}`);
    expect(mail.content).toContain('尚未填寫匯款帳號後五碼');
    // 沒勾「之後補填」還是要填
    await expect(submitPreorder(db, body({ last5: '' }))).rejects.toThrow('末 5 碼');

    expect((await payInfo(db, token)).remits).toEqual([]);
    await expect(payUpdate(db, token, [{ last5: '123', amount: 1 }])).rejects.toThrow('5 位數字');
    await payUpdate(db, token, [{ last5: '22222', amount: 3000 }, { last5: '23333', amount: 3080 }]);
    let [q] = await listPreorders(db);
    expect(q.last5).toBe('22222（NT$3,000）、23333（NT$3,080）');
    expect(q.paidAmount).toBe(6080);
    expect(q.note).toContain('買方改後五碼：（未填） → 22222');
    await expect(payInfo(db, 'x'.repeat(24))).rejects.toThrow('找不到');

    await setPreorderRemits(db, 'boss', p.id, [{ last5: '22222', amount: 6080 }]);
    [q] = await listPreorders(db);
    expect(q.last5).toBe('22222');
    expect(q.note).toContain('boss 改後五碼');

    expect(await checkPaidMany(db, 'boss', [p.id], true)).toEqual({ n: 1 });
    expect((await listPreorders(db))[0].paidOkAt).toBeTruthy();
    expect((await payInfo(db, token)).locked).toContain('已核對');
    await expect(payUpdate(db, token, [{ last5: '11111', amount: 6080 }])).rejects.toThrow('已核對');
    await checkPaidMany(db, 'boss', [p.id], false);
    expect((await listPreorders(db))[0].paidOkAt).toBeNull();
  });
});
