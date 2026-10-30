/**
 * 電子發票（綠界 ECPay B2C）：一筆訂單（收款）開一張。
 *
 * 流程：後台在「四、訂單」按「確認收訖」→ 建立一張「待開」發票，電腦自動核對
 *   （匯款金額、統編與抬頭、手機條碼、愛心碼）→
 *   - 開立時機「即開」且沒有異常：立刻開立；
 *   - 開立時機「核對後開」或有異常：留在「十、電子發票」待開清單，人工勾選後開立。
 *
 * 三種模式：模擬（不連綠界，開出 TS 開頭的假號碼）／綠界測試環境（綠界公開的測試特店）／正式（公司特店）。
 * 個人發票送綠界的買受人名稱一律為「貴賓」，公司發票送抬頭；系統內保留真實訂單資料。
 * 修改模式、開立時機、課稅別要填「依誰指示」，記在操作紀錄。
 *
 * 規格：https://developers.ecpay.com.tw/7896/（開立）、/7906/（作廢）、/7958/（加密）、
 *       /32089/（統編）、/7886/（手機條碼）、/7891/（愛心碼）
 */
import { createCipheriv, createDecipheriv, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { invDesc } from './invoiceRules';

export const ECPAY_TEST = { merchantId: '2000132', hashKey: 'ejCk326UnaZWKisg', hashIV: 'q9jcZX8Ib9LM8wYk' };
const BASE = { test: 'https://einvoice-stage.ecpay.com.tw', prod: 'https://einvoice.ecpay.com.tw' };
export type EinvMode = 'mock' | 'test' | 'prod';
export const MODE_NAME: Record<EinvMode, string> = { mock: '模擬', test: '綠界測試環境', prod: '正式' };
export const TIMING_NAME = { auto: '即開', review: '核對後開' } as const;
export const TAX_NAME: Record<string, string> = { '1': '應稅', '3': '免稅' };

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

const KEYS = ['einv.enabled', 'einv.mode', 'einv.env', 'einv.timing', 'einv.merchantId', 'einv.hashKey', 'einv.hashIV'] as const;
type Key = (typeof KEYS)[number];
export interface EinvConfig { enabled: boolean; mode: EinvMode; timing: 'auto' | 'review'; merchantId: string; hashKey: string; hashIV: string }

async function readKeys(db: Db) {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [...KEYS]));
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Record<Key, string>>;
}

export async function getEinvConfig(db: Db): Promise<EinvConfig> {
  const s = await readKeys(db);
  const m = s['einv.mode'] ?? (s['einv.env'] === 'prod' ? 'prod' : s['einv.env'] ? 'test' : 'mock');
  const mode: EinvMode = m === 'prod' || m === 'test' ? m : 'mock';
  const cred = mode === 'prod' ? { merchantId: s['einv.merchantId'] ?? '', hashKey: s['einv.hashKey'] ?? '', hashIV: s['einv.hashIV'] ?? '' }
    : mode === 'test' ? ECPAY_TEST : { merchantId: '', hashKey: '', hashIV: '' };
  return { enabled: s['einv.enabled'] === '1', mode, timing: s['einv.timing'] === 'auto' ? 'auto' : 'review', ...cred };
}

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 給後台畫面：不含 HashKey/HashIV；附最近的修改紀錄 */
export async function publicEinvConfig(db: Db) {
  const s = await readKeys(db);
  const c = await getEinvConfig(db);
  const ev = await currentEvent(db);
  const log = await db.select().from(t.auditLog).where(eq(t.auditLog.action, 'einvoice_settings')).orderBy(desc(t.auditLog.id)).limit(10);
  return {
    enabled: c.enabled, mode: c.mode, timing: c.timing, merchantId: s['einv.merchantId'] ?? '',
    keySet: !!s['einv.hashKey'], ivSet: !!s['einv.hashIV'], taxType: ev.invTaxType, itemName: ev.invItemName,
    log: log.map((l) => ({ at: l.at.toISOString(), actor: l.actor, detail: l.detail ?? '' })),
  };
}

type EinvInput = Partial<{ enabled: '0' | '1'; mode: EinvMode; timing: 'auto' | 'review'; merchantId: string; hashKey: string; hashIV: string; taxType: '1' | '3'; itemName: string }>;

/** 儲存設定。啟用／停用、模式、開立時機、課稅別有變更時，必須填「依誰指示」 */
export async function saveEinvConfig(db: Db, actor: string, v: EinvInput, reason = '') {
  const cur = await getEinvConfig(db);
  const s = await readKeys(db);
  const ev = await currentEvent(db);
  const changes: string[] = [];
  if (v.enabled !== undefined && (v.enabled === '1') !== cur.enabled) changes.push(v.enabled === '1' ? '啟用電子發票' : '停用電子發票');
  if (v.mode && v.mode !== cur.mode) changes.push(`模式：${MODE_NAME[cur.mode]} → ${MODE_NAME[v.mode]}`);
  if (v.timing && v.timing !== cur.timing) changes.push(`開立時機：${TIMING_NAME[cur.timing]} → ${TIMING_NAME[v.timing]}`);
  if (v.taxType && v.taxType !== ev.invTaxType) changes.push(`課稅別：${TAX_NAME[ev.invTaxType]} → ${TAX_NAME[v.taxType]}`);
  if (changes.length && !reason.trim()) throw new BookingError('INVALID', `請填寫「依誰指示」（${changes.join('、')}）`);

  const mode = v.mode ?? cur.mode;
  const enabled = v.enabled ? v.enabled === '1' : cur.enabled;
  if (mode === 'prod' && enabled) {
    const mid = v.merchantId ?? s['einv.merchantId'];
    if (!mid || !(v.hashKey || s['einv.hashKey']) || !(v.hashIV || s['einv.hashIV'])) throw new BookingError('INVALID', '正式模式請先填好綠界的特店編號、HashKey、HashIV');
  }
  const put = async (k: string, value: string) => {
    await db.insert(t.appSetting).values({ key: k, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  };
  if (v.enabled !== undefined) await put('einv.enabled', v.enabled);
  if (v.mode) await put('einv.mode', v.mode);
  if (v.timing) await put('einv.timing', v.timing);
  if (v.merchantId !== undefined) await put('einv.merchantId', v.merchantId.trim());
  if (v.hashKey) await put('einv.hashKey', v.hashKey.trim()); // 留空＝不變更
  if (v.hashIV) await put('einv.hashIV', v.hashIV.trim());
  if (v.taxType || v.itemName !== undefined) {
    await db.update(t.event).set({ ...(v.taxType ? { invTaxType: v.taxType } : {}), ...(v.itemName !== undefined ? { invItemName: v.itemName.trim() || '入場券' } : {}) }).where(eq(t.event.id, ev.id));
  }
  const other = [v.merchantId !== undefined && v.merchantId !== (s['einv.merchantId'] ?? '') ? '特店編號' : '', v.hashKey ? 'HashKey' : '', v.hashIV ? 'HashIV' : '',
    v.itemName !== undefined && v.itemName.trim() !== ev.invItemName ? `品名「${v.itemName.trim()}」` : ''].filter(Boolean);
  if (changes.length || other.length) {
    const detail = [...changes, ...(other.length ? [`修改${other.join('、')}`] : [])].join('；') + (reason.trim() ? `｜依 ${reason.trim()} 指示` : '');
    await db.insert(t.auditLog).values({ actor, action: 'einvoice_settings', target: 'app_setting', detail });
  }
}

/* ---------- 呼叫綠界（模擬模式不連線） ---------- */

export type EinvPost = (url: string, body: unknown) => Promise<{ TransCode: number; TransMsg: string; Data: string }>;
const realPost: EinvPost = async (url, body) => {
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('連不到綠界（網路不通或逾時），請稍後再試');
  }
  if (!r.ok) throw new Error(`綠界回應 HTTP ${r.status}`);
  return r.json();
};

type EcpayReply = { RtnCode: number; RtnMsg: string; InvoiceNo?: string; InvoiceDate?: string; RandomNumber?: string; IsExist?: string; CompanyName?: string; OrganName?: string };

async function mockReply(db: Db, path: string): Promise<EcpayReply> {
  if (path === '/B2CInvoice/Issue') {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.invoice).where(and(eq(t.invoice.env, 'mock'), sql`${t.invoice.invoiceNo} <> ''`));
    const d = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
    return { RtnCode: 1, RtnMsg: '模擬開立成功', InvoiceNo: `TS${String(n + 1).padStart(8, '0')}`, InvoiceDate: d, RandomNumber: String(randomInt(10000)).padStart(4, '0') };
  }
  if (path === '/B2CInvoice/GetCompanyNameByTaxID') return { RtnCode: 7, RtnMsg: '模擬模式不查詢公司名稱' };
  if (path === '/B2CInvoice/CheckLoveCode') return { RtnCode: 1, RtnMsg: '模擬', IsExist: 'Y', OrganName: '（模擬）受贈單位' };
  return { RtnCode: 1, RtnMsg: '模擬成功', IsExist: 'Y' };
}

async function call(db: Db, cfg: EinvConfig, path: string, data: Record<string, unknown>, post: EinvPost): Promise<EcpayReply> {
  if (cfg.mode === 'mock') return mockReply(db, path);
  const body = {
    MerchantID: cfg.merchantId,
    RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
    Data: ecpayEncrypt({ MerchantID: cfg.merchantId, ...data }, cfg.hashKey, cfg.hashIV),
  };
  const res = await post(`${BASE[cfg.mode]}${path}`, body);
  if (res.TransCode !== 1) throw new Error(`綠界傳輸失敗：${res.TransMsg || res.TransCode}`);
  return ecpayDecrypt(res.Data, cfg.hashKey, cfg.hashIV) as EcpayReply;
}

/* ---------- 向綠界確認統編、手機條碼、愛心碼 ---------- */

const normName = (s: string) => s.replace(/\s|　/g, '').replace(/臺/g, '台').replace(/[()（）]/g, '');

/**
 * block：確定是錯的（預購單送出時直接擋下，請訂購人改正）
 * flags：無法確認或需要人看的（不擋送出，但發票不會自動開）
 */
export async function verifyBuyer(db: Db, type: string, code: string, title: string, post: EinvPost = realPost): Promise<{ block: string | null; flags: string[] }> {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled || !['mobile', 'donate', 'company'].includes(type)) return { block: null, flags: [] };
  try {
    if (type === 'mobile') {
      const r = await call(db, cfg, '/B2CInvoice/CheckBarcode', { BarCode: code }, post);
      if (r.RtnCode === 1 && r.IsExist === 'N') return { block: `手機條碼 ${code} 不存在，請確認後再輸入`, flags: [] };
      return { block: null, flags: r.RtnCode === 1 ? [] : [`未能向財政部確認手機條碼（${r.RtnMsg}）`] };
    }
    if (type === 'donate') {
      const r = await call(db, cfg, '/B2CInvoice/CheckLoveCode', { LoveCode: code }, post);
      if (r.RtnCode === 1 && r.IsExist === 'N') return { block: `愛心碼 ${code} 不存在，請確認受贈單位的愛心碼`, flags: [] };
      return { block: null, flags: r.RtnCode === 1 ? [] : [`未能向財政部確認愛心碼（${r.RtnMsg}）`] };
    }
    const r = await call(db, cfg, '/B2CInvoice/GetCompanyNameByTaxID', { UnifiedBusinessNo: code }, post);
    if (r.RtnCode === 1200125 || r.RtnCode === 2027000) return { block: `統一編號 ${code} 不正確`, flags: [] };
    if (r.RtnCode === 1 && r.CompanyName && normName(r.CompanyName) !== normName(title)) return { block: null, flags: [`抬頭「${title}」與財政部登記的「${r.CompanyName}」不同`] };
    if (r.RtnCode === 1) return { block: null, flags: [] };
    return { block: null, flags: [cfg.mode === 'mock' ? '模擬模式：未查詢統編登記名稱，請人工確認抬頭' : `查不到統編 ${code} 的登記名稱，請人工確認抬頭`] };
  } catch (e) {
    return { block: null, flags: [`未能向綠界確認發票資料（${String((e as Error).message ?? e).slice(0, 60)}）`] };
  }
}

/** 電腦核對：金額＋發票對象 */
async function checksFor(db: Db, po: typeof t.preorder.$inferSelect, post: EinvPost) {
  const flags: string[] = [];
  if (po.paidAmount !== po.amount) flags.push(`匯款金額 NT$${po.paidAmount.toLocaleString('en-US')} 與訂單合計 NT$${po.amount.toLocaleString('en-US')} 不同`);
  const v = await verifyBuyer(db, po.invType, po.invCode, po.invTitle, post);
  return [...flags, ...(v.block ? [v.block] : []), ...v.flags];
}

/* ---------- 發票：建立、開立、作廢 ---------- */

/** 確認收訖時呼叫：建立待開發票並核對；「即開」且沒有異常就立刻開立 */
export async function createForPreorder(db: Db, preorderId: number, actor: string, post: EinvPost = realPost) {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled) return null;
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.id, preorderId));
  if (!po || po.status !== 'confirmed' || po.amount <= 0) return null;
  const prev = await db.select().from(t.invoice).where(and(eq(t.invoice.preorderId, preorderId), sql`${t.invoice.status} <> 'void'`));
  if (prev.length) return prev[0];
  const checks = await checksFor(db, po, post);
  const [inv] = await db.insert(t.invoice).values({
    preorderId, orderNo: po.no, env: cfg.mode, relateNumber: '', status: 'pending', amount: po.amount,
    buyer: invDesc(po.invType, po.invCode, po.invTitle, po.email), checks,
  }).returning();
  if (cfg.timing === 'auto' && !checks.length) return issueInvoice(db, inv.id, actor, false, post);
  return inv;
}

/** 開立一張待開（或開立失敗）的發票。有異常時要 force（人工確認過）才開 */
export async function issueInvoice(db: Db, invoiceId: number, actor: string, force = false, post: EinvPost = realPost) {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled) throw new BookingError('INVALID', '尚未啟用電子發票');
  const [inv] = await db.select().from(t.invoice).where(eq(t.invoice.id, invoiceId));
  if (!inv) throw new BookingError('NOT_FOUND', '找不到這張發票');
  if (inv.status === 'issued') return inv;
  if (inv.status === 'void') throw new BookingError('INVALID', '這張發票已作廢');
  if (inv.checks.length && !force) throw new BookingError('CHECK', `${inv.orderNo} 有異常尚未確認：${inv.checks.join('；')}`);
  const [po] = inv.preorderId ? await db.select().from(t.preorder).where(eq(t.preorder.id, inv.preorderId)) : [];
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張發票的訂單');
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, po.eventId));

  // 品項：依訂單內容；組合票含贈票時註明
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const comboItems = await db.select().from(t.comboItem);
  const label = `${ev.name} ${ev.invItemName}`.trim();
  const items = po.items.map((it, k) => {
    const gift = it.kind === 'combo'
      ? comboItems.filter((c) => c.comboId === it.id && (zones.find((z) => z.id === c.zoneId)?.price ?? 1) === 0).reduce((a, c) => a + c.qty, 0) : 0;
    return {
      ItemSeq: k + 1, ItemName: `${label}（${it.name}）`.slice(0, 500), ItemCount: it.qty, ItemWord: it.kind === 'combo' ? '組' : '張',
      ItemPrice: it.price, ItemTaxType: ev.invTaxType, ItemAmount: it.price * it.qty, ItemRemark: gift ? `每組含贈票 ${gift} 張` : '',
    };
  });
  if (items.reduce((a, i) => a + i.ItemAmount, 0) !== inv.amount) throw new BookingError('CHECK', `${inv.orderNo} 品項合計與發票金額不符，請聯絡網管`);

  const company = po.invType === 'company';
  const relateNumber = `${po.no}${Date.now().toString(36).toUpperCase()}`;
  const data = {
    RelateNumber: relateNumber, CustomerID: '', CustomerIdentifier: company ? po.invCode : '',
    CustomerName: company ? po.invTitle.slice(0, 60) : '貴賓', // 個人發票一律「貴賓」；系統內保留真實資料
    CustomerAddr: '', CustomerPhone: '', CustomerEmail: po.email, ClearanceMark: '', Print: '0',
    Donation: po.invType === 'donate' ? '1' : '0', LoveCode: po.invType === 'donate' ? po.invCode : '',
    CarrierType: po.invType === 'mobile' ? '3' : po.invType === 'cert' ? '2' : po.invType === 'donate' ? '' : '1',
    CarrierNum: po.invType === 'mobile' || po.invType === 'cert' ? po.invCode : '', CarrierNum2: '',
    TaxType: ev.invTaxType, ...(ev.invTaxType === '3' ? { SpecialTaxType: 8 } : {}),
    SalesAmount: inv.amount, InvoiceRemark: `訂單 ${po.no}`, InvType: '07', vat: '1', Items: items,
  };
  const base = { relateNumber, env: cfg.mode, buyer: invDesc(po.invType, po.invCode, po.invTitle, po.email), issuedBy: actor };
  try {
    const r = await call(db, cfg, '/B2CInvoice/Issue', data, post);
    if (r.RtnCode !== 1 || !r.InvoiceNo) throw new Error(`綠界：${r.RtnMsg || `錯誤代碼 ${r.RtnCode}`}`);
    const [done] = await db.update(t.invoice).set({ ...base, status: 'issued', invoiceNo: r.InvoiceNo, invoiceDate: r.InvoiceDate ?? '', randomNumber: r.RandomNumber ?? '', error: null, createdAt: new Date() })
      .where(eq(t.invoice.id, invoiceId)).returning();
    await db.insert(t.auditLog).values({ actor, action: 'invoice_issue', target: `invoice:${invoiceId}`, detail: JSON.stringify({ no: r.InvoiceNo, order: po.no, force }) });
    return done;
  } catch (e) {
    const [bad] = await db.update(t.invoice).set({ ...base, status: 'failed', error: String((e as Error).message ?? e).slice(0, 300) }).where(eq(t.invoice.id, invoiceId)).returning();
    return bad;
  }
}

/** 批次開立：逐張開，回傳每張結果 */
export async function issueBatch(db: Db, ids: number[], actor: string, force = false, post: EinvPost = realPost) {
  const out: { id: number; orderNo: string; status: string; invoiceNo: string; error: string | null }[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      const r = await issueInvoice(db, id, actor, force, post);
      out.push({ id, orderNo: r.orderNo, status: r.status, invoiceNo: r.invoiceNo, error: r.error });
    } catch (e) {
      out.push({ id, orderNo: '', status: 'skipped', invoiceNo: '', error: String((e as Error).message ?? e) });
    }
  }
  return out;
}

/** 修改待開發票的對象（例：抬頭打錯），並重新核對 */
export async function editInvoiceBuyer(db: Db, invoiceId: number, actor: string, v: { invType: string; invCode: string; invTitle: string }, post: EinvPost = realPost) {
  const { invProblem } = await import('./invoiceRules');
  const [inv] = await db.select().from(t.invoice).where(eq(t.invoice.id, invoiceId));
  if (!inv || !inv.preorderId) throw new BookingError('NOT_FOUND', '找不到這張發票');
  if (inv.status !== 'pending' && inv.status !== 'failed') throw new BookingError('INVALID', '已開立或作廢的發票不能修改');
  const code = v.invType === 'member' ? '' : v.invCode.trim().toUpperCase();
  const title = v.invType === 'company' ? v.invTitle.trim() : '';
  const p = invProblem(v.invType, code, title);
  if (p) throw new BookingError('INVALID', p);
  const [po] = await db.update(t.preorder).set({ invType: v.invType, invCode: code, invTitle: title }).where(eq(t.preorder.id, inv.preorderId)).returning();
  return recheckInvoice(db, invoiceId, actor, post, `修改發票對象為 ${invDesc(po.invType, po.invCode, po.invTitle, po.email)}`);
}

/** 重新核對（例：網路恢復後、人工確認過資料） */
export async function recheckInvoice(db: Db, invoiceId: number, actor: string, post: EinvPost = realPost, note = '重新核對') {
  const [inv] = await db.select().from(t.invoice).where(eq(t.invoice.id, invoiceId));
  if (!inv || !inv.preorderId) throw new BookingError('NOT_FOUND', '找不到這張發票');
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.id, inv.preorderId));
  const checks = await checksFor(db, po, post);
  const [r] = await db.update(t.invoice).set({ checks, buyer: invDesc(po.invType, po.invCode, po.invTitle, po.email) }).where(eq(t.invoice.id, invoiceId)).returning();
  await db.insert(t.auditLog).values({ actor, action: 'invoice_recheck', target: `invoice:${invoiceId}`, detail: `${note}；${checks.length ? checks.join('；') : '無異常'}` });
  return r;
}

/** 作廢已開立的發票；reopen 時同時建立一張新的待開發票（作廢重開） */
export async function voidInvoice(db: Db, invoiceId: number, actor: string, reason: string, reopen = false, post: EinvPost = realPost) {
  if (!reason.trim()) throw new BookingError('INVALID', '請填寫作廢原因');
  const [inv] = await db.select().from(t.invoice).where(eq(t.invoice.id, invoiceId));
  if (!inv || inv.status !== 'issued') throw new BookingError('INVALID', '只有已開立的發票可以作廢');
  const cfg = await getEinvConfig(db);
  if (inv.env !== cfg.mode) throw new BookingError('EINVOICE', `這張發票是在「${MODE_NAME[inv.env as EinvMode] ?? inv.env}」模式開立的，請先切回該模式再作廢。`);
  const r = await call(db, cfg, '/B2CInvoice/Invalid', { InvoiceNo: inv.invoiceNo, InvoiceDate: inv.invoiceDate.slice(0, 10), Reason: reason.trim().slice(0, 20) }, post);
  if (r.RtnCode !== 1) throw new BookingError('EINVOICE', `發票 ${inv.invoiceNo} 作廢失敗（綠界：${r.RtnMsg}）`);
  const [v] = await db.update(t.invoice).set({ status: 'void', voidedAt: new Date(), voidReason: reason.trim() }).where(eq(t.invoice.id, invoiceId)).returning();
  await db.insert(t.auditLog).values({ actor, action: 'invoice_void', target: `invoice:${invoiceId}`, detail: `${inv.invoiceNo}：${reason.trim()}` });
  if (reopen && inv.preorderId) await createForPreorder(db, inv.preorderId, actor, post);
  return v;
}

/** 後台清單：發票＋訂單的真實資料 */
export async function listInvoices(db: Db) {
  const rows = await db.select({ inv: t.invoice, po: t.preorder }).from(t.invoice).leftJoin(t.preorder, eq(t.preorder.id, t.invoice.preorderId)).orderBy(desc(t.invoice.id));
  return rows.map(({ inv, po }) => ({
    id: inv.id, orderNo: inv.orderNo, status: inv.status, env: inv.env, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, randomNumber: inv.randomNumber,
    amount: inv.amount, buyer: inv.buyer, checks: inv.checks, error: inv.error, issuedBy: inv.issuedBy, voidReason: inv.voidReason,
    name: po?.name ?? '', phone: po?.phone ?? '', email: po?.email ?? '', paidAmount: po?.paidAmount ?? null,
    invType: po?.invType ?? 'member', invCode: po?.invCode ?? '', invTitle: po?.invTitle ?? '', preorderId: inv.preorderId,
    confirmedAt: po?.confirmedAt?.toISOString() ?? null,
  }));
}

/** 啟用電子發票前就確認收訖的訂單：補建待開發票（不會重複建立） */
export async function backfillInvoices(db: Db, actor: string, post: EinvPost = realPost) {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled) throw new BookingError('INVALID', '請先啟用電子發票');
  const pos = await db.select({ id: t.preorder.id }).from(t.preorder)
    .where(and(eq(t.preorder.status, 'confirmed'), sql`${t.preorder.amount} > 0`,
      sql`not exists (select 1 from ${t.invoice} where ${t.invoice.preorderId} = ${t.preorder.id} and ${t.invoice.status} <> 'void')`));
  let n = 0;
  for (const p of pos) { if (await createForPreorder(db, p.id, actor, post)) n++; }
  return { created: n };
}

/** 劃位成功信、購票頁用：只有「即開」時才顯示這筆訂單的發票 */
export async function invoiceForLink(db: Db, linkId: number) {
  const cfg = await getEinvConfig(db);
  if (!cfg.enabled || cfg.timing !== 'auto') return null;
  const [po] = await db.select({ id: t.preorder.id }).from(t.preorder).where(eq(t.preorder.linkId, linkId)).limit(1);
  if (!po) return null;
  const [inv] = await db.select().from(t.invoice).where(and(eq(t.invoice.preorderId, po.id), eq(t.invoice.status, 'issued')));
  return inv ?? null;
}
