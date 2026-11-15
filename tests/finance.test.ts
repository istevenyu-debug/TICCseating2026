import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { confirmPreorder, listPreorders, submitPreorder } from '@/lib/preorder';
import { createForPreorder, saveEinvConfig } from '@/lib/einvoice';
import { assertFinanceInvoices, assertFinancePreorders, financeState, getFinanceCombos, setFinanceCombos } from '@/lib/finance';
import { changeOwnPassword, createUser, listUsers, newSetupToken, pendingSetups, redeemSetup, setupInfo, updateUser } from '@/lib/accounts';
import { login } from '@/lib/auth';
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
    expect(st.plans.every((p) => p.id === vipCombo)).toBe(true);
    await expect(assertFinanceInvoices(db, [a])).resolves.toBeUndefined();
    await expect(assertFinanceInvoices(db, [b])).rejects.toThrow('財務帳號只能處理');
    await expect(assertFinanceInvoices(db, [a, b])).rejects.toThrow('財務帳號只能處理');
    await expect(assertFinanceInvoices(db, [99999])).rejects.toThrow('財務帳號只能處理');
    expect(st.preorders.map((p) => p.name)).toEqual(['尊榮買方']);
    expect(st.preorders[0].linkCode).toBeNull();
    expect(st.others.map((o) => o.amount)).toHaveLength(1);
    expect(JSON.stringify(st.others)).not.toContain('其他買方');
    const [pa] = await db.select().from(t.preorder).where(eq(t.preorder.name, '尊榮買方'));
    const [pb] = await db.select().from(t.preorder).where(eq(t.preorder.name, '其他買方'));
    await expect(assertFinancePreorders(db, [pa.id])).resolves.toBeUndefined();
    await expect(assertFinancePreorders(db, [pa.id, pb.id])).rejects.toThrow('財務帳號只能處理');
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

describe('設定連結與修改密碼', () => {
  it('不設密碼建帳號→設定連結 1 小時有效、只能用一次；本人改密碼要舊密碼', async () => {
    const t0 = new Date('2026-11-16T10:00:00+08:00');
    const { id, setup } = await createUser(db, 'boss', { username: 'finance', displayName: '會計', role: 'finance' }, t0);
    expect(setup).not.toBeNull();
    expect(await login(db, 'finance', 'whatever-pass')).toBeNull();
    expect(await setupInfo(db, setup!.token, t0)).toMatchObject({ username: 'finance' });
    expect(await setupInfo(db, setup!.token + 'x', t0)).toBeNull();
    expect(await setupInfo(db, setup!.token, new Date(t0.getTime() + 61 * 60_000))).toBeNull(); // 超過 1 小時
    expect(Object.keys(await pendingSetups(db, t0))).toEqual([String(id)]);
    await expect(redeemSetup(db, setup!.token, 'short', t0)).rejects.toThrow('至少 10');
    await redeemSetup(db, setup!.token, 'my-own-pass-1', t0);
    expect(await login(db, 'finance', 'my-own-pass-1')).toMatchObject({ id });
    await expect(redeemSetup(db, setup!.token, 'another-pass-2', t0)).rejects.toThrow('已失效'); // 用過即失效
    // 重寄：舊的作廢、新的可用
    const a = await newSetupToken(db, 'boss', id, t0);
    const b = await newSetupToken(db, 'boss', id, t0);
    expect(await setupInfo(db, a.token, t0)).toBeNull();
    expect(await setupInfo(db, b.token, t0)).not.toBeNull();
    // 停用的帳號連結無效
    const [boss] = await db.insert(t.adminUser).values({ username: 'boss', passwordHash: hashPassword('x'.repeat(12)), role: 'admin' }).returning();
    await updateUser(db, { id: boss.id, username: 'boss' }, id, { active: false });
    expect(await setupInfo(db, b.token, t0)).toBeNull();
    await updateUser(db, { id: boss.id, username: 'boss' }, id, { active: true });
    // 本人改密碼
    await expect(changeOwnPassword(db, id, 'wrong', 'new-pass-12345')).rejects.toThrow('目前的密碼不正確');
    await changeOwnPassword(db, id, 'my-own-pass-1', 'new-pass-12345');
    expect(await login(db, 'finance', 'new-pass-12345')).toMatchObject({ id });
    expect(await login(db, 'finance', 'my-own-pass-1')).toBeNull();
  });
});
