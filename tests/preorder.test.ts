import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats } from '@/lib/booking';
import { cancelPreorder, confirmPreorder, listPreorders, preorderMenu, submitPreorder } from '@/lib/preorder';

let db: Db;
let combo2: number; let zoneA: number;
const body = (o: Partial<Record<string, unknown>> = {}) => ({
  items: [{ kind: 'combo', id: combo2, qty: 2 }, { kind: 'zone', id: zoneA, qty: 1 }],
  name: '林大同', phone: '0912-345-678', email: 'lin@example.com', paidAmount: 15360, last5: '54321', agree: true, ...o,
});

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123-456', accountName: '主辦' });
  combo2 = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
  zoneA = (await db.select().from(t.priceZone)).find((z) => z.name === 'A區')!.id;
  await A.publish(db, 'admin');
});

describe('公開預購', () => {
  it('未開放時不能送出；開放後列出組合票與單張票種、匯款帳戶', async () => {
    expect((await preorderMenu(db)).open).toBe(false);
    await expect(submitPreorder(db, body())).rejects.toThrow('未開放');
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    const m = await preorderMenu(db);
    expect(m.open).toBe(true);
    expect(m.items.map((i) => i.name)).toEqual(expect.arrayContaining(['雙人套票', 'A區 單張']));
    expect(m.event.bankAccount).toBe('123-456');
  });

  it('送出：伺服器重算金額（6080×2＋3200＝15360）、寄出收件 Email；不佔座位', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    const r = await submitPreorder(db, body());
    expect(r).toEqual({ no: 'P0001', amount: 15360, mismatch: false });
    const r2 = await submitPreorder(db, body({ paidAmount: 100 }));
    expect(r2).toMatchObject({ no: 'P0002', mismatch: true });
    const n = await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_received'));
    expect(n).toHaveLength(2);
    expect(n[0].recipient).toBe('lin@example.com');
    expect(await db.select().from(t.orders)).toHaveLength(0);
  });

  it('欄位檢查：末五碼、手機、Email、未選購', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await expect(submitPreorder(db, body({ last5: '123' }))).rejects.toThrow('末 5 碼');
    await expect(submitPreorder(db, body({ phone: '0912345678123' }))).rejects.toThrow('手機');
    await expect(submitPreorder(db, body({ email: 'x' }))).rejects.toThrow('Email');
    await expect(submitPreorder(db, body({ items: [] }))).rejects.toThrow('至少選購');
  });

  it('確認收訖：建立不限張數、有效到演出當天的專屬連結，寄劃位連結 Email（含網址）；連結可以劃位', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await submitPreorder(db, body());
    const [p] = await listPreorders(db);
    expect(p.isNew).toBe(true);
    const r = await confirmPreorder(db, 'admin', p.id, 'https://abc.trycloudflare.com');
    const [l] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, r.code));
    expect(l).toMatchObject({ name: '林大同', phone: '0912345678', quota: 0 });
    expect(l.note).toContain('P0001');
    expect(l.expiresAt.toISOString()).toBe('2026-12-20T15:59:59.000Z');
    const mail = (await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_link')))[0];
    expect(mail.recipient).toBe('lin@example.com');
    expect(mail.content).toContain(`https://abc.trycloudflare.com/t/${r.code}`);
    const [p2] = await listPreorders(db);
    expect(p2).toMatchObject({ status: 'confirmed', linkCode: r.code, isNew: false });
    await expect(confirmPreorder(db, 'admin', p.id)).rejects.toThrow('已確認過');
    const single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
    const s = await getBookingState(db, r.code, new Date('2026-11-15T10:00:00+08:00'));
    expect(s.canBuy).toBe(21); // 不限張數，仍受每筆上限
    await expect(holdSeats(db, r.code, ['3-1'], single, new Date('2026-11-15T10:00:00+08:00'))).resolves.toBeTruthy();
  });

  it('取消：寄取消通知，不能再確認', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await submitPreorder(db, body());
    const [p] = await listPreorders(db);
    await cancelPreorder(db, 'admin', p.id, '查無入帳');
    expect((await listPreorders(db))[0].status).toBe('cancelled');
    expect((await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_cancelled')))[0].content).toContain('查無入帳');
    await expect(confirmPreorder(db, 'admin', p.id)).rejects.toThrow('已取消');
  });
});
