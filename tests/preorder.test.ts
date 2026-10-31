import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, linkEntitle, submitOrder } from '@/lib/booking';
import { cancelPreorder, confirmPreorder, listPreorders, preorderMenu, preorderStatus, savePreorderPush, setLineCfg, setPushLink, submitPreorder, checkPreorder, releasePreorder, updatePreorderEmail } from '@/lib/preorder';
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
    expect(r).toEqual({ no: 'P0001', token: expect.stringMatching(/^[\w-]{24}$/) }); // 買方看不到金額
    const r2 = await submitPreorder(db, body({ paidAmount: 100 }));
    expect(r2.no).toBe('P0002');
    const rows = await db.select().from(t.preorder).orderBy(t.preorder.id);
    expect(rows.map((x) => [x.amount, x.paidAmount])).toEqual([[15360, 15360], [15360, 100]]); // 後台照舊有金額
    const menu = await preorderMenu(db);
    expect(JSON.stringify(menu.items)).not.toContain('price');
    const n = await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_received'));
    expect(n).toHaveLength(2);
    expect(n[0].recipient).toBe('lin@example.com');
    expect(await db.select().from(t.orders)).toHaveLength(0);
  });

  it('LINE 群依選購項目：買雙人套票要加入功德群；A區單張要加入金群；兩種都買兩個都要', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await setLineCfg(db, 'admin', { groups: [{ name: '功德群', url: 'https://line.me/R/ti/g/a' }, { name: '金群', url: 'https://line.me/R/ti/g/b' }],
      map: { [`combo:${combo2}`]: 0, [`zone:${zoneA}`]: 1 } });
    expect((await preorderMenu(db)).line.groups).toHaveLength(2);
    await expect(submitPreorder(db, body())).rejects.toThrow('功德群、金群');
    await expect(submitPreorder(db, body({ lineJoined: ['功德群'] }))).rejects.toThrow('金群');
    expect((await submitPreorder(db, body({ lineJoined: ['功德群', '金群'] }))).no).toBe('P0001');
    expect((await submitPreorder(db, body({ items: [{ kind: 'combo', id: combo2, qty: 1 }], lineJoined: ['功德群'] }))).no).toBe('P0002');
    await expect(setLineCfg(db, 'admin', { groups: [{ name: 'x', url: 'line.me/xx' }], map: {} })).rejects.toThrow('https');
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
    expect(lk.paid).toMatchObject({ preorderNo: 'P0001', over: false, done: true, text: '雙人套票：已付 2 組，✅ 已劃完；A區 單張：已付 1 張，✅ 已劃完' });
    expect((await getBookingState(db, code, now)).paid?.done).toBe(true);
  });
  it('手動發的連結不受付款內容限制（沿用可購張數）', async () => {
    const l = await A.createInviteLink(db, 'admin', { name: '王小明', phone: '0922222222', quota: 0, expiresAt: new Date('2026-12-20T23:59:59+08:00') });
    expect((await getBookingState(db, l.code, now)).paid).toBeNull();
  });
});

describe('收款後劃位連結送到訂購人手機（也寄 Email）', () => {
  async function flow(pushLinkOn: boolean) {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    if (!pushLinkOn) await setPushLink(db, 'admin', false);
    const { token } = await submitPreorder(db, body());
    const other = await submitPreorder(db, body({ name: '別人', email: 'x@example.com' }));
    expect(await preorderStatus(db, [token])).toEqual([expect.objectContaining({ no: 'P0001', status: 'submitted', email: 'l***@example.com', url: null })]);
    expect(await preorderStatus(db, ['x'.repeat(24)])).toEqual([]);
    await savePreorderPush(db, token, { endpoint: 'https://push.example/lin', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } });
    await expect(savePreorderPush(db, 'y'.repeat(24), { endpoint: 'https://push.example/z', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } })).rejects.toThrow('找不到');
    await db.insert(t.appSetting).values([{ key: 'site.origin', value: 'https://ticket.aolforgood.com' }, { key: 'email.user', value: 'aolticket2026@gmail.com' }, { key: 'email.pass', value: 'p' }]);
    const p = (await listPreorders(db)).find((x) => x.no === 'P0001')!;
    const { code } = await confirmPreorder(db, 'admin', p.id);
    const got: { endpoint: string; title: string; body: string; url: string }[] = [];
    const mails: string[] = [];
    const ok = async () => undefined;
    await dispatchQueued(db, { email: async (_c, to, subject) => { mails.push(`${to}|${subject}`); }, sms: ok, push: async (sub, pl) => { got.push({ endpoint: sub.endpoint, title: pl.title, body: pl.body, url: pl.url }); } });
    const st = await preorderStatus(db, [token, other.token]);
    return { code, got, mails, st };
  }

  it('「推到手機＋開始劃位按鈕」已停用：推播只提醒查看 Email，預購頁不給連結；Email 照寄', async () => {
    const { code, got, st, mails } = await flow(true);
    expect(mails).toContain('lin@example.com|【祈福法會】付款確認・劃位通知');
    expect(got[0]).toMatchObject({ url: 'https://ticket.aolforgood.com/buy' });
    expect(got[0].body).not.toContain(code);
    expect(JSON.stringify(st)).not.toContain(code);
  });
});

describe('預購單發票：二聯／三聯（電子發票未開也記下來，之後再開）', () => {
  it('三聯要公司名稱與正確統編；二聯不用', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await expect(submitPreorder(db, body({ invType: 'company', invCode: '12345678', invTitle: '好公司' }), 'ip-inv')).rejects.toThrow('統一編號');
    await expect(submitPreorder(db, body({ invType: 'company', invCode: '22099131', invTitle: '' }), 'ip-inv')).rejects.toThrow('公司名稱');
    await submitPreorder(db, body({ invType: 'company', invCode: '22099131', invTitle: '好公司' }), 'ip-inv');
    await submitPreorder(db, body(), 'ip-inv');
    const rows = await db.select().from(t.preorder).orderBy(t.preorder.id);
    expect(rows.map((r) => [r.invType, r.invCode, r.invTitle])).toEqual([['company', '22099131', '好公司'], ['member', '', '']]);
  });
});

describe('老大依序發劃位：打勾不寄，按「發出」才寄；可分批（週二功德、週三金區）', () => {
  it('勾已匯款、已入群後，分批發出；劃位只限已發出的項目', async () => {
    await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    await setLineCfg(db, 'admin', { groups: [{ name: '功德群', url: 'https://line.me/R/ti/g/a' }, { name: '金群', url: 'https://line.me/R/ti/g/b' }],
      map: { [`combo:${combo2}`]: 0, [`zone:${zoneA}`]: 1 } });
    await submitPreorder(db, body({ lineJoined: ['功德群', '金群'], lineName: '小林', remits: [{ last5: '11111', amount: 15000 }, { last5: '22222', amount: 360 }] }), 'ip-q');
    const p = (await listPreorders(db))[0];
    expect(p).toMatchObject({ seq: 1, lineName: '小林', paidAmount: 15360, last5: '11111（NT$15,000）、22222（NT$360）', released: [] });
    expect(p.needGroups).toEqual({ [`combo:${combo2}`]: ['功德群'], [`zone:${zoneA}`]: ['金群'] });
    await expect(releasePreorder(db, 'admin', p.id, [`combo:${combo2}`])).rejects.toThrow('已匯款');
    await checkPreorder(db, 'admin', p.id, { paid: true });
    await expect(releasePreorder(db, 'admin', p.id, [`combo:${combo2}`])).rejects.toThrow('功德群');
    await checkPreorder(db, 'admin', p.id, { line: ['功德群'] });
    const before = (await db.select().from(t.notification)).length;
    // 週二：只發功德（雙人套票）
    const r1 = await releasePreorder(db, 'admin', p.id, [`combo:${combo2}`], 'https://x');
    expect(r1.rest).toBe('A區 單張 × 1');
    const mails = (await db.select().from(t.notification)).slice(before);
    expect(mails).toHaveLength(1); // 只有 Email，不發簡訊
    expect(mails[0].content).toContain('A區 單張 × 1 輪到時會再通知您');
    const ent1 = await linkEntitle(db, r1.linkId);
    expect(ent1!.rows.map((x) => x.name)).toEqual(['雙人套票']);
    // 週三：發金區（要先勾金群）
    await expect(releasePreorder(db, 'admin', p.id, [`zone:${zoneA}`])).rejects.toThrow('金群');
    await checkPreorder(db, 'admin', p.id, { line: ['功德群', '金群'] });
    const r2 = await releasePreorder(db, 'admin', p.id, [`zone:${zoneA}`], 'https://x');
    expect(r2.code).toBe(r1.code); // 同一個連結
    expect((await linkEntitle(db, r1.linkId))!.rows).toHaveLength(2);
    await expect(releasePreorder(db, 'admin', p.id, [`zone:${zoneA}`])).rejects.toThrow('已經發過');
    expect((await listPreorders(db))[0]).toMatchObject({ status: 'confirmed', released: [`combo:${combo2}`, `zone:${zoneA}`] });
    // 買方 Email 打錯：改正並補寄
    await expect(updatePreorderEmail(db, 'admin', p.id, 'bad', true)).rejects.toThrow('Email');
    const n0 = (await db.select().from(t.notification)).length;
    expect(await updatePreorderEmail(db, 'admin', p.id, 'right@example.com', true, 'https://x')).toMatchObject({ resent: true });
    const last = (await db.select().from(t.notification)).slice(n0);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ recipient: 'right@example.com', template: 'preorder_link' });
    expect(last[0].content).toContain('補寄');
    const { entText, entitle } = await import('@/lib/entitle');
    expect(entText(entitle([{ kind: 'combo', id: 1, name: '功德組', qty: 1 }], []).rows)).toBe('功德組：已付 1 組，已劃 0 組（還沒劃）');
  });
});
