import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as X from 'xlsx';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { holdSeats, submitOrder } from '@/lib/booking';
import { getVipCats } from '@/lib/checkinBoard';
import { listVips } from '@/lib/vip';
import { parseSeat, pendingImportMails, previewImport, runImport, sendImportMails, stickerRows } from '@/lib/vipImport';

let db: Db;
const xlsx = (rows: unknown[][], head = ['席號', '姓名職稱', '單位', '類別', 'email', '推薦人']) => {
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['說明：請照表頭填寫'], head, ...rows]), '名單');
  return Buffer.from(X.write(wb, { type: 'buffer', bookType: 'xlsx' })).toString('base64');
};

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '萬變中', showAt: new Date('2026-12-09T19:30:00+08:00') });
});

describe('VIP／公益 Excel 匯入', () => {
  it('席號格式', () => {
    expect(parseSeat('VIP-1')).toBe('V-1');
    expect(parseSeat('ＶＩＰ－１２')).toBe('V-12');
    expect(parseSeat('1排34號')).toBe('1-34');
    expect(parseSeat('第 1 排 34 號')).toBe('1-34');
    expect(parseSeat('01-34')).toBe('1-34');
    expect(parseSeat('A1')).toBeNull();
    // 11/27：VIP 22、23 是原輪椅席 H16、H15 改的
    expect(parseSeat('VIP-22')).toBe('W-H16');
    expect(parseSeat('VIP-23')).toBe('W-H15');
  });

  it('VIP-22、VIP-23 可以匯入（座位圖上的 VIP 排 22、23 號）', async () => {
    const p = await previewImport(db, xlsx([['VIP-22', '甲 董事', '', 'VIP', '', ''], ['VIP-23、VIP-21', '乙 理事長', '', 'VIP', '', '']]));
    expect(p.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(p.rows[1].seat).toBe('VIP-23、VIP-21');
  });

  it('預覽：VIP 每人一筆不寄；公益同單位合成一筆寄給有 Email 的人；空白姓名略過；錯誤標原因；不寫入', async () => {
    const f = xlsx([
      ['VIP-1', '王大明 董事長', '甲公司', 'VIP', 'w@x.co', ''],
      ['VIP-2', '', '', 'VIP', '', ''],
      ['1排34號', '林小華 執行長', '乙基金會', '公益', '', '陳推薦'],
      ['1排32號', '張三 秘書', '乙基金會', '公益', 'z3@y.org', ''],
      ['2排34號、2排32號', '李四', '', '', 'li@q.tw', ''],
      ['1排99號', '錯座位', '', '公益', '', ''],
      ['1排32號', '重複', '', '公益', '', ''],
      ['3排1號', '壞信箱', '', '公益', 'bad@', ''],
    ]);
    const p = await previewImport(db, f);
    const by = (l: number) => p.rows.find((r) => r.line === l)!;
    expect(by(3)).toMatchObject({ status: 'ok', cat: 'VIP', seat: 'VIP-1' });
    expect(by(4)).toMatchObject({ status: 'skip' });
    expect(by(5).status).toBe('ok');
    expect(by(6).status).toBe('err'); // 1-32 在表內重複
    expect(by(8)).toMatchObject({ status: 'err', reason: expect.stringContaining('沒有這個座位') });
    expect(by(9)).toMatchObject({ status: 'err', reason: '表內有其他列也用這個座位' });
    expect(by(10)).toMatchObject({ status: 'err', reason: 'Email 格式不對' });
    expect(by(7)).toMatchObject({ status: 'ok', cat: '公益' }); // 類別空白、非 VIP 排 → 公益
    expect(p.groups.find((g) => g.cat === 'VIP')).toMatchObject({ send: false, holders: [{ seatId: 'V-1', name: '王大明 董事長' }] });
    expect(await db.select().from(t.orders)).toHaveLength(0);
  });

  it('匯入：持票人＝每人姓名職稱、單位存起來、一律不寄；再寄出時只寄公益；重複上傳略過', async () => {
    const f = xlsx([
      ['VIP-1', '王大明 董事長', '甲公司', 'VIP', 'w@x.co', ''],
      ['1排34號', '林小華 執行長', '乙基金會', '公益', '', '陳推薦'],
      ['1排32號', '張三 秘書', '乙基金會', '公益', 'z3@y.org', ''],
      ['2排34號', '趙五', '丙協會', '偏鄉', 'z5@y.org', ''],
      ['2排32號', '錢六', '', '公益', '', ''],
    ]);
    const r = await runImport(db, 'admin', f);
    expect(r.failed).toEqual([]);
    expect(r.done).toHaveLength(4);
    expect(r.newCats).toEqual(['偏鄉']);
    expect(await getVipCats(db)).toEqual(['VIP', '公益', '偏鄉']);
    const v = (await listVips(db)).list;
    const g = v.find((x) => x.org === '乙基金會')!;
    expect(g).toMatchObject({ cat: '公益', name: '張三 秘書', email: 'z3@y.org', mode: 'none', referrer: '陳推薦' });
    const hs = await db.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, g.id));
    expect(hs.map((h) => [h.seatId, h.holderName]).sort()).toEqual([['1-32', '張三 秘書'], ['1-34', '林小華 執行長']]);
    expect(v.find((x) => x.cat === 'VIP')).toMatchObject({ org: '甲公司', mode: 'none' });
    expect(await db.select().from(t.notification)).toHaveLength(0);

    const pend = await pendingImportMails(db);
    expect(pend.map((x) => x.email).sort()).toEqual(['z3@y.org', 'z5@y.org']); // VIP 與沒 Email 的不在內
    const sent = await sendImportMails(db, 'admin', [...pend.map((x) => x.id), v.find((x) => x.cat === 'VIP')!.id]);
    expect(sent).toHaveLength(2);
    const n = await db.select().from(t.notification);
    expect(n.map((x) => x.recipient).sort()).toEqual(['z3@y.org', 'z5@y.org']);
    expect(await pendingImportMails(db)).toHaveLength(0);

    const again = await previewImport(db, f);
    expect(again.count).toMatchObject({ ok: 0, skip: 5, err: 0 });
  });

  it('被別人占用的座位標出訂單編號', async () => {
    await createLink(db, { eventId: 1, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-09T23:59:59+08:00') });
    await A.publish(db, 'admin');
    const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
    const h = await holdSeats(db, 'AAA111', ['5-3'], single);
    await submitOrder(db, 'AAA111', { orderId: h.orderId, buyer: { name: '甲', phone: '0912345678', email: 'a@b.co' }, holders: [{ seatId: '5-3', name: '甲', id4: 'A123' }], agree: true });
    const p = await previewImport(db, xlsx([['5排3號', '某人', '', '公益', '', '']]));
    expect(p.rows[0]).toMatchObject({ status: 'err', reason: expect.stringContaining('已有人') });
  });

  it('沒有表頭給清楚的錯誤', async () => {
    await expect(previewImport(db, xlsx([['VIP-1', 'x']], ['a', 'b']))).rejects.toThrow('找不到表頭');
  });

  it('座位貼名單：VIP 排與 VIP 類別，依座位排序，含單位', async () => {
    await runImport(db, 'admin', xlsx([['1排34號', '林小華', '乙', 'VIP', '', ''], ['VIP-2', '王大明', '甲', '', '', ''], ['2排1號', '公益人', '丙', '公益', '', '']]));
    const s = await stickerRows(db);
    expect(s.map((x) => [x.seat, x.name, x.org, x.kind])).toEqual([['VIP-2', '王大明', '甲', 'VIP'], ['1排34號', '林小華', '乙', 'VIP']]);
  });
});
