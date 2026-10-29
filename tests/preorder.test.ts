import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { cancelPreorder, confirmPreorder, listPreorders, preorderMenu, preorderStatus, savePreorderPush, submitPreorder } from '@/lib/preorder';
import { dispatchQueued } from '@/lib/notify';

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
    expect(r).toMatchObject({ no: 'P0001', amount: 15360, mismatch: false });
    expect(r.token).toMatch(/^[\w-]{24}$/);
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
    const mail = (await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_link'))).find((n) => n.channel === 'email')!;
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

describe('收款後的劃位連結自動帶入', () => {
  it('帶入姓名、手機、Email、已購內容與購票方式', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await submitPreorder(db, body());
    const [p] = await listPreorders(db);
    const r = await confirmPreorder(db, 'admin', p.id);
    const s = await getBookingState(db, r.code, new Date('2026-11-15T10:00:00+08:00'));
    expect(s.prefill).toEqual({ name: '林大同', phone: '0912345678', email: 'lin@example.com', comboId: combo2, bought: '雙人套票 × 2、A區 單張 × 1' });
  });
  it('一般手動發的連結：只帶姓名與手機', async () => {
    const l = await A.createInviteLink(db, 'admin', { name: '王小明', phone: '0922222222', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    const s = await getBookingState(db, l.code, new Date('2026-11-15T10:00:00+08:00'));
    expect(s.prefill).toEqual({ name: '王小明', phone: '0922222222', email: '', comboId: 0, bought: '' });
  });
});

describe('劃位連結只能劃付款買的內容', () => {
  const now = new Date('2026-11-15T10:00:00+08:00');
  it('雙人套票 × 2＋A區單張 × 1：不能多劃、不能換方式、劃完就不能再劃；後台顯示已付／已劃', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await submitPreorder(db, body());
    const [p] = await listPreorders(db);
    const { code } = await confirmPreorder(db, 'admin', p.id);
    const combos = await db.select().from(t.combo);
    const single = combos.find((c) => c.isSingle)!.id;
    const other = combos.find((c) => c.name === '親子四人套票')!.id;
    const st0 = await getBookingState(db, code, now);
    const a = st0.seats.filter((x) => x.zoneId === zoneA && x.status === 'free' && !x.bundle).map((x) => x.id);
    expect(st0.paid?.rows.map((r) => [r.name, r.qty, r.left])).toEqual([['雙人套票', 2, 2], ['A區 單張', 1, 1]]);

    await expect(holdSeats(db, code, a.slice(0, 6), combo2, now)).rejects.toThrow('還可劃 2 組');
    await expect(holdSeats(db, code, a.slice(0, 4), other, now)).rejects.toThrow('請用這個購票方式');
    await expect(holdSeats(db, code, a.slice(0, 2), single, now)).rejects.toThrow('還可劃 1 張');

    const h = await holdSeats(db, code, a.slice(0, 4), combo2, now);
    const holders = a.slice(0, 4).map((id, i) => ({ seatId: id, name: `持票人${i}`, id4: '12a4' }));
    await submitOrder(db, code, { orderId: h.orderId, buyer: { name: '林大同', phone: '0912345678', email: 'lin@example.com' }, holders, agree: true }, now);
    await expect(holdSeats(db, code, a.slice(4, 6), combo2, now)).rejects.toThrow('已經全部劃完');
    await expect(holdSeats(db, code, a.slice(4, 5), single, now)).resolves.toBeTruthy();

    const s = await A.getAdminState(db, now);
    const lk = s.links.find((l) => l.code === code)!;
    expect(lk.paid).toMatchObject({ preorderNo: 'P0001', over: false, done: true, text: '雙人套票 2/2 組、A區 單張 1/1 張' });
    expect((await getBookingState(db, code, now)).paid?.done).toBe(true);
  });
  it('手動發的連結不受付款內容限制（沿用可購張數）', async () => {
    const l = await A.createInviteLink(db, 'admin', { name: '王小明', phone: '0922222222', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    expect((await getBookingState(db, l.code, now)).paid).toBeNull();
  });
});

describe('劃位連結直接推到訂購人手機', () => {
  it('送出時拿到查詢碼；開推播；確認收款後推劃位連結，查詢頁也出現劃位按鈕；別人的碼查不到', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    const { token } = await submitPreorder(db, body());
    const other = await submitPreorder(db, body({ name: '別人', email: 'x@example.com' }));
    expect(await preorderStatus(db, [token])).toMatchObject([{ no: 'P0001', status: 'submitted', url: null }]);
    expect(await preorderStatus(db, ['x'.repeat(24)])).toEqual([]);
    await savePreorderPush(db, token, { endpoint: 'https://push.example/lin', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } });
    await expect(savePreorderPush(db, 'y'.repeat(24), { endpoint: 'https://push.example/z', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } })).rejects.toThrow('找不到');
    await db.insert(t.appSetting).values({ key: 'site.origin', value: 'https://abc.trycloudflare.com' });

    const p = (await listPreorders(db)).find((x) => x.no === 'P0001')!;
    const { code } = await confirmPreorder(db, 'admin', p.id);
    const got: { endpoint: string; title: string; url: string }[] = [];
    const ok = async () => undefined;
    await dispatchQueued(db, { email: ok, sms: ok, push: async (sub, pl) => { got.push({ endpoint: sub.endpoint, title: pl.title, url: pl.url }); } });
    expect(got).toEqual([{ endpoint: 'https://push.example/lin', title: '✅ 已確認收款，請點此劃位', url: `https://abc.trycloudflare.com/t/${code}` }]);
    expect(await preorderStatus(db, [token, other.token])).toMatchObject([
      { no: 'P0002', status: 'submitted', url: null }, { no: 'P0001', status: 'confirmed', url: `/t/${code}` },
    ]);
  });
});
