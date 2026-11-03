import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, createLink, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { exportAll, importAll } from '@/lib/backup';
import { BookingError, getBookingState, holdSeats, publicSeatMap, submitOrder } from '@/lib/booking';
import {
  adminQuery, cardMenu, cardStatus, checkMac, createCardOrder, ECPAY_PAY_TEST, floor3Stock, floor3State, handleGatewayResult, macOk, pollPending, refundActions, refundCardOrder,
  refundLastDay, refundText, saveCardKeys, saveCardSettings, type CardPost,
} from '@/lib/card';
import { saveEinvConfig } from '@/lib/einvoice';
import { ensureFloor3, floor3Plans, frameComboGroup, unframeComboGroup } from '@/lib/floor';
import { buildSeats, buildSeats3F } from '@/lib/layout';
import { listPreorders, preorderMenuFull } from '@/lib/preorder';
import { resetSales } from '@/lib/reset';
import { findBySerial } from './helpers/ticket';

const T0 = new Date('2026-11-06T12:00:00+08:00');
const SHOW = new Date('2026-12-09T19:30:00+08:00');
const EXP = new Date('2026-12-10T23:59:59+08:00');
const ORIGIN = 'https://ticket.example.com';
let db: Db; let evId: number;
let singleZone: number; let comboId: number; let singleCombo: number;

const buyer = { name: '王小明', phone: '0912345678', email: 'a@example.com', invType: 'member', invCode: '', invTitle: '', agree: true };
const rowSeats = (row: number, nos: number[]) => nos.map((n) => `${row}-${n}`);
const ELEVEN = rowSeats(13, [33, 31, 29, 27, 25, 23, 21, 19, 17, 15, 13]);

/** 綠界送來的通知（用測試金鑰簽名） */
function gw(tradeNo: string, amount: number, extra: Record<string, string> = {}) {
  const f: Record<string, string> = { MerchantID: ECPAY_PAY_TEST.merchantId, MerchantTradeNo: tradeNo, RtnCode: '1', RtnMsg: '交易成功', TradeNo: '2611061200000001', TradeAmt: String(amount), PaymentDate: '2026/11/06 12:01:00', PaymentType: 'Credit_CreditCard', SimulatePaid: '0', ...extra };
  f.CheckMacValue = checkMac(f, ECPAY_PAY_TEST.hashKey, ECPAY_PAY_TEST.hashIV);
  return f;
}
async function buy(items: { kind: 'combo' | 'zone'; id: number; qty: number }[], who = buyer, now = T0) {
  const r = await createCardOrder(db, { ...who, items }, ORIGIN, now);
  const amount = Number(r.fields.TotalAmount);
  const pay = await handleGatewayResult(db, gw(r.fields.MerchantTradeNo, amount), 'return', now);
  return { ...r, amount, tradeNo: r.fields.MerchantTradeNo, code: pay.code! };
}

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  const ev = await createEvent(db, { name: '萬變中', showAt: SHOW, vipInstalled: false, holdMinutes: 60 });
  evId = ev.id;
  await ensureFloor3(db);
  const p = await floor3Plans(db, ev.id);
  singleZone = p.zones.find((z) => !p.comboZone.has(z.id))!.id;
  comboId = p.set!.id; singleCombo = p.single!.id;
  await saveCardSettings(db, 'admin', { open: true });
});

describe('座位', () => {
  it('第 13–27 排 724 席，與示意圖每區數字相符', () => {
    const s = buildSeats3F();
    expect(s).toHaveLength(724);
    const n = (sec: string) => s.filter((x) => x.section === sec).length;
    expect([n('L'), n('C'), n('R'), n('WL'), n('WR')]).toEqual([180, 150, 180, 107, 107]);
    expect(s.filter((x) => x.rowNo === 13 && x.section.startsWith('W'))).toHaveLength(0); // 第 13 排沒有斜區
    expect(s.filter((x) => x.rowNo === 27 && x.section === 'WR').map((x) => x.seatNo).at(-1)).toBe('56');
  });
  it('編號與位置都不重複，也不和 1–12 排重複', () => {
    const s = buildSeats3F();
    expect(new Set(s.map((x) => x.id)).size).toBe(724);
    expect(new Set(s.map((x) => x.code)).size).toBe(724);
    expect(new Set(s.map((x) => `${x.x},${x.y}`)).size).toBe(724);
    const old = new Set(buildSeats().map((x) => x.id));
    expect(s.some((x) => old.has(x.id))).toBe(false);
  });
  it('右斜區外側分開的座位不算相連', () => {
    const at = (id: string) => buildSeats3F().find((x) => x.id === id)!;
    expect(at('22-52').x - at('22-50').x).toBe(2);
    expect(at('23-54').x - at('23-52').x).toBe(2);
    expect(at('24-54').x - at('24-52').x).toBe(2);
    expect(at('25-56').x - at('25-54').x).toBe(2);
    expect(at('26-54').x - at('26-52').x).toBe(1);
  });
  it('補座位可以重複執行，改過的價格和框好的組合都留著', async () => {
    await A.updateZone(db, 'admin', singleZone, { price: 2800 });
    await frameComboGroup(db, 'admin', ELEVEN);
    await ensureFloor3(db);
    expect((await db.select().from(t.priceZone).where(eq(t.priceZone.id, singleZone)))[0].price).toBe(2800);
    expect((await db.select().from(t.eventSeat).where(inArray(t.eventSeat.seatId, ELEVEN))).every((s) => s.bundle)).toBe(true);
    expect((await db.select().from(t.venueSeat).where(eq(t.venueSeat.floor, '3F')))).toHaveLength(724);
  });
});

describe('與 2M 隔離', () => {
  const link = (code: string) => createLink(db, { eventId: evId, code, name: '甲', phone: '0911111111', quota: 0, expiresAt: EXP });
  it('2M 連結看不到、選不到三樓', async () => {
    await A.publish(db, 'admin', T0);
    await link('M2AAAA');
    const s = await getBookingState(db, 'M2AAAA', T0);
    expect(s.seats.some((x) => x.id === '13-1')).toBe(false);
    expect(s.seats.length).toBe(buildSeats().filter((x) => x.seatType !== 'vip').length);
    expect(s.combos.some((c) => c.name.includes('三樓'))).toBe(false);
    await expect(holdSeats(db, 'M2AAAA', ['13-1'], s.combos.find((c) => c.isSingle)!.id, T0)).rejects.toThrow(BookingError);
    await expect(holdSeats(db, 'M2AAAA', ['1-1'], singleCombo, T0)).rejects.toThrow('未開放');
  });
  it('三樓連結看不到、選不到 2M', async () => {
    const { code } = await buy([{ kind: 'zone', id: singleZone, qty: 2 }]);
    const s = await getBookingState(db, code, T0);
    expect(s.seats).toHaveLength(724);
    expect(s.seats.some((x) => x.id === '1-1')).toBe(false);
    await expect(holdSeats(db, code, ['1-1', '1-3'], singleCombo, T0)).rejects.toThrow('不開放');
  });
  it('2M 的發布不會動到三樓；三樓設定也不影響 2M 已發布內容', async () => {
    const before = (await A.publish(db, 'admin', T0));
    const ids3 = (await floor3Plans(db, evId)).zones.map((z) => z.id);
    expect(before.zoneIds.some((z) => ids3.includes(z))).toBe(false);
    await saveCardSettings(db, 'admin', { open: false });
    const [ev] = await db.select().from(t.event).where(eq(t.event.id, evId));
    expect(ev.published).toEqual(before);
  });
  it('2M 關閉時，已付款的三樓買方還是能劃位', async () => {
    const { code } = await buy([{ kind: 'zone', id: singleZone, qty: 1 }]);
    await A.updateEventSettings(db, 'admin', { saleOpen: false });
    await A.publish(db, 'admin', T0);
    await expect(holdSeats(db, code, ['13-1'], singleCombo, T0)).resolves.toBeTruthy();
  });
  it('2M 後台狀態、認購單、公開座位圖都沒有三樓', async () => {
    await A.publish(db, 'admin', T0);
    const s = await A.getAdminState(db, T0);
    expect(s.seats.some((x) => x.row >= 13)).toBe(false);
    expect(s.stats.total).toBe(buildSeats().filter((x) => x.seatType !== 'vip').length);
    expect(s.zones.some((z) => z.name.includes('三樓'))).toBe(false);
    expect(s.combos.some((c) => c.name.includes('三樓'))).toBe(false);
    expect(s.dirty).toBe(false);
    expect((await preorderMenuFull(db)).items.some((i) => i.name.includes('三樓'))).toBe(false);
    expect((await publicSeatMap(db))!.seats.some((x) => x.id === '13-1')).toBe(false);
  });
  it('三樓刷卡單不進四、五、六', async () => {
    const { code } = await buy([{ kind: 'zone', id: singleZone, qty: 1 }]);
    const h = await holdSeats(db, code, ['13-1'], singleCombo, T0);
    expect(await listPreorders(db)).toHaveLength(0);
    const s = await A.getAdminState(db, T0);
    expect(s.links).toHaveLength(0);
    expect(s.orders.some((o) => o.id === h.orderId)).toBe(false);
    expect(s.stats.held).toBe(0);
  });
  it('2M 分組的預設、存檔還原都不動三樓的組合', async () => {
    await frameComboGroup(db, 'admin', ELEVEN);
    const b4 = await db.select().from(t.eventSeat).where(inArray(t.eventSeat.seatId, ELEVEN));
    await A.saveBundleSnapshot(db, 'admin');
    await A.applyBundlePresets(db, 'admin');
    await A.restoreBundleSnapshot(db, 'admin', 'saved');
    await A.restoreBundleSnapshot(db, 'admin', 'undo');
    const after = await db.select().from(t.eventSeat).where(inArray(t.eventSeat.seatId, ELEVEN));
    expect(after.map((x) => x.bundle).sort()).toEqual(b4.map((x) => x.bundle).sort());
    expect(new Set(after.map((x) => x.bundle)).size).toBe(1);
  });
  it('票種、組合票、連座都不能跨樓層', async () => {
    const zones2 = (await db.select().from(t.priceZone).where(eq(t.priceZone.floor, '2M')));
    await expect(A.assignZoneSeats(db, 'admin', zones2[0].id, ['13-1'])).rejects.toThrow('另一層');
    await expect(A.assignZoneSeats(db, 'admin', singleZone, ['1-1'])).rejects.toThrow('另一層');
    await expect(A.updateCombo(db, 'admin', comboId, { items: [{ zoneId: zones2[0].id, qty: 11 }] })).rejects.toThrow('自己這一層');
    await expect(A.bundleManual(db, 'admin', ['1-1', '13-1'])).rejects.toThrow('跨樓層');
  });
});

describe('買 10 送 1：點一下就 11 位', () => {
  it('框組：要剛好 11 席，且不能框 2M、不能重複框', async () => {
    await expect(frameComboGroup(db, 'admin', ELEVEN.slice(0, 10))).rejects.toThrow('11 席');
    await expect(frameComboGroup(db, 'admin', rowSeats(1, [33, 31, 29, 27, 25, 23, 21, 19, 17, 15, 13]))).rejects.toThrow('三樓');
    await frameComboGroup(db, 'admin', ELEVEN);
    await expect(frameComboGroup(db, 'admin', ELEVEN)).rejects.toThrow('別組');
  });
  it('買方選一席，系統要求整組 11 席；付 30000 元劃 11 席', async () => {
    await frameComboGroup(db, 'admin', ELEVEN);
    const { code, amount } = await buy([{ kind: 'combo', id: comboId, qty: 1 }]);
    expect(amount).toBe(30000);
    const s = await getBookingState(db, code, T0);
    expect(new Set(s.seats.filter((x) => ELEVEN.includes(x.id)).map((x) => x.bundle)).size).toBe(1);
    await expect(holdSeats(db, code, [ELEVEN[0]], comboId, T0)).rejects.toThrow('整組');
    const h = await holdSeats(db, code, ELEVEN, comboId, T0);
    expect(h.amount).toBe(30000);
    await expect(holdSeats(db, code, ELEVEN, singleCombo, T0)).rejects.toThrow();
  });
  it('可單買由後台設定：關掉單張就買不到，組合照賣；買單張的人選不到組合席', async () => {
    await frameComboGroup(db, 'admin', ELEVEN);
    await A.updateCombo(db, 'admin', singleCombo, { active: false });
    let m = await cardMenu(db, T0);
    expect(m.items.map((i) => i.kind)).toEqual(['combo']);
    await expect(createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0)).rejects.toThrow('未開放');
    await A.updateCombo(db, 'admin', singleCombo, { active: true });
    m = await cardMenu(db, T0);
    expect(m.items.map((i) => i.kind)).toEqual(['combo', 'zone']);
    const { code } = await buy([{ kind: 'zone', id: singleZone, qty: 1 }]);
    await expect(holdSeats(db, code, ELEVEN, singleCombo, T0)).rejects.toThrow();
  });
  it('拆組後改回單張；已被劃走的組不能拆', async () => {
    await frameComboGroup(db, 'admin', ELEVEN);
    await unframeComboGroup(db, 'admin', ELEVEN[3]);
    const s = await db.select().from(t.eventSeat).where(inArray(t.eventSeat.seatId, ELEVEN));
    expect(s.every((x) => x.bundle === null && x.zoneId === singleZone)).toBe(true);
    await frameComboGroup(db, 'admin', ELEVEN);
    const { code } = await buy([{ kind: 'combo', id: comboId, qty: 1 }]);
    await holdSeats(db, code, ELEVEN, comboId, T0);
    await expect(unframeComboGroup(db, 'admin', ELEVEN[0])).rejects.toThrow('不能拆');
  });
});

describe('付款', () => {
  it('檢查碼與綠界文件範例一致', () => {
    const p = { TradeDesc: '促銷方案', PaymentType: 'aio', MerchantTradeDate: '2023/03/12 15:30:23', MerchantTradeNo: 'ecpay20230312153023', MerchantID: '3002607', ReturnURL: 'https://www.ecpay.com.tw/receive.php', ItemName: 'Apple iphone 15', TotalAmount: '30000', ChoosePayment: 'ALL', EncryptType: '1' };
    expect(checkMac(p, 'pwFHCqoQZGmho4w6', 'EkRm7iFT261dpevs')).toBe('6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840');
  });
  it('未開賣、截止、關閉都不能買', async () => {
    await saveCardSettings(db, 'admin', { open: false });
    await expect(createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0)).rejects.toThrow('未開放');
    await saveCardSettings(db, 'admin', { open: true, saleStart: '2026-11-07T10:00:00+08:00' });
    expect((await cardMenu(db, T0)).state).toBe('not_started');
    await saveCardSettings(db, 'admin', { saleStart: null, saleEnd: '2026-11-05T10:00:00+08:00' });
    expect((await cardMenu(db, T0)).state).toBe('ended');
  });
  it('送綠界的表單：金額由伺服器算、不信任前端；有檢查碼', async () => {
    const r = await createCardOrder(db, { ...buyer, price: 1, amount: 1, items: [{ kind: 'zone', id: singleZone, qty: 2 }] }, ORIGIN, T0);
    expect(r.fields.TotalAmount).toBe('6000');
    expect(r.fields.ChoosePayment).toBe('Credit');
    expect(r.fields.ReturnURL).toBe(`${ORIGIN}/api/card/return`);
    expect(r.fields.MerchantTradeNo.length).toBeLessThanOrEqual(20);
    expect(macOk(r.fields, ECPAY_PAY_TEST.hashKey, ECPAY_PAY_TEST.hashIV)).toBe(true);
  });
  it('通知重複來、三道同時來，只會給一次權利、寄一封信', async () => {
    const r = await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    const f = gw(r.fields.MerchantTradeNo, 3000);
    const a = await Promise.all([handleGatewayResult(db, f, 'return', T0), handleGatewayResult(db, f, 'result', T0), handleGatewayResult(db, f, 'return', T0)]);
    expect(new Set(a.map((x) => x.code)).size).toBe(1);
    expect(await db.select().from(t.preorder)).toHaveLength(1);
    expect(await db.select().from(t.inviteLink).where(eq(t.inviteLink.floor, '3F'))).toHaveLength(1);
    expect(await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_link'))).toHaveLength(1);
  });
  it('偽造通知不給票；模擬付款不給票；金額不符不給票並標紅', async () => {
    const r = await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    const no = r.fields.MerchantTradeNo;
    const fake = { ...gw(no, 3000), RtnMsg: 'x' };
    expect((await handleGatewayResult(db, fake, 'return', T0)).ok).toBe(false);
    expect((await handleGatewayResult(db, gw(no, 3000, { SimulatePaid: '1' }), 'return', T0)).code).toBeNull();
    expect((await handleGatewayResult(db, gw(no, 1), 'return', T0)).code).toBeNull();
    const [o] = await db.select().from(t.cardOrder);
    expect(o.status).toBe('pending');
    expect(o.flagged).toBe(true);
    expect(await db.select().from(t.preorder)).toHaveLength(0);
  });
  it('付款失敗放回名額', async () => {
    const r = await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 700 }] }, ORIGIN, T0);
    expect((await cardMenu(db, T0)).items.find((i) => i.kind === 'zone')!.left).toBe(24);
    await handleGatewayResult(db, gw(r.fields.MerchantTradeNo, 2100000, { RtnCode: '10100058' }), 'return', T0);
    expect((await cardMenu(db, T0)).items.find((i) => i.kind === 'zone')!.left).toBe(724);
  });
  it('不會超賣：付款中、已付未劃都先扣；賣完就停', async () => {
    await buy([{ kind: 'zone', id: singleZone, qty: 720 }]);
    expect((await cardMenu(db, T0)).items.find((i) => i.kind === 'zone')!.left).toBe(4);
    await createCardOrder(db, { ...buyer, phone: '0922222222', items: [{ kind: 'zone', id: singleZone, qty: 3 }] }, ORIGIN, T0);
    await expect(createCardOrder(db, { ...buyer, phone: '0933333333', items: [{ kind: 'zone', id: singleZone, qty: 2 }] }, ORIGIN, T0)).rejects.toThrow('只剩 1');
    // 同時搶最後一席：只有一筆成功
    const rs = await Promise.allSettled(['0944444444', '0955555555', '0966666666'].map((phone) => createCardOrder(db, { ...buyer, phone, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0)));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // 付款中逾時，名額放回
    const later = new Date(T0.getTime() + 31 * 60_000);
    expect((await floor3Stock(db, evId, later)).left[`zone:${singleZone}`]).toBe(4);
  });
  it('組合只算完整可賣的組：有一席被保留就不算', async () => {
    await frameComboGroup(db, 'admin', ELEVEN);
    const key = `combo:${comboId}`;
    expect((await floor3Stock(db, evId, T0)).left[key]).toBe(1);
    const hold = (await db.select().from(t.seatUsage).where(eq(t.seatUsage.code, 'closed')))[0];
    await A.setSeatUsage(db, 'admin', hold.id, [ELEVEN[0]]);
    expect((await floor3Stock(db, evId, T0)).left[key]).toBe(0);
    await expect(createCardOrder(db, { ...buyer, items: [{ kind: 'combo', id: comboId, qty: 1 }] }, ORIGIN, T0)).rejects.toThrow('只剩 0');
  });
  it('不限購：一次 25 席可以分次劃完', async () => {
    const { code } = await buy([{ kind: 'zone', id: singleZone, qty: 25 }]);
    const ids = buildSeats3F().filter((s) => s.rowNo === 13).map((s) => s.id).concat(buildSeats3F().filter((s) => s.rowNo === 14).map((s) => s.id)).slice(0, 25);
    await expect(holdSeats(db, code, ids, singleCombo, T0)).resolves.toBeTruthy();
    await expect(holdSeats(db, code, [...ids, '15-1'], singleCombo, T0)).rejects.toThrow('還可劃 25 席');
  });
});

describe('第三道保險：查詢綠界', () => {
  const answer = (status: string, amt: number, no = 'TN1'): CardPost => async (_u, p) => {
    const r: Record<string, string> = { MerchantID: p.MerchantID, MerchantTradeNo: p.MerchantTradeNo, TradeNo: no, TradeAmt: String(amt), TradeStatus: status };
    r.CheckMacValue = checkMac(r, ECPAY_PAY_TEST.hashKey, ECPAY_PAY_TEST.hashIV);
    return new URLSearchParams(r).toString();
  };
  const reset = () => { (globalThis as { __ticcCardGate?: unknown }).__ticcCardGate = undefined; };
  beforeEach(reset);
  it('沒收到通知也補得回來', async () => {
    await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    expect((await pollPending(db, new Date(T0.getTime() + 5 * 60_000), answer('1', 3000))).checked).toBe(0); // 未滿 10 分鐘先不查
    expect(await pollPending(db, new Date(T0.getTime() + 11 * 60_000), answer('1', 3000))).toEqual({ checked: 1, fixed: 1 });
    const [o] = await db.select().from(t.cardOrder);
    expect(o.status).toBe('paid');
    expect(o.paidVia).toBe('query');
    expect(await db.select().from(t.preorder)).toHaveLength(1);
  });
  it('綠界說沒付就關單；查不到結果的兩小時後逾時', async () => {
    await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    await pollPending(db, new Date(T0.getTime() + 11 * 60_000), answer('0', 3000));
    expect((await db.select().from(t.cardOrder))[0].status).toBe('pending');
    reset();
    await pollPending(db, new Date(T0.getTime() + 25 * 60_000), answer('10200095', 3000));
    expect((await db.select().from(t.cardOrder))[0].status).toBe('failed');
  });
  it('查詢回應被竄改時不採信', async () => {
    await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    const bad: CardPost = async (u, p) => (await answer('1', 3000)(u, p)).replace('TradeNo=TN1', 'TradeNo=HACK');
    await pollPending(db, new Date(T0.getTime() + 11 * 60_000), bad);
    expect((await db.select().from(t.cardOrder))[0].status).toBe('pending');
  });
  it('買方等待頁也能補單，後台可人工查詢補單', async () => {
    const a = await createCardOrder(db, { ...buyer, items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    const r = await cardStatus(db, a.token, new Date(T0.getTime() + 90_000), answer('1', 3000));
    expect(r.status).toBe('paid');
    expect(r.code).toBeTruthy();
    const b = await createCardOrder(db, { ...buyer, phone: '0922222222', items: [{ kind: 'zone', id: singleZone, qty: 1 }] }, ORIGIN, T0);
    const [o] = await db.select().from(t.cardOrder).where(eq(t.cardOrder.tradeNo, b.fields.MerchantTradeNo));
    expect((await adminQuery(db, 'admin', o.id, T0, answer('1', 3000))).fixed).toBe(true);
  });
});

describe('劃位與退票', () => {
  const einvOn = () => saveEinvConfig(db, 'admin', { enabled: '1', mode: 'mock', timing: 'review' }, '測試');
  async function seated(seats = ['13-1', '13-3']) {
    const b = await buy([{ kind: 'zone', id: singleZone, qty: seats.length }]);
    const h = await holdSeats(db, b.code, seats, singleCombo, T0);
    await submitOrder(db, b.code, { orderId: h.orderId, agree: true, buyer: { name: buyer.name, phone: buyer.phone, email: buyer.email }, holders: seats.map((seatId, i) => ({ seatId, name: `貴賓${i}`, id4: '' })) }, T0);
    return { ...b, orderId: h.orderId };
  }
  const myId = async () => (await db.select().from(t.cardOrder))[0].id;

  it('送出就成功：不用等後台確認，直接有 QR，座位已售', async () => {
    const { code, orderId } = await seated();
    const s = await getBookingState(db, code, T0);
    expect(s.orders[0].status).toBe('paid');
    expect(s.orders[0].seats[0].qr).toBeTruthy();
    expect((await db.select().from(t.eventSeat).where(eq(t.eventSeat.orderId, orderId))).every((x) => x.status === 'sold')).toBe(true);
    expect((await A.ticketData(db, [orderId])).tickets[0].entrance).toBe('3F 入口');
  });
  it('付款就開發票；已開立的不看開立時機設定', async () => {
    await einvOn();
    await buy([{ kind: 'zone', id: singleZone, qty: 1 }]);
    const [inv] = await db.select().from(t.invoice);
    expect(inv.status).toBe('issued');
    expect(inv.amount).toBe(3000);
  });
  it('退票：退 90%、座位釋出、舊 QR 失效、連結停用、發票作廢、名額回來', async () => {
    await einvOn();
    const { code, orderId } = await seated();
    const left = (await floor3Stock(db, evId, T0)).left[`zone:${singleZone}`];
    const r = await refundCardOrder(db, 'admin', await myId(), {}, T0);
    expect(r).toMatchObject({ refund: 5400, fee: 600, simulated: true, problems: [] });
    expect((await db.select().from(t.eventSeat).where(inArray(t.eventSeat.seatId, ['13-1', '13-3']))).every((x) => x.status === 'free' && x.orderId === null)).toBe(true);
    const [ord] = await db.select().from(t.orders).where(eq(t.orders.id, orderId));
    expect(ord.status).toBe('cancelled');
    expect(await findBySerial(db, `${ord.orderNo}-01`)).toBeNull();
    await expect(getBookingState(db, code, T0)).rejects.toThrow('停用');
    expect((await db.select().from(t.invoice))[0].status).toBe('void');
    expect((await floor3Stock(db, evId, T0)).left[`zone:${singleZone}`]).toBe(left + 2);
    await expect(refundCardOrder(db, 'admin', await myId(), {}, T0)).rejects.toThrow('已付款');
  });
  it('正式環境：依關帳狀態走刷退；綠界失敗時什麼都不動；連按只刷一次', async () => {
    const { orderId } = await seated();
    await db.update(t.cardOrder).set({ env: 'prod' });
    await saveCardKeys(db, 'admin', { merchantId: '1234567', hashKey: 'k'.repeat(16), hashIV: 'v'.repeat(16), mode: 'prod' });
    const calls: Record<string, string>[] = [];
    const fail: CardPost = async (_u, p) => { calls.push(p); return 'RtnCode=0&RtnMsg=餘額不足'; };
    await expect(refundCardOrder(db, 'admin', await myId(), {}, T0, fail)).rejects.toThrow('餘額不足');
    expect((await db.select().from(t.cardOrder))[0].status).toBe('paid');
    expect((await db.select().from(t.orders).where(eq(t.orders.id, orderId)))[0].status).toBe('paid');
    calls.length = 0;
    const ok: CardPost = async (_u, p) => { calls.push(p); return 'RtnCode=1&RtnMsg=OK'; };
    const rs = await Promise.allSettled([refundCardOrder(db, 'admin', await myId(), {}, T0, ok), refundCardOrder(db, 'admin', await myId(), {}, T0, ok)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ Action: 'R', TotalAmount: '5400' });
  });
  it('刷退動作對照綠界規則', () => {
    expect(refundActions('已關帳', true)).toEqual(['R']);
    expect(refundActions('已關帳', false)).toEqual(['R']);
    expect(refundActions('要關帳', true)).toEqual(['E', 'N']);
    expect(refundActions('要關帳', false)).toEqual(['R']);
    expect(refundActions('已授權', true)).toEqual(['N']);
    expect(typeof refundActions('已授權', false)).toBe('string');
    expect(refundActions(null, false)).toEqual(['R']);
  });
  it('20:15–20:30 不能刷退', async () => {
    await seated();
    await db.update(t.cardOrder).set({ env: 'prod' });
    await saveCardKeys(db, 'admin', { merchantId: '1234567', hashKey: 'k'.repeat(16), hashIV: 'v'.repeat(16), mode: 'prod' });
    await expect(refundCardOrder(db, 'admin', await myId(), {}, new Date('2026-11-10T20:20:00+08:00'))).rejects.toThrow('20:30');
  });
  it('退票期限：預設演出前 7 日（12/2），過期要主辦方同意；手續費上限 10%', async () => {
    expect(refundLastDay(SHOW, 7)).toBe('2026-12-02');
    expect(refundText({ open: true, saleStart: null, saleEnd: null, credit: true, refundOn: true, refundDays: 7, refundFeePct: 10 }, SHOW)).toContain('12/2');
    await seated();
    const late = new Date('2026-12-03T10:00:00+08:00');
    await expect(refundCardOrder(db, 'admin', await myId(), {}, late)).rejects.toThrow('超過退票期限');
    await expect(saveCardSettings(db, 'admin', { refundFeePct: 11 })).rejects.toThrow('10%');
    await expect(refundCardOrder(db, 'admin', await myId(), { late: true, fee: 0 }, late)).resolves.toMatchObject({ refund: 6000, fee: 0 });
  });
  it('已入場的不能退', async () => {
    const { orderId } = await seated();
    await db.insert(t.checkin).values({ eventId: evId, serial: 'x-01', orderId, seatId: '13-1' });
    await expect(refundCardOrder(db, 'admin', await myId(), {}, T0)).rejects.toThrow('入場');
  });
  it('清除測試資料：測試單會清掉；有正式刷卡單時擋下', async () => {
    await seated();
    await db.update(t.cardOrder).set({ env: 'prod' });
    await expect(resetSales(db, 'admin', {})).rejects.toThrow('三樓還有');
    await db.update(t.cardOrder).set({ env: 'test' });
    await resetSales(db, 'admin', {});
    expect(await db.select().from(t.cardOrder)).toHaveLength(0);
    expect((await db.select().from(t.eventSeat).where(eq(t.eventSeat.status, 'sold')))).toHaveLength(0);
  });
  it('後台三樓狀態：統計與清單', async () => {
    await seated();
    const f = (await floor3State(db, T0))!;
    expect(f.seats).toHaveLength(724);
    expect(f.stats).toMatchObject({ total: 724, sold: 2, orders: 1, revenue: 6000 });
    expect(f.orders[0].seats).toBe(2);
    expect(JSON.stringify(f.config)).not.toContain(ECPAY_PAY_TEST.hashKey);
  });
});

describe('備份', () => {
  it('舊備份（沒有樓層欄位）可以還原，重新補齊三樓後 2M 不變', async () => {
    const b = await exportAll(db);
    const strip = (rows: Record<string, unknown>[]) => rows.filter((r) => r.floor !== '3F').map(({ floor: _f, ...r }) => r);
    const old = { ...b, tables: { ...b.tables, venue_seat: strip(b.tables.venue_seat), price_zone: strip(b.tables.price_zone), combo: strip(b.tables.combo), invite_link: strip(b.tables.invite_link),
      event_seat: b.tables.event_seat.filter((r) => Number(String(r.seat_id).split('-')[0]) < 13 || Number.isNaN(Number(String(r.seat_id).split('-')[0]))), combo_item: [], card_order: [] } };
    await importAll(db, old);
    expect(await db.select().from(t.venueSeat).where(eq(t.venueSeat.floor, '3F'))).toHaveLength(0);
    await ensureFloor3(db);
    expect(await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, evId), inArray(t.eventSeat.seatId, ['13-1'])))).toHaveLength(1);
    expect(await db.select().from(t.venueSeat)).toHaveLength(buildSeats().length + 724);
  });
});
