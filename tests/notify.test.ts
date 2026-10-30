import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { holdSeats, submitOrder } from '@/lib/booking';
import { saveSubscription } from '@/lib/push';
import { dispatchQueued, mitakeSend, publicNotifyConfig, resendNotification, saveNotifyConfig, sendTest, type MailExtra, type Senders } from '@/lib/notify';

const T0 = new Date('2026-11-15T10:00:00+08:00');
const EXP = new Date('2026-12-10T23:59:59+08:00');
let db: Db;
let single: number;

async function order() {
  const h = await holdSeats(db, 'AAA111', ['3-1'], single, T0);
  await submitOrder(db, 'AAA111', {
    orderId: h.orderId, buyer: { name: '王大明', phone: '0912345678', email: 'wang@example.com' },
    holders: [{ seatId: '3-1', name: '王大明', id4: 'A123' }], agree: true,
  }, T0);
  return h.orderId;
}

function fake(fail?: { sms?: string; email?: string }) {
  const sent: { ch: string; to: string; text: string; subject?: string }[] = [];
  const s: Senders = {
    email: async (_c, to, subject, text) => { if (fail?.email) throw new Error(fail.email); sent.push({ ch: 'email', to, subject, text }); },
    sms: async (_c, to, text) => { if (fail?.sms) throw new Error(fail.sms); sent.push({ ch: 'sms', to, text }); },
  };
  return { s, sent };
}

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '測試場次', showAt: new Date('2026-12-20T19:30:00+08:00'), vipInstalled: false });
  await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 6, expiresAt: EXP });
  single = (await db.select().from(t.combo)).find((c) => c.isSingle)!.id;
});

const configure = () => saveNotifyConfig(db, 'tester', { 'email.user': 'ticket@gmail.com', 'email.pass': 'abcdabcdabcdabcd', 'sms.user': 'mitake', 'sms.pass': 'pw' });

describe('通知寄送', () => {
  it('未設定寄送帳號：通知標為「未寄出（尚未設定）」', async () => {
    await order();
    const { s, sent } = fake();
    await dispatchQueued(db, s);
    const rows = await db.select().from(t.notification);
    expect(rows.map((r) => r.status)).toEqual(['simulated']);
    expect(sent).toHaveLength(0);
  });

  it('設定後：送出訂購寄 Email；確認到帳寄簡訊＋Email，內容含「我的訂單」網址', async () => {
    await configure();
    const id = await order();
    const { s, sent } = fake();
    await dispatchQueued(db, s);
    expect(sent).toEqual([expect.objectContaining({ ch: 'email', to: 'wang@example.com', subject: '已收到您的劃位資料' })]);
    await A.confirmPayment(db, 'tester', id, { date: '2026-11-15', amount: 3200 }, T0, 'https://abc-def.trycloudflare.com');
    await dispatchQueued(db, s);
    const last = sent.slice(1);
    expect(last.map((x) => x.ch).sort()).toEqual(['email', 'sms']);
    expect(last[0].text).toContain('https://abc-def.trycloudflare.com/t/AAA111');
    const st = Object.fromEntries((await db.select().from(t.notification)).map((r) => [`${r.template}/${r.channel}`, r.status]));
    expect(st).toEqual({ 'order_received/email': 'sent', 'order_confirmed/sms': 'sent', 'order_confirmed/email': 'sent', 'order_confirmed/push': 'simulated' });
  });

  it('寄送失敗重試 3 次後標為失敗並記錄原因；修好後可重寄', async () => {
    await configure();
    await order();
    const bad = fake({ email: 'Email 帳號或應用程式密碼錯誤' });
    for (let i = 0; i < 3; i++) await dispatchQueued(db, bad.s);
    let [n] = await db.select().from(t.notification);
    expect(n).toMatchObject({ status: 'failed', attempts: 3, error: 'Email 帳號或應用程式密碼錯誤' });
    await db.update(t.notification).set({ status: 'queued', attempts: 0 }).where(eq(t.notification.id, n.id)); // 等同按「重寄」
    await dispatchQueued(db, fake().s);
    [n] = await db.select().from(t.notification);
    expect(n.status).toBe('sent');
    await expect(resendNotification(db, 'tester', 9999)).rejects.toThrow('找不到');
  });

  it('發出專屬連結的簡訊含完整網址', async () => {
    await configure();
    await A.createInviteLink(db, 'tester', { name: '乙', phone: '0922222222', quota: 21, expiresAt: EXP }, 'https://x-y.trycloudflare.com');
    const { s, sent } = fake();
    await dispatchQueued(db, s);
    expect(sent[0]).toMatchObject({ ch: 'sms', to: '0922222222' });
    expect(sent[0].text).toMatch(/https:\/\/x-y\.trycloudflare\.com\/t\/[A-Z0-9]{8} 可訂 21 張/);
  });

  it('密碼不回傳後台；密碼留空不會覆蓋', async () => {
    await configure();
    await saveNotifyConfig(db, 'tester', { 'email.user': 'new@gmail.com', 'email.pass': '' });
    const p = await publicNotifyConfig(db);
    expect(JSON.stringify(p)).not.toContain('abcdabcd');
    expect(p.email).toMatchObject({ user: 'new@gmail.com', passSet: true, ready: true });
  });

  it('測試寄送：未設定時提示、格式錯誤擋下', async () => {
    await expect(sendTest(db, 'sms', '0912345678', fake().s)).rejects.toThrow('三竹');
    await configure();
    await expect(sendTest(db, 'sms', '0912345678123', fake().s)).rejects.toThrow('10 位數字');
    await expect(sendTest(db, 'email', 'a@example.com', fake().s)).resolves.toBeUndefined();
  });
});

describe('三竹回應判讀', () => {
  const cfg = { url: 'https://smsapi.mitake.com.tw/api/mtk/SmSend', user: 'u', pass: 'p' };
  it('statuscode 1 為成功；帶 CharsetURL=UTF8 與表單參數', async () => {
    const f = vi.fn(async () => new Response('[1]\r\nmsgid=1234567890\r\nstatuscode=1\r\nAccountPoint=98\r\n'));
    vi.stubGlobal('fetch', f);
    await mitakeSend(cfg, '0912-345-678', '測試');
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain('CharsetURL=UTF8');
    expect(String(init.body)).toContain('dstaddr=0912345678');
    vi.unstubAllGlobals();
  });
  it('statuscode e 顯示帳密錯誤、s 顯示點數不足', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1]\r\nstatuscode=e\r\n')));
    await expect(mitakeSend(cfg, '0912345678', 'x')).rejects.toThrow('三竹帳號或密碼錯誤');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1]\r\nstatuscode=s\r\n')));
    await expect(mitakeSend(cfg, '0912345678', 'x')).rejects.toThrow('點數不足');
    vi.unstubAllGlobals();
  });
});

describe('App 推播', () => {
  it('訂購人開啟通知後，確認到帳直接推到他的手機，點開回到他的購票頁；別條連結收不到', async () => {
    const [aaa] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, 'AAA111'));
    await createLink(db, { eventId: aaa.eventId, code: 'BBB222', name: '乙', phone: '0922222222', quota: 6, expiresAt: EXP });
    const [bbb] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, 'BBB222'));
    await saveSubscription(db, aaa.id, null, { endpoint: 'https://push.example/aaa', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } });
    await saveSubscription(db, bbb.id, null, { endpoint: 'https://push.example/bbb', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } });
    await db.insert(t.appSetting).values({ key: 'site.origin', value: 'https://abc.trycloudflare.com' });
    const id = await order();
    const got: { endpoint: string; title: string; url: string }[] = [];
    const s: Senders = { ...fake().s, push: async (sub, p) => { got.push({ endpoint: sub.endpoint, title: p.title, url: p.url }); } };
    await A.confirmPayment(db, 'tester', id, { date: '2026-11-15', amount: 3200 }, T0);
    await dispatchQueued(db, s);
    expect(got).toEqual([{ endpoint: 'https://push.example/aaa', title: '🎉 劃位成功', url: 'https://abc.trycloudflare.com/t/AAA111' }]);
    const [p] = await db.select().from(t.notification).where(eq(t.notification.channel, 'push'));
    expect(p).toMatchObject({ status: 'sent', recipient: '1 支手機' });
  });

  it('手機已取消訂閱（410）會自動移除，該則標為僅顯示在購票頁', async () => {
    const [aaa] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.code, 'AAA111'));
    await saveSubscription(db, aaa.id, null, { endpoint: 'https://push.example/old', keys: { p256dh: 'k'.repeat(20), auth: 'a'.repeat(10) } });
    const id = await order();
    await A.confirmPayment(db, 'tester', id, { date: '2026-11-15', amount: 3200 }, T0);
    await dispatchQueued(db, { ...fake().s, push: async () => { throw new Error('GONE'); } });
    expect(await db.select().from(t.pushSub)).toHaveLength(0);
    const [p] = await db.select().from(t.notification).where(eq(t.notification.channel, 'push'));
    expect(p.status).toBe('simulated');
  });

  it('購票頁收到劃位成功訊息（含通知編號與類型，供頁面最上方提示）', async () => {
    const { getBookingState } = await import('@/lib/booking');
    const id = await order();
    await A.confirmPayment(db, 'tester', id, { date: '2026-11-15', amount: 3200 }, T0);
    const st = await getBookingState(db, 'AAA111', T0);
    expect(st.inbox[0]).toMatchObject({ template: 'order_confirmed' });
    expect(st.inbox[0].id).toBeGreaterThan(0);
    expect(st.inbox.filter((n) => n.template === 'order_confirmed')).toHaveLength(1); // 簡訊、Email、推播只顯示一次
  });
});

describe('先匯款再給連結', () => {
  it('不用填匯款資料、送出後不會逾期取消；連結只填姓名不寄簡訊、保存來帳備註', async () => {
    const l = await A.createInviteLink(db, 'admin', { name: '陳小美', phone: '', quota: 0, expiresAt: EXP, note: '末五碼 12345、NT$3,200' });
    expect(l.note).toBe('末五碼 12345、NT$3,200');
    expect(await db.select().from(t.notification).where(eq(t.notification.linkId, l.id))).toHaveLength(0);
    const h = await holdSeats(db, l.code, ['5-1'], single, T0);
    const r = await submitOrder(db, l.code, {
      orderId: h.orderId, buyer: { name: '陳小美', phone: '0912345678', email: 'mei@example.com' },
      holders: [{ seatId: '5-1', name: '陳小美', id4: 'B234' }], agree: true,
    }, T0);
    expect(r.orderNo).toBe('T1-00001');
    const { getBookingState } = await import('@/lib/booking');
    const later = await getBookingState(db, l.code, new Date(T0.getTime() + 20 * 86400_000));
    expect(later.orders[0].status).toBe('pending'); // 20 天後仍在，不會被取消
    expect('bankAccount' in later.event).toBe(false); // 購票頁不顯示匯款帳戶
  });

  it('劃位成功 Email 附每張票的 QR code（序號與入場券相同）', async () => {
    await configure();
    const id = await order();
    await A.confirmPayment(db, 'tester', id, { date: '2026-11-15', amount: 3200 }, T0);
    const mails: { subject: string; extra?: MailExtra }[] = [];
    await dispatchQueued(db, { ...fake().s, email: async (_c, _to, subject, _text, extra) => { mails.push({ subject, extra }); } });
    const m = mails.find((x) => x.subject.endsWith('劃位成功通知'))!;
    expect(m.extra!.attachments).toHaveLength(1);
    expect(m.extra!.attachments![0].filename).toBe('T1-00001-01.png');
    expect(m.extra!.attachments![0].content.subarray(1, 4).toString()).toBe('PNG');
    expect(m.extra!.html).toContain('cid:qr0@ticket');
    expect(m.extra!.html).toContain('T1-00001-01');
    expect(m.extra!.html).toContain('王○明');
  });
});

describe('劃位通知信（不易被當垃圾信）', () => {
  it('主旨帶演出名稱；HTML 有按鈕與網址文字', async () => {
    const { linkMail } = await import('@/lib/notify');
    const text = '【祈福音樂會】林大同 您好，已確認收到您的款項 NT$6,080（訂單 P0001：功德組 × 1）。請點以下專屬連結選位並填寫持票人資料：https://ticket.aolforgood.com/t/ABCD2345　連結有效至演出當天，請勿轉傳他人。';
    const m = linkMail(text, '主辦單位');
    expect(m.html).toContain('href="https://ticket.aolforgood.com/t/ABCD2345"');
    expect(m.html).toContain('開始劃位（選座位）');
    expect(m.html).toContain('訂單 P0001');
    expect(m.html).not.toContain('ABCD2345　');
  });
});
