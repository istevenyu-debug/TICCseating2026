import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { getBookingState, holdSeats, submitOrder } from '@/lib/booking';
import { confirmPreorder, listPreorders, preorderMenu, submitPreorder } from '@/lib/preorder';
import {
  ECPAY_TEST, backfillInvoices, createForPreorder, ecpayDecrypt, ecpayEncrypt, editInvoiceBuyer, invoiceForLink, issueBatch, issueInvoice, listInvoices,
  publicEinvConfig, saveEinvConfig, voidInvoice, type EinvPost,
} from '@/lib/einvoice';
import { invProblem, ubnValid } from '@/lib/invoiceRules';
import { ticketMail } from '@/lib/notify';
import { resetSales } from '@/lib/reset';

const K = ECPAY_TEST;
const now = new Date('2026-11-15T10:00:00+08:00');

describe('綠界加解密與格式', () => {
  it('與綠界文件範例相同（JSON → URL encode → AES-128-CBC → Base64）', () => {
    expect(ecpayEncrypt('{"Name":"Test","ID":"A123456789"}', K.hashKey, K.hashIV))
      .toBe('uvI4yrErM37XNQkXGAgRgJAgHn2t72jahaMZzYhWL1HmvH4WV18VJDP2i9pTbC+tby5nxVExLLFyAkbjbS2Dvg==');
    const x = { RelateNumber: 'P0001ABC', ItemName: '祈福音樂會 入場券（功德組）', Remark: 'a b+c&d' };
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
  });
});

/** 假的綠界測試環境：依 API 回覆，並記下送來的內容 */
function fakeEcpay(reply: Partial<Record<string, (d: Record<string, unknown>) => Record<string, unknown>>>) {
  const calls: { path: string; data: Record<string, unknown> }[] = [];
  const post: EinvPost = async (url, body) => {
    const b = body as { MerchantID: string; Data: string };
    const data = ecpayDecrypt(b.Data, K.hashKey, K.hashIV) as Record<string, unknown>;
    const path = new URL(url).pathname;
    calls.push({ path, data });
    expect(url.startsWith('https://einvoice-stage.ecpay.com.tw/')).toBe(true);
    expect(b.MerchantID).toBe(K.merchantId);
    const f = reply[path] ?? (() => ({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'Y' }));
    return { TransCode: 1, TransMsg: '', Data: ecpayEncrypt(f(data), K.hashKey, K.hashIV) };
  };
  return { post, calls };
}
const issued = (no: string) => () => ({ RtnCode: 1, RtnMsg: 'ok', InvoiceNo: no, InvoiceDate: '2026-11-15 10:00:00', RandomNumber: '6789' });

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

const order = (o: Record<string, unknown> = {}) => ({ items: [{ kind: 'combo', id: combo2, qty: 2 }], name: '林大同', phone: '0912345678', email: 'lin@example.com', paidAmount: 12160, last5: '12345', agree: true, ...o });
async function confirmed(o: Record<string, unknown> = {}, post?: EinvPost) {
  await submitPreorder(db, order(o), '', new Date(), post);
  const p = (await listPreorders(db))[0];
  const { code, linkId } = await confirmPreorder(db, 'admin', p.id);
  return { preorderId: p.id, code, linkId };
}

describe('一筆訂單（收款）開一張發票', () => {
  it('未啟用：不建立發票，預購單也不顯示發票欄位', async () => {
    expect((await preorderMenu(db)).invoice).toBe(false);
    const { preorderId } = await confirmed();
    expect(await createForPreorder(db, preorderId, 'admin')).toBeNull();
  });

  it('模擬＋核對後開：確認收訖進待開清單；人工批次開立得到 TS 號碼；劃位成功信不提發票', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'mock', timing: 'review' }, '網管測試');
    const { preorderId, linkId } = await confirmed();
    const inv = await createForPreorder(db, preorderId, 'admin');
    expect(inv).toMatchObject({ status: 'pending', amount: 12160, orderNo: 'P0001', checks: [], buyer: '綠界會員載具（lin@example.com）', env: 'mock' });
    expect(await invoiceForLink(db, linkId)).toBeNull();
    const r = await issueBatch(db, [inv!.id], 'admin');
    expect(r[0]).toMatchObject({ status: 'issued', invoiceNo: 'TS00000001' });
    expect(await invoiceForLink(db, linkId)).toBeNull(); // 核對後開：信與購票頁都不顯示
    expect((await listInvoices(db))[0]).toMatchObject({ name: '林大同', status: 'issued', issuedBy: 'admin' });
  });

  it('修改啟用、模式、開立時機、課稅別要填「依誰指示」，記在修改紀錄', async () => {
    await expect(saveEinvConfig(db, 'admin', { enabled: '1' })).rejects.toThrow('依誰指示');
    await saveEinvConfig(db, 'admin', { enabled: '1', timing: 'auto', taxType: '3', itemName: '門票' }, '王董 10/30 電話');
    const c = await publicEinvConfig(db);
    expect(c).toMatchObject({ enabled: true, timing: 'auto', taxType: '3', itemName: '門票' });
    expect(c.log[0].detail).toContain('依 王董 10/30 電話 指示');
    expect(c.log[0].detail).toContain('課稅別：應稅 → 免稅');
    await saveEinvConfig(db, 'admin', { itemName: '入場券' }); // 品名不用填
    await expect(saveEinvConfig(db, 'admin', { mode: 'prod' }, '王董')).rejects.toThrow('特店編號');
  });

  it('綠界測試環境＋即開：送出前驗手機條碼；收訖就開立；個人發票名稱送「貴賓」；劃位成功信附發票號碼', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'test', timing: 'auto' }, '網管');
    const ecpay = fakeEcpay({ '/B2CInvoice/Issue': issued('AB12345678') });
    const { preorderId, code, linkId } = await confirmed({ invType: 'mobile', invCode: '/abc1234' }, ecpay.post);
    expect(ecpay.calls[0]).toMatchObject({ path: '/B2CInvoice/CheckBarcode', data: { BarCode: '/ABC1234' } });
    const inv = await createForPreorder(db, preorderId, 'admin', ecpay.post);
    expect(inv).toMatchObject({ status: 'issued', invoiceNo: 'AB12345678', env: 'test' });
    const d = ecpay.calls.find((c) => c.path === '/B2CInvoice/Issue')!.data;
    expect(d).toMatchObject({
      MerchantID: '2000132', CustomerName: '貴賓', CustomerEmail: 'lin@example.com', CustomerIdentifier: '', CarrierType: '3', CarrierNum: '/ABC1234',
      Print: '0', Donation: '0', TaxType: '1', InvType: '07', vat: '1', SalesAmount: 12160, InvoiceRemark: '訂單 P0001',
    });
    expect(d.Items).toEqual([{ ItemSeq: 1, ItemName: '祈福音樂會 入場券（雙人套票）', ItemCount: 2, ItemWord: '組', ItemPrice: 6080, ItemTaxType: '1', ItemAmount: 12160, ItemRemark: '' }]);
    expect(await createForPreorder(db, preorderId, 'admin', ecpay.post)).toMatchObject({ invoiceNo: 'AB12345678' }); // 不重複開

    // 劃位成功信附上這筆訂單的發票
    const st = await getBookingState(db, code, now);
    const seats = st.seats.filter((x) => x.status === 'free' && st.zones.find((z) => z.id === x.zoneId)?.name === 'A區' && !x.bundle).slice(0, 2).map((x) => x.id);
    const h = await holdSeats(db, code, seats, combo2, now);
    await submitOrder(db, code, { orderId: h.orderId, buyer: { name: '林大同', phone: '0912345678', email: 'lin@example.com' }, holders: seats.map((s, i) => ({ seatId: s, name: `持票人${i}`, id4: '12a4' })), agree: true }, now);
    await A.confirmPayment(db, 'admin', h.orderId, {}, new Date());
    const mail = await ticketMail(db, h.orderId, '劃位成功');
    expect(mail.html).toContain('AB12345678');
    expect(mail.html).toContain('測試，非正式發票');
    expect((await getBookingState(db, code, now)).invoice).toMatchObject({ no: 'AB12345678', amount: 12160, test: true });
    expect(linkId).toBeTruthy();
  });

  it('送出前就擋：手機條碼、愛心碼不存在，統編檢查碼錯', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'test' }, '網管');
    const no = fakeEcpay({ '/B2CInvoice/CheckBarcode': () => ({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'N' }), '/B2CInvoice/CheckLoveCode': () => ({ RtnCode: 1, RtnMsg: 'ok', IsExist: 'N' }) });
    await expect(submitPreorder(db, order({ invType: 'mobile', invCode: '/ZZZ9999' }), '', new Date(), no.post)).rejects.toThrow('手機條碼 /ZZZ9999 不存在');
    await expect(submitPreorder(db, order({ invType: 'donate', invCode: '9999' }), '', new Date(), no.post)).rejects.toThrow('愛心碼 9999 不存在');
    await expect(submitPreorder(db, order({ invType: 'company', invCode: '12345678', invTitle: 'X' }), '', new Date(), no.post)).rejects.toThrow('統一編號');
  });

  it('即開但有異常（抬頭與登記不同、匯款金額不符）：不自動開，人工確認（force）後才開；送公司抬頭與統編', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'test', timing: 'auto' }, '網管');
    const ecpay = fakeEcpay({ '/B2CInvoice/GetCompanyNameByTaxID': () => ({ RtnCode: 1, RtnMsg: 'ok', CompanyName: '台灣積體電路製造股份有限公司' }), '/B2CInvoice/Issue': issued('CD00000001') });
    const { preorderId } = await confirmed({ invType: 'company', invCode: '22099131', invTitle: '台積電', paidAmount: 12000 }, ecpay.post);
    const inv = await createForPreorder(db, preorderId, 'admin', ecpay.post);
    expect(inv!.status).toBe('pending');
    expect(inv!.checks).toEqual(['匯款金額 NT$12,000 與訂單合計 NT$12,160 不同', '抬頭「台積電」與財政部登記的「台灣積體電路製造股份有限公司」不同']);
    await expect(issueInvoice(db, inv!.id, 'admin', false, ecpay.post)).rejects.toThrow('有異常');
    // 人工把抬頭改正，金額異常仍在 → 人工確認後強制開立
    const ed = await editInvoiceBuyer(db, inv!.id, 'admin', { invType: 'company', invCode: '22099131', invTitle: '臺灣積體電路製造股份有限公司' }, ecpay.post);
    expect(ed.checks).toEqual(['匯款金額 NT$12,000 與訂單合計 NT$12,160 不同']);
    const ok = await issueInvoice(db, inv!.id, 'admin', true, ecpay.post);
    expect(ok.status).toBe('issued');
    expect(ecpay.calls.filter((c) => c.path === '/B2CInvoice/Issue')[0].data).toMatchObject({ CustomerIdentifier: '22099131', CustomerName: '臺灣積體電路製造股份有限公司', CarrierType: '1', Print: '0' });
  });

  it('開立失敗可重開；作廢後重新建立待開；正式發票沒作廢不能清除測試資料', async () => {
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'test', timing: 'review' }, '網管');
    let fail = true;
    const ecpay = fakeEcpay({
      '/B2CInvoice/Issue': () => (fail ? { RtnCode: 5000099, RtnMsg: '系統忙碌' } : { RtnCode: 1, RtnMsg: 'ok', InvoiceNo: 'EF00000002', InvoiceDate: '2026-11-15 10:01:00', RandomNumber: '1111' }),
      '/B2CInvoice/Invalid': () => ({ RtnCode: 1, RtnMsg: '作廢成功', InvoiceNo: 'EF00000002' }),
    });
    const { preorderId } = await confirmed({}, ecpay.post);
    const inv = await createForPreorder(db, preorderId, 'admin', ecpay.post);
    expect((await issueBatch(db, [inv!.id], 'admin', false, ecpay.post))[0]).toMatchObject({ status: 'failed', error: '綠界：系統忙碌' });
    fail = false;
    expect((await issueBatch(db, [inv!.id], 'admin', false, ecpay.post))[0]).toMatchObject({ status: 'issued', invoiceNo: 'EF00000002' });
    await expect(voidInvoice(db, inv!.id, 'admin', '', true, ecpay.post)).rejects.toThrow('作廢原因');
    const v = await voidInvoice(db, inv!.id, 'admin', '抬頭有誤', true, ecpay.post);
    expect(v).toMatchObject({ status: 'void', voidReason: '抬頭有誤' });
    expect(ecpay.calls.find((c) => c.path === '/B2CInvoice/Invalid')!.data).toMatchObject({ InvoiceNo: 'EF00000002', InvoiceDate: '2026-11-15', Reason: '抬頭有誤' });
    const all = await listInvoices(db);
    expect(all.map((x) => x.status)).toEqual(['pending', 'void']);

    await db.update(t.invoice).set({ status: 'issued', env: 'prod' }).where(eq(t.invoice.id, inv!.id));
    await expect(resetSales(db, 'admin', {})).rejects.toThrow('正式電子發票');
  });

  it('啟用前就收訖的訂單：補建待開發票，不重複建立', async () => {
    await confirmed();
    await expect(backfillInvoices(db, 'admin')).rejects.toThrow('先啟用');
    await saveEinvConfig(db, 'admin', { enabled: '1', mode: 'mock' }, '網管');
    expect(await backfillInvoices(db, 'admin')).toEqual({ created: 1 });
    expect(await backfillInvoices(db, 'admin')).toEqual({ created: 0 });
    expect((await listInvoices(db)).map((x) => x.status)).toEqual(['pending']);
  });
});
