import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { exportAll, importAll } from '@/lib/backup';
import { getBookingState, holdSeats, publicSeatMap } from '@/lib/booking';
import { checkPreorder, confirmPreorder, listPreorders, preorderMenu, preorderMenuFull, setPreorderItems, submitPreorder } from '@/lib/preorder';

let db: Db;
let combo2: number; let zoneA: number; let secret: number;
const body = (id: number, o: Partial<Record<string, unknown>> = {}) => ({
  items: [{ kind: 'combo', id, qty: 1 }],
  name: '林大同', phone: '0912-345-678', email: 'office@example.com', paidAmount: 60000, last5: '54321', agree: true, confirmDup: true, confirmMismatch: true, ...o,
});

/** 新增一個 5 張 A 區、60,000 的隱藏方案 */
async function makeHidden(hidden = true) {
  const c = await A.createCombo(db, 'admin');
  await A.updateCombo(db, 'admin', c.id, { name: '買五送一', price: 60000, items: [{ zoneId: zoneA, qty: 5 }], hidden });
  await A.publish(db, 'admin');
  return c.id;
}

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123-456', accountName: '主辦' });
  combo2 = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
  zoneA = (await db.select().from(t.priceZone)).find((z) => z.name === 'A區')!.id;
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
  secret = await makeHidden();
});

const freeA = async (n: number) => (await db.select().from(t.eventSeat)).filter((s) => s.zoneId === zoneA && s.status === 'free' && !s.bundle).slice(0, n).map((s) => s.seatId);

describe('隱藏方案', () => {
  it('預設不隱藏：新方案與舊方案都照常出現在公開認購頁', async () => {
    const open = await makeHidden(false);
    const ids = (await preorderMenu(db)).items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([combo2, open]));
    expect((await db.select().from(t.combo).where(eq(t.combo.id, combo2)))[0].hidden).toBe(false);
  });

  it('公開頁看不到；人員看得到', async () => {
    expect((await preorderMenu(db)).items.some((i) => i.kind === 'combo' && i.id === secret)).toBe(false);
    const staff = await preorderMenu(db, { staff: true });
    expect(staff.staff).toBe(true);
    expect(staff.items.find((i) => i.id === secret)?.hidden).toBe(true);
    expect(JSON.stringify(await preorderMenu(db))).not.toContain('買五送一');
  });

  it('只剩隱藏方案時，公開頁不算開放', async () => {
    for (const c of (await db.select().from(t.combo))) if (c.id !== secret) await A.updateCombo(db, 'admin', c.id, { active: false });
    await A.publish(db, 'admin');
    expect((await preorderMenu(db)).open).toBe(false);
    await expect(submitPreorder(db, body(combo2))).rejects.toThrow();
    expect((await preorderMenu(db, { staff: true })).open).toBe(true);
  });

  it('一般買方猜到編號也送不出去', async () => {
    await expect(submitPreorder(db, body(secret))).rejects.toThrow('認購方案已變更');
    expect(await listPreorders(db)).toHaveLength(0);
  });

  it('人員代填：金額由伺服器算，備註與操作紀錄留下是誰代填', async () => {
    const r = await submitPreorder(db, body(secret), '', new Date(), undefined, '小老闆');
    expect(r.no).toBe('P0001');
    const [po] = await db.select().from(t.preorder);
    expect(po.amount).toBe(60000);
    expect(po.note).toContain('小老闆 代填');
    const log = await db.select().from(t.auditLog).where(eq(t.auditLog.action, 'preorder_staff_entry'));
    expect(log[0].actor).toBe('小老闆');
  });

  it('認購單關閉時人員仍可代填，一般買方不行', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: false });
    await expect(submitPreorder(db, body(combo2))).rejects.toThrow('未開放');
    await expect(submitPreorder(db, body(secret), '', new Date(), undefined, '小老闆')).resolves.toMatchObject({ no: 'P0001' });
  });

  it('全流程：代填、核帳、發連結、只有他的連結能劃隱藏方案', async () => {
    await submitPreorder(db, body(secret), '', new Date(), undefined, '小老闆');
    const [po] = await db.select().from(t.preorder);
    await checkPreorder(db, 'admin', po.id, { paid: true });
    const r = await confirmPreorder(db, 'admin', po.id);
    const code = (r as { code: string }).code;
    const st = await getBookingState(db, code);
    expect(st.combos.some((c) => c.id === secret)).toBe(true);
    const seats = await freeA(5);
    const h = await holdSeats(db, code, seats, secret);
    expect(h.orderId).toBeGreaterThan(0);
  });

  it('其他連結看不到也劃不了隱藏方案，舊方案不受影響', async () => {
    const l = await A.createInviteLink(db, 'admin', { name: '王', phone: '0922222222', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    const st = await getBookingState(db, l.code);
    expect(st.combos.some((c) => c.id === secret)).toBe(false);
    expect(st.combos.some((c) => c.id === combo2)).toBe(true);
    await expect(holdSeats(db, l.code, await freeA(5), secret)).rejects.toThrow('未開放');
  });

  it('隱藏方案專用票種不會出現在公開座位圖', async () => {
    const z = await A.createZone(db, 'admin');
    await A.updateZone(db, 'admin', z.id, { name: '秘密區', price: 12000 });
    const c = await A.createCombo(db, 'admin');
    await A.updateCombo(db, 'admin', c.id, { name: '秘密', price: 1, items: [{ zoneId: z.id, qty: 1 }], hidden: true });
    expect((await publicSeatMap(db))!.zones.some((x) => x.name === '秘密區')).toBe(false);
  });

  it('後台改份數可用隱藏方案；後台選單列得到', async () => {
    await submitPreorder(db, body(combo2));
    const [po] = await db.select().from(t.preorder);
    await setPreorderItems(db, 'admin', po.id, [{ kind: 'combo', id: secret, qty: 2 }]);
    const [after] = await db.select().from(t.preorder);
    expect(after.amount).toBe(120000);
    expect((await preorderMenuFull(db)).items.some((i) => i.id === secret)).toBe(true);
  });

  it('舊備份沒有 hidden 欄位也能還原，一律不隱藏', async () => {
    const b = await exportAll(db);
    for (const r of b.tables.combo) delete r.hidden;
    await importAll(db, b);
    expect((await db.select().from(t.combo)).every((c) => c.hidden === false)).toBe(true);
  });

  it('新備份保留隱藏狀態', async () => {
    const b = JSON.parse(JSON.stringify(await exportAll(db)));
    await importAll(db, b);
    expect((await db.select().from(t.combo).where(eq(t.combo.id, secret)))[0].hidden).toBe(true);
  });
});
