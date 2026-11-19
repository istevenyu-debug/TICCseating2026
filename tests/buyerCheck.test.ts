import { beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { createInviteLink } from '@/lib/admin';
import { buyerCheck, setInternalEmails } from '@/lib/buyerCheck';
import { financeState } from '@/lib/finance';

let db: Db;
let evId = 0;
const po = (no: string, v: Partial<typeof t.preorder.$inferInsert>) => db.insert(t.preorder).values({
  eventId: evId, no, items: [{ kind: 'zone', id: 1, name: '一般席', price: 3000, qty: 1 }], amount: 3000, name: '某人', phone: '0912000000', email: `${no}@x.com`,
  paidAmount: 3000, last5: '12345', status: 'confirmed', ...v,
}).returning();

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  [{ id: evId }] = await db.select({ id: t.event.id }).from(t.event);
  await db.insert(t.appSetting).values({ key: 'email.user', value: 'Sender@Gmail.com' });
});

describe('買方核對（二聯／三聯／招待）', () => {
  it('分類、招待標招待、各種可能有誤；只讀不寄信', async () => {
    await po('P1', { name: '王小明', email: 'wang@x.com' }); // 二聯、正常
    await po('P2', { name: '陳大華', invType: 'company', invCode: '04595257', invTitle: '甲公司' }); // 三聯、正常
    await po('P3', { name: '李四', invType: 'company', invCode: '04595257', invTitle: '乙公司' }); // 同統編不同抬頭
    await po('P4', { name: '林五', invType: 'company', invCode: '12345678', invTitle: '' }); // 統編錯、無抬頭
    await po('P5', { name: '張三', email: 'sender@gmail.com' }); // 寄件信箱
    await po('P6', { name: '趙六', email: 'wang@x.com' }); // 和 P1 同 Email 不同名
    await po('P7', { name: '好棒股份有限公司' }); // 二聯但像公司
    await po('P8', { name: '取消的', status: 'cancelled' }); // 不列
    await po('P9', { name: '王小明', email: 'WANG@x.com ' }); // 同名同 Email：不算
    const link = await createInviteLink(db, 't', { name: '貴賓', phone: '0911', quota: 2, expiresAt: new Date('2026-12-31') });
    const [combo] = await db.select().from(t.combo);
    await db.insert(t.orders).values({ orderNo: 'V0001', eventId: evId, linkId: link.id, comboId: combo.id, status: 'paid', amount: 0, vip: true, buyerName: '貴賓甲', buyerEmail: 'staff@ours.org' });
    const before = (await db.select().from(t.notification)).length;

    let { rows } = await buyerCheck(db);
    const r = (no: string) => rows.find((x) => x.no === no)!;
    expect(rows.find((x) => x.no === 'P8')).toBeUndefined();
    expect(r('P1').kind).toBe('b2c');
    expect(r('P2').kind).toBe('b2b');
    expect(r('P2').flags.some((f) => f.includes('不同抬頭'))).toBe(true);
    expect(r('P3').flags.some((f) => f.includes('不同抬頭'))).toBe(true);
    expect(r('P4').flags).toEqual(expect.arrayContaining(['統編不正確（8 碼或檢查碼）', '沒有公司抬頭']));
    expect(r('P5').flags.some((f) => f.includes('我們自己的信箱'))).toBe(true);
    expect(r('P6').flags.some((f) => f.includes('王小明'))).toBe(true);
    expect(r('P1').flags.some((f) => f.includes('趙六'))).toBe(true);
    expect(r('P9').flags.some((f) => f.includes('王小明'))).toBe(false);
    expect(r('P7').flags.some((f) => f.includes('漏打統編'))).toBe(true);
    const v = r('V0001');
    expect(v.kind).toBe('vip');
    expect(v.amount).toBeNull();
    expect(v.flags).toEqual([]);

    // 後台加「我們自己的信箱」→ 招待那筆也標出來
    await setInternalEmails(db, 'admin', 'staff@ours.org\nme@ours.org');
    ({ rows } = await buyerCheck(db));
    expect(rows.find((x) => x.no === 'V0001')!.flags.some((f) => f.includes('staff@ours.org'))).toBe(true);
    await expect(setInternalEmails(db, 'admin', 'not-an-email')).rejects.toThrow();

    // 只讀：不寄信、不建發票
    expect((await db.select().from(t.notification)).length).toBe(before);
    expect((await db.select().from(t.invoice)).length).toBe(0);
  });

  it('會計看得到全部方案（不只勾選的方案）', async () => {
    await po('P1', { name: '一般席買方' });
    const fin = await financeState(db, { username: 'f', displayName: '會計', role: 'finance' });
    expect(fin.preorders.length).toBe(0); // 發票／對帳仍只限勾選方案
    expect(fin.buyerCheck.rows.map((x) => x.no)).toEqual(['P1']);
  });
});
