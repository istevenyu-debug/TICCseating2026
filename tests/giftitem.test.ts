import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { exportAll, importAll } from '@/lib/backup';
import { checkPreorder, preorderMenu, submitPreorder, cancelPreorder } from '@/lib/preorder';
import { giftLine, giftNeed } from '@/lib/gift';

let db: Db; let combo2: number; let book: number; let rice: number;
const buy = (qty = 1, phone = '0912345678') => submitPreorder(db, { items: [{ kind: 'combo', id: combo2, qty }], name: '林大同', phone, email: 'a@example.com', paidAmount: 1, last5: '12345', agree: true, confirmDup: true, confirmMismatch: true });

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123', accountName: '主辦' });
  combo2 = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
  book = (await A.createGift(db, 'admin')).id; await A.updateGift(db, 'admin', book, { name: '書', unit: '本' });
  rice = (await A.createGift(db, 'admin')).id; await A.updateGift(db, 'admin', rice, { name: '穀東米', unit: '張' });
});

describe('贈品', () => {
  it('文字與備貨數量', () => {
    const cat = [{ id: 1, name: '書', unit: '本' }, { id: 2, name: '米', unit: '張' }];
    expect(giftLine([{ giftId: 1, qty: 12 }, { giftId: 2, qty: 0 }], cat)).toBe('書 12 本');
    expect(giftLine([], cat)).toBe('');
    expect([...giftNeed([{ kind: 'combo', id: 5, qty: 2 }, { kind: 'zone', id: 5, qty: 9 }], [{ id: 5, gifts: [{ giftId: 1, qty: 3 }] }])]).toEqual([[1, 6]]);
  });

  it('預設不顯示在認購頁；勾選後才顯示', async () => {
    const before = (await preorderMenu(db)).items.find((i) => i.id === combo2)!.desc;
    await A.updateCombo(db, 'admin', combo2, { gifts: [{ giftId: book, qty: 12 }, { giftId: rice, qty: 1 }] });
    expect((await preorderMenu(db)).items.find((i) => i.id === combo2)!.desc).toBe(before);
    await A.setGiftShow(db, 'admin', { buy: true });
    expect((await preorderMenu(db)).items.find((i) => i.id === combo2)!.desc).toBe(`${before}（贈 書 12 本、穀東米 1 張）`);
  });

  it('後台備貨統計：已登記、已匯款，取消的不算', async () => {
    await A.updateCombo(db, 'admin', combo2, { gifts: [{ giftId: book, qty: 12 }] });
    await buy(2);
    await buy(1, '0922222222');
    const pos = await db.select().from(t.preorder);
    await checkPreorder(db, 'admin', pos[0].id, { paid: true });
    let g = (await A.getAdminState(db)).gifts.find((x) => x.id === book)!;
    expect(g).toMatchObject({ registered: 36, paid: 24 });
    await cancelPreorder(db, 'admin', pos[1].id);
    g = (await A.getAdminState(db)).gifts.find((x) => x.id === book)!;
    expect(g).toMatchObject({ registered: 24, paid: 24 });
  });

  it('數量 0 會移除；被方案使用中的贈品不能刪；別的贈品編號擋下', async () => {
    await A.updateCombo(db, 'admin', combo2, { gifts: [{ giftId: book, qty: 3 }, { giftId: rice, qty: 0 }] });
    expect((await db.select().from(t.combo).where(eq(t.combo.id, combo2)))[0].gifts).toEqual([{ giftId: book, qty: 3 }]);
    await expect(A.deleteGift(db, 'admin', book)).rejects.toThrow('請先把數量改成 0');
    await A.deleteGift(db, 'admin', rice);
    await expect(A.updateCombo(db, 'admin', combo2, { gifts: [{ giftId: 99999, qty: 1 }] })).rejects.toThrow('贈品不存在');
  });

  it('沒有贈品時，方案與畫面完全不變', async () => {
    const st = await A.getAdminState(db);
    expect(st.giftShow).toEqual({});
    expect(st.combos.every((c) => Array.isArray(c.gifts) && c.gifts.length === 0)).toBe(true);
  });

  it('備份還原：新備份保留；舊備份沒有贈品欄位也能還原', async () => {
    await A.updateCombo(db, 'admin', combo2, { gifts: [{ giftId: book, qty: 12 }] });
    await A.setGiftShow(db, 'admin', { invoice: true });
    const b = JSON.parse(JSON.stringify(await exportAll(db)));
    await importAll(db, b);
    expect((await db.select().from(t.combo).where(eq(t.combo.id, combo2)))[0].gifts).toEqual([{ giftId: book, qty: 12 }]);
    expect((await db.select().from(t.event))[0].giftShow).toEqual({ invoice: true });
    const old = JSON.parse(JSON.stringify(b));
    delete old.tables.gift_item;
    for (const r of old.tables.combo) delete r.gifts;
    for (const r of old.tables.event) delete r.gift_show;
    await importAll(db, old);
    expect((await db.select().from(t.giftItem))).toHaveLength(0);
    expect((await db.select().from(t.combo)).every((c) => c.gifts.length === 0)).toBe(true);
    expect((await db.select().from(t.event))[0].giftShow).toEqual({});
    expect((await A.createGift(db, 'admin')).id).toBeGreaterThan(0);
  });
});


it('舊備份沒有推薦人欄位也能還原', async () => {
  await A.createInviteLink(db, 'admin', { name: '甲', phone: '0911111111', quota: 2, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
  const b = JSON.parse(JSON.stringify(await exportAll(db)));
  for (const r of b.tables.invite_link ?? []) delete r.referrer;
  expect(b.tables.invite_link.length).toBeGreaterThan(0);
  await importAll(db, b);
  expect((await db.select().from(t.inviteLink)).every((l) => l.referrer === '')).toBe(true);
});
