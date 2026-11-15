import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { confirmPreorder, listPreorders, submitPreorder } from '@/lib/preorder';
import { createForPreorder, saveEinvConfig } from '@/lib/einvoice';
import { assertFinanceInvoices, financeState, getFinanceCombos, setFinanceCombos } from '@/lib/finance';
import { createUser, listUsers, updateUser } from '@/lib/accounts';
import { hashPassword } from '@/lib/auth';

let db: Db;
let vipCombo: number; let otherCombo: number;
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試活動', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123', accountName: '主辦' });
  const cs = await db.select().from(t.combo);
  vipCombo = cs.find((c) => c.name === '雙人套票')!.id;
  otherCombo = cs.find((c) => !c.isSingle && c.id !== vipCombo)!.id;
  await db.update(t.combo).set({ name: '尊榮席（1+2）' }).where(eq(t.combo.id, vipCombo));
  await A.publish(db, 'admin');
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
  await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'mock', timing: 'review' }, '測試');
});

let ph = 0;
async function invoiceFor(comboId: number, name: string) {
  await submitPreorder(db, { items: [{ kind: 'combo', id: comboId, qty: 1 }], name, phone: `09123456${String(++ph).padStart(2, '0')}`, email: 'a@b.co', paidAmount: 1, last5: '12345', agree: true, confirmMismatch: true }, '', new Date());
  const p = (await listPreorders(db)).find((x) => x.name === name)!;
  await confirmPreorder(db, 'admin', p.id);
  const inv = await createForPreorder(db, p.id, 'admin');
  return inv!.id;
}

describe('財務帳號：只能處理勾選方案的發票', () => {
  it('預設＝名稱含尊榮／感恩；只看得到、只能操作這些發票；主管可改勾選', async () => {
    expect(await getFinanceCombos(db)).toEqual([vipCombo]);
    const a = await invoiceFor(vipCombo, '尊榮買方');
    const b = await invoiceFor(otherCombo, '其他買方');
    const st = await financeState(db, { username: 'acc', displayName: '會計', role: 'finance' });
    expect(st.invoices.map((x) => x.id)).toEqual([a]);
    expect(st.combos).toEqual(['尊榮席（1+2）']);
    await expect(assertFinanceInvoices(db, [a])).resolves.toBeUndefined();
    await expect(assertFinanceInvoices(db, [b])).rejects.toThrow('財務帳號只能處理');
    await expect(assertFinanceInvoices(db, [a, b])).rejects.toThrow('財務帳號只能處理');
    await expect(assertFinanceInvoices(db, [99999])).rejects.toThrow('財務帳號只能處理');
    await setFinanceCombos(db, 'admin', [vipCombo, otherCombo]);
    await expect(assertFinanceInvoices(db, [a, b])).resolves.toBeUndefined();
    await setFinanceCombos(db, 'admin', []);
    expect((await financeState(db, { username: 'acc', displayName: '會計', role: 'finance' })).invoices).toHaveLength(0);
  });
});

describe('後台帳號管理', () => {
  it('新增、重複、改角色、停用；不能降級自己；至少留一個主管', async () => {
    const [boss] = await db.insert(t.adminUser).values({ username: 'boss', passwordHash: hashPassword('x'.repeat(12)), role: 'admin' }).returning();
    const me = { id: boss.id, username: 'boss' };
    await expect(createUser(db, 'boss', { username: 'a b', displayName: '', password: 'x'.repeat(12), role: 'finance' })).rejects.toThrow('帳號只能用');
    await expect(createUser(db, 'boss', { username: 'acc', displayName: '', password: 'short', role: 'finance' })).rejects.toThrow('至少 10');
    const { id } = await createUser(db, 'boss', { username: 'acc', displayName: '會計', password: 'x'.repeat(12), role: 'finance' });
    await expect(createUser(db, 'boss', { username: 'acc', displayName: '', password: 'x'.repeat(12), role: 'staff' })).rejects.toThrow('已經有人用了');
    expect((await listUsers(db)).find((u) => u.id === id)).toMatchObject({ role: 'finance', active: true });
    await updateUser(db, me, id, { active: false });
    expect((await listUsers(db)).find((u) => u.id === id)?.active).toBe(false);
    await expect(updateUser(db, me, boss.id, { role: 'staff' })).rejects.toThrow('不能停用或降級自己');
    await expect(updateUser(db, { id: id, username: 'acc' }, boss.id, { active: false })).rejects.toThrow('至少要留一個');
    await updateUser(db, me, id, { role: 'admin', active: true });
    await updateUser(db, { id, username: 'acc' }, boss.id, { role: 'staff' });
    expect((await listUsers(db)).find((u) => u.id === boss.id)?.role).toBe('staff');
  });
});
