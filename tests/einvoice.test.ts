import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { confirmPreorder, listPreorders, preorderMenu, submitPreorder } from '@/lib/preorder';
import { ECPAY_TEST, ecpayDecrypt, ecpayEncrypt, issueForOrder, saveEinvConfig, voidForOrder, type EinvPost } from '@/lib/einvoice';
import { invProblem, ubnValid } from '@/lib/invoiceRules';
import { ticketMail } from '@/lib/notify';
import { resetSales } from '@/lib/reset';

const K = ECPAY_TEST;
const now = new Date('2026-11-15T10:00:00+08:00');

describe('綠界加解密', () => {
  it('與綠界文件範例相同（JSON → URL encode → AES-128-CBC → Base64）', () => {
    expect(ecpayEncrypt('{"Name":"Test","ID":"A123456789"}', K.hashKey, K.hashIV))
      .toBe('uvI4yrErM37XNQkXGAgRgJAgHn2t72jahaMZzYhWL1HmvH4WV18VJDP2i9pTbC+tby5nxVExLLFyAkbjbS2Dvg==');
    const x = { RelateNumber: 'T100001N1', ItemName: '祈福音樂會 入場券（功德組）', Remark: 'a b+c&d' };
    expect(ecpayDecrypt(ecpayEncrypt(x, K.hashKey, K.hashIV), K.hashKey, K.hashIV)).toEqual(x);
  });
  it('統編、手機條碼、憑證、愛心碼格式', () => {
    expect(ubnValid('22099131')).toBe(true);
    expect(ubnValid('12345678')).toBe(false);
    expect(invProblem('mobile', '/ABC1234', '')).toBeNull();
    expect(invProblem('mobile', 'ABC1234', '')).toContain('手機條碼');
    expect(invProblem('cert', 'AB12345678901234', '')).toBeNull();
    expect(invProblem('donate', '12', '')).toContain('愛心碼');
    expect(invProblem('company', '22099131', '')).toContain('抬頭');
    expect(invProblem('company', '22099131', '台積電')).toBeNull();
  });
});

/** 假的綠界：檢查送來的內容，回傳加密的結果 */
function fakeEcpay(reply: (data: Record<string, unknown>, path: string) => Record<string, unknown>) {
  const calls: { path: string; data: Record<string, unknown> }[] = [];
  const post: EinvPost = async (url, body) => {
    const b = body as { MerchantID: string; Data: string };
    const data = ecpayDecrypt(b.Data, K.hashKey, K.hashIV) as Record<string, unknown>;
    const path = new URL(url).pathname;
    calls.push({ path, data });
    expect(url.startsWith('https://einvoice-stage.ecpay.com.tw/')).toBe(true);
    expect(b.MerchantID).toBe(K.merchantId);
    return { TransCode: 1, TransMsg: '', Data: ecpayEncrypt(reply(data, path), K.hashKey, K.hashIV) };
  };
  return { post, calls };
}

let db: Db;
let combo2: number;
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '祈福音樂會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123', accountName: '主辦' });
  combo2 = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
  await A.publish(db, 'admin');
  await A.updateEventSettings(db, 'admin', { preorderOpen: true });
});

async function paidOrder(inv: Record<string, string> = {}) {
  await submitPreorder(db, { items: [{ kind: 'combo', id: combo2, qty: 1 }], name: '林大同', phone: '0912345678', email: 'lin@example.com', paidAmount: 6080, last5: '12345', agree: true, ...inv });
  const [p] = await listPreorders(db);
  const { code } = await confirmPreorder(db, 'admin', p.id);
  const st = await getBookingState(db, code, now);
  const seats = st.seats.filter((x) => x.status === 'free' && st.zones.find((z) => z.id === x.zoneId)?.name === 'A區' && !x.bundle).slice(0, 2).map((x) => x.id);
  const h = await holdSeats(db, code, seats, combo2, now);
  await submitOrder(db, code, { orderId: h.orderId, buyer: { name: '林大同', phone: '0912345678', email: 'lin@example.com' },
    holders: seats.map((s, i) => ({ seatId: s, name: `持票人${i}`, id4: '12a4' })), agree: true }, now);
  await A.confirmPayment(db, 'admin', h.orderId, {}, new Date());
  return { orderId: h.orderId, code };
}

describe('劃位成功時開立電子發票', () => {
  it('未啟用：不開立，預購單也不顯示發票欄位', async () => {
    expect((await preorderMenu(db)).invoice).toBe(false);
    const { orderId } = await paidOrder();
    expect(await issueForOrder(db, orderId, fakeEcpay(() => ({})).post)).toBeNull();
  });

  it('手機條碼載具：送給綠界的內容正確；號碼寫進劃位成功 Email 與購票頁；不會重複開', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', env: 'test', itemName: '入場券' });
    expect((await preorderMenu(db)).invoice).toBe(true);
    await expect(submitPreorder(db, { items: [{ kind: 'combo', id: combo2, qty: 1 }], name: '林', phone: '0912345678', email: 'l@x.co', paidAmount: 6080, last5: '12345', agree: true, invType: 'mobile', invCode: 'abc' }))
      .rejects.toThrow('手機條碼');
    await db.delete(t.preorder);
    const { orderId, code } = await paidOrder({ invType: 'mobile', invCode: '/abc1234' });
    const ecpay = fakeEcpay(() => ({ RtnCode: 1, RtnMsg: '開立發票成功', InvoiceNo: 'AB12345678', InvoiceDate: '2026-11-15 10:00:00', RandomNumber: '6789' }));
    const inv = await issueForOrder(db, orderId, ecpay.post);
    expect(inv).toMatchObject({ status: 'issued', invoiceNo: 'AB12345678', env: 'test', amount: 6080, buyer: '手機條碼 /ABC1234' });
    const d = ecpay.calls[0].data;
    expect(ecpay.calls[0].path).toBe('/B2CInvoice/Issue');
    expect(d).toMatchObject({
      MerchantID: '2000132', RelateNumber: 'T100001N1', CustomerEmail: 'lin@example.com', CustomerName: '林大同',
      CarrierType: '3', CarrierNum: '/ABC1234', Print: '0', Donation: '0', TaxType: '1', InvType: '07', vat: '1', SalesAmount: 6080,
    });
    expect(d.Items).toEqual([{ ItemSeq: 1, ItemName: '祈福音樂會 入場券（雙人套票）', ItemCount: 1, ItemWord: '組', ItemPrice: 6080, ItemTaxType: '1', ItemAmount: 6080, ItemRemark: '' }]);

    expect((await issueForOrder(db, orderId, ecpay.post))!.invoiceNo).toBe('AB12345678');
    expect(ecpay.calls).toHaveLength(1);
    const mail = await ticketMail(db, orderId, '劃位成功');
    expect(mail.html).toContain('AB12345678');
    expect(mail.html).toContain('隨機碼 6789');
    expect(mail.html).toContain('測試環境');
    const st = await getBookingState(db, code, now);
    expect(st.orders[0].invoice).toEqual({ no: 'AB12345678', date: '2026-11-15', random: '6789', test: true });
    expect((await A.getAdminState(db)).orders.find((o) => o.id === orderId)!.invoice).toMatchObject({ status: 'issued', invoiceNo: 'AB12345678' });
  });

  it('公司統編：送統編與抬頭、存入會員載具（不印）；捐贈：送愛心碼', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', env: 'test' });
    const { orderId } = await paidOrder({ invType: 'company', invCode: '22099131', invTitle: '台灣積體電路製造股份有限公司' });
    const ecpay = fakeEcpay(() => ({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'CD00000001', InvoiceDate: '2026-11-15 10:00:00', RandomNumber: '0001' }));
    await issueForOrder(db, orderId, ecpay.post);
    expect(ecpay.calls[0].data).toMatchObject({ CustomerIdentifier: '22099131', CustomerName: '台灣積體電路製造股份有限公司', CarrierType: '1', Print: '0', Donation: '0' });
  });

  it('開立失敗：記錄原因、Email 註明另行通知；重新開立用新的 RelateNumber 成功', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', env: 'test' });
    const { orderId } = await paidOrder({ invType: 'donate', invCode: '168' });
    let fail = true;
    const ecpay = fakeEcpay(() => (fail ? { RtnCode: 5000099, RtnMsg: '愛心碼不存在' } : { RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'EF00000002', InvoiceDate: '2026-11-15 10:01:00', RandomNumber: '1111' }));
    const bad = await issueForOrder(db, orderId, ecpay.post);
    expect(bad).toMatchObject({ status: 'failed' });
    expect(bad!.error).toContain('愛心碼不存在');
    expect(ecpay.calls[0].data).toMatchObject({ Donation: '1', LoveCode: '168', CarrierType: '' });
    expect((await ticketMail(db, orderId, 'x')).html).toContain('電子發票開立中');
    fail = false;
    const ok = await issueForOrder(db, orderId, ecpay.post);
    expect(ok).toMatchObject({ status: 'issued', invoiceNo: 'EF00000002' });
    expect(ecpay.calls[1].data.RelateNumber).toBe('T100001N2');
  });

  it('刪除劃位前作廢發票；正式環境的發票沒作廢不能「清除測試資料」', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', env: 'test' });
    const { orderId } = await paidOrder();
    const ecpay = fakeEcpay((_d, path) => (path === '/B2CInvoice/Invalid' ? { RtnCode: 1, RtnMsg: '作廢成功', InvoiceNo: 'GH00000003' }
      : { RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'GH00000003', InvoiceDate: '2026-11-15 10:00:00', RandomNumber: '2222' }));
    await issueForOrder(db, orderId, ecpay.post);
    const v = await voidForOrder(db, orderId, '取消劃位', ecpay.post);
    expect(v).toMatchObject({ status: 'void', voidReason: '取消劃位' });
    expect(ecpay.calls[1].data).toMatchObject({ InvoiceNo: 'GH00000003', InvoiceDate: '2026-11-15', Reason: '取消劃位' });

    await db.update(t.invoice).set({ status: 'issued', env: 'prod' }).where(eq(t.invoice.orderId, orderId));
    await expect(resetSales(db, 'admin', {})).rejects.toThrow('正式電子發票');
  });

  it('正式環境沒填特店編號與金鑰不能啟用', async () => {
    await expect(saveEinvConfig(db, 'admin', { enabled: '1', env: 'prod' })).rejects.toThrow('特店編號');
    await saveEinvConfig(db, 'admin', { enabled: '1', env: 'prod', merchantId: '3000000', hashKey: 'k'.repeat(16), hashIV: 'i'.repeat(16) });
  });
});
