/**
 * 電子發票（綠界 ECPay B2C）：劃位成功（後台按「確認劃位」）時自動開立，發票號碼一併寫進劃位成功 Email。
 *
 * - 每筆劃位開一張，金額＝劃位金額（組合票：套票價 × 組數；單張：各票種票價）。
 * - 開立方式（載具／捐贈／統編）由訂購人在預購單選；手動連結的劃位預設存入綠界會員載具（Email）。
 * - 開立失敗不影響劃位成功，後台標紅並可「重新開立」；刪除已開發票的劃位會先作廢發票。
 * - 設定（特店編號、HashKey、HashIV）在後台「八、通知設定」；HashKey/HashIV 只寫不讀。
 *   測試環境沒填時，使用綠界公開的測試特店（2000132）。
 *
 * 規格：https://developers.ecpay.com.tw/7896/（開立）、/7906/（作廢）、/7958/（加密）
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { invDesc } from './invoiceRules';

export const ECPAY_TEST = { merchantId: '2000132', hashKey: 'ejCk326UnaZWKisg', hashIV: 'q9jcZX8Ib9LM8wYk' };
const BASE = { test: 'https://einvoice-stage.ecpay.com.tw', prod: 'https://einvoice.ecpay.com.tw' };

/* ---------- 加解密：JSON → URL encode → AES-128-CBC（PKCS7）→ Base64 ---------- */

/** 與綠界相同的 URL encode：空白為 %20，!'()* 也編碼 */
export const ecpayUrlEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function ecpayEncrypt(obj: unknown, key: string, iv: string): string {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([c.update(ecpayUrlEncode(typeof obj === 'string' ? obj : JSON.stringify(obj)), 'utf8'), c.final()]).toString('base64');
}
export function ecpayDecrypt(data: string, key: string, iv: string): unknown {
  const d = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const plain = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(decodeURIComponent(plain.replace(/\+/g, '%20')));
}

/* ---------- 設定 ---------- */

const KEYS = ['einv.enabled', 'einv.env', 'einv.merchantId', 'einv.hashKey', 'einv.hashIV', 'einv.itemName'] as const;
type Key = (typeof KEYS)[number];
export interface EinvConfig { enabled: boolean; env: 'test' | 'prod'; merchantId: string; hashKey: string; hashIV: string; itemName: string }

async function readKeys(db: Db) {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [...KEYS]));
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Record<Key, string>>;
}

export async function getEinvConfig(db: Db): Promise<EinvConfig> {
  const s = await readKeys(db);
  const env = s['einv.env'] === 'prod' ? 'prod' : 'test';
  const own = { merchantId: s['einv.merchantId'] ?? '', hashKey: s['einv.hashKey'] ?? '', hashIV: s['einv.hashIV'] ?? '' };
  const cred = env === 'test' && !own.merchantId ? ECPAY_TEST : own;
  return { enabled: s['einv.enabled'] === '1', env, ...cred, itemName: s['einv.itemName'] || '入場券' };
}

/** 給後台畫面：不含 HashKey/HashIV */
export async function publicEinvConfig(db: Db) {
  const s = await readKeys(db);
  const c = await getEinvConfig(db);
  return {
    enabled: c.enabled, env: c.env, merchantId: s['einv.merchantId'] ?? '', itemName: s['einv.itemName'] ?? '',
    keySet: !!s['einv.hashKey'], ivSet: !!s['einv.hashIV'],
    ready: !!(c.merchantId && c.hashKey && c.hashIV), usingTestMerchant: c.env === 'test' && !s['einv.merchantId'],
  };
}

export async function saveEinvConfig(db: Db, actor: string, v: Partial<Record<'enabled' | 'env' | 'merchantId' | 'hashKey' | 'hashIV' | 'itemName', string>>) {
  if (v.env === 'prod' || (v.enabled === '1' && (await getEinvConfig(db)).env === 'prod')) {
    const cur = await readKeys(db);
    const mid = v.merchantId ?? cur['einv.merchantId'];
    const key = v.hashKey || cur['einv.hashKey'];
    const iv = v.hashIV || cur['einv.hashIV'];
    if (!mid || !key || !iv) throw new BookingError('INVALID', '正式環境請先填好綠界的特店編號、HashKey、HashIV');
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    if ((k === 'hashKey' || k === 'hashIV') && val === '') continue; // 留空＝不變更
    const value = val.trim();
    await db.insert(t.appSetting).values({ key: `einv.${k}`, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  }
  await db.insert(t.auditLog).values({
    actor, action: 'einvoice_settings', target: 'app_setting',
    detail: JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.startsWith('hash') ? (x ? '（已變更）' : '（未變更）') : x]))),
  });
}

/* ---------- 呼叫綠界 ---------- */

export type EinvPost = (url: string, body: unknown) => Promise<{ TransCode: number; TransMsg: string; Data: string }>;
const realPost: EinvPost = async (url, body) => {
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('連不到綠界（網路不通或逾時），請稍後按「重新開立」');
  }
  if (!r.ok) throw new Error(`綠界回應 HTTP ${r.status}`);
  return r.json();
};

async function call(cfg: EinvConfig, path: string, data: Record<string, unknown>, post: EinvPost) {
  const body = {
    MerchantID: cfg.merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: ecpayEncrypt({ MerchantID: cfg.merchantId, ...data }, cfg.hashKey, cfg.hashIV),
  };
  const res = await post(`${BASE[cfg.env]}${path}`, body);
  if (res.TransCode !== 1) throw new Error(`綠界傳輸失敗：${res.TransMsg || res.TransCode}`);
  return ecpayDecrypt(res.Data, cfg.hashKey, cfg.hashIV) as { RtnCode: number; RtnMsg: string; InvoiceNo?: string; InvoiceDate?: string; RandomNumber?: string };
}

/* ---------- 開立 ---------- */

/** 這筆劃位的發票內容：買受人（含載具）與品項 */
async function invoiceDraft(db: Db, orderId: number, itemName: string) {
  const [o] = await db.select().from(t.orders).where(eq(t.orders.id, orderId));
  if (!o) throw new BookingError('NOT_FOUND', '找不到此劃位');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, o.eventId));
  const [cb] = await db.select().from(t.combo).where(eq(t.combo.id, o.comboId));
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.linkId, o.linkId)).limit(1);
  const email = (o.buyerEmail || po?.email || '').trim();
  const phone = (o.buyerPhone || po?.phone || '').replace(/\D/g, '');
  const name = (o.buyerName || po?.name || '').trim();
  const type = po?.invType ?? 'member';
  const code = po?.invCode ?? '';
  const title = po?.invTitle ?? '';
  const label = `${ev.name} ${itemName}`.trim().slice(0, 200);

  let items: { name: string; count: number; word: string; price: number }[];
  if (cb && !cb.isSingle) {
    items = [{ name: `${label}（${cb.name}）`, count: o.sets, word: '組', price: cb.price }];
  } else {
    const seats = await db.select({ zone: t.priceZone.name, price: t.orderSeat.unitPrice }).from(t.orderSeat)
      .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, o.eventId)))
      .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
      .where(eq(t.orderSeat.orderId, orderId));
    const g = new Map<string, { name: string; count: number; word: string; price: number }>();
    for (const s of seats) {
      const k = `${s.zone}|${s.price}`;
      const cur = g.get(k) ?? { name: `${label}（${s.zone}）`, count: 0, word: '張', price: s.price };
      cur.count++; g.set(k, cur);
    }
    items = [...g.values()];
  }
  // 品項合計須等於發票金額（組合票單價分攤的餘數等狀況）：不符時合併為一項
  if (items.reduce((a, i) => a + i.count * i.price, 0) !== o.amount) items = [{ name: label, count: 1, word: '式', price: o.amount }];

  const base = {
    CustomerID: '', CustomerIdentifier: '', CustomerName: name.slice(0, 60), CustomerAddr: '', CustomerPhone: email ? '' : phone, CustomerEmail: email,
    ClearanceMark: '', Print: '0', Donation: '0', LoveCode: '', CarrierType: '', CarrierNum: '', CarrierNum2: '',
  };
  const buyer =
    type === 'mobile' ? { ...base, CarrierType: '3', CarrierNum: code }
    : type === 'cert' ? { ...base, CarrierType: '2', CarrierNum: code }
    : type === 'donate' ? { ...base, Donation: '1', LoveCode: code }
    : type === 'company' ? { ...base, CustomerIdentifier: code, CustomerName: title.slice(0, 60), CarrierType: '1' }
    : { ...base, CarrierType: '1' };
  return { o, buyer, items, desc: invDesc(type, code, title, email) };
}

/**
 * 劃位成功時開立發票。未啟用回傳 null；已開立過直接回傳原發票（不重複開）。
 * 失敗不丟錯：記為 failed，後台可重新開立。
 */
export async function issueForOrder(db: Db, orderId: number, post: EinvPost = realPost) {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled) return null;
  const prev = await db.select().from(t.invoice).where(eq(t.invoice.orderId, orderId)).orderBy(desc(t.invoice.id));
  const done = prev.find((x) => x.status === 'issued');
  if (done) return done;
  const { o, buyer, items, desc: buyerDesc } = await invoiceDraft(db, orderId, cfg.itemName);
  if (o.status !== 'paid') throw new BookingError('INVALID', '劃位成功後才能開立發票');
  const relateNumber = `${(o.orderNo ?? `O${o.id}`).replace(/[^A-Za-z0-9]/g, '')}N${prev.length + 1}`;
  const data = {
    RelateNumber: relateNumber, ...buyer,
    TaxType: '1', SalesAmount: o.amount, InvoiceRemark: `劃位編號 ${o.orderNo}`, InvType: '07', vat: '1',
    Items: items.map((i, k) => ({ ItemSeq: k + 1, ItemName: i.name, ItemCount: i.count, ItemWord: i.word, ItemPrice: i.price, ItemTaxType: '1', ItemAmount: i.count * i.price, ItemRemark: '' })),
  };
  const row = { orderId, orderNo: o.orderNo ?? '', env: cfg.env, relateNumber, amount: o.amount, buyer: buyerDesc };
  try {
    const r = await call(cfg, '/B2CInvoice/Issue', data, post);
    if (r.RtnCode !== 1 || !r.InvoiceNo) throw new Error(`綠界：${r.RtnMsg || `錯誤代碼 ${r.RtnCode}`}`);
    const [inv] = await db.insert(t.invoice).values({ ...row, status: 'issued', invoiceNo: r.InvoiceNo, invoiceDate: r.InvoiceDate ?? '', randomNumber: r.RandomNumber ?? '' }).returning();
    return inv;
  } catch (e) {
    const [inv] = await db.insert(t.invoice).values({ ...row, status: 'failed', error: String((e as Error).message ?? e).slice(0, 300) }).returning();
    return inv;
  }
}

/** 作廢這筆劃位已開立的發票（刪除劃位前）。沒有發票回傳 null；作廢失敗丟錯 */
export async function voidForOrder(db: Db, orderId: number, reason: string, post: EinvPost = realPost) {
  const [inv] = await db.select().from(t.invoice).where(and(eq(t.invoice.orderId, orderId), eq(t.invoice.status, 'issued')));
  if (!inv) return null;
  const cfg = await getEinvConfig(db);
  if (inv.env !== cfg.env) throw new BookingError('EINVOICE', `這張發票是在${inv.env === 'prod' ? '正式' : '測試'}環境開立的，請先把發票設定切回該環境再作廢。`);
  const r = await call(cfg, '/B2CInvoice/Invalid', { InvoiceNo: inv.invoiceNo, InvoiceDate: inv.invoiceDate.slice(0, 10), Reason: reason.slice(0, 20) || '取消劃位' }, post);
  if (r.RtnCode !== 1) throw new BookingError('EINVOICE', `發票 ${inv.invoiceNo} 作廢失敗（綠界：${r.RtnMsg}），劃位沒有刪除。`);
  const [v] = await db.update(t.invoice).set({ status: 'void', voidedAt: new Date(), voidReason: reason }).where(eq(t.invoice.id, inv.id)).returning();
  return v;
}

/** 某些劃位的最新發票（顯示用） */
export async function invoicesOf(db: Db, orderIds: number[]) {
  if (!orderIds.length) return new Map<number, typeof t.invoice.$inferSelect>();
  const rows = await db.select().from(t.invoice).where(inArray(t.invoice.orderId, orderIds)).orderBy(t.invoice.id);
  const m = new Map<number, typeof t.invoice.$inferSelect>();
  for (const r of rows) {
    const cur = m.get(r.orderId!);
    if (!cur || cur.status !== 'issued') m.set(r.orderId!, r); // 已開立的優先，否則取最新一筆
  }
  return m;
}
