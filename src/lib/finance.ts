/**
 * 財務帳號（role = finance）：只能處理「後台勾選的方案」的電子發票。
 * - 可開的方案存在 app_setting finance.combos（JSON 陣列）；沒設定過＝名稱含「尊榮」「感恩」的組合方案。
 * - 一張發票的訂單內容「全部」都是可開方案，財務才看得到、才能操作（含混別的方案或單張票的都不行）。
 */
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { currentEvent } from './admin';
import { listInvoices, publicEinvConfig } from './einvoice';
import { listPreorders } from './preorder';
import { listBank } from './bank';
import { salesOverview } from './sales';

const KEY = 'finance.combos';

export async function getFinanceCombos(db: Db): Promise<number[]> {
  const [s] = await db.select({ v: t.appSetting.value }).from(t.appSetting).where(eq(t.appSetting.key, KEY));
  if (s) { try { const a = JSON.parse(s.v); if (Array.isArray(a)) return a.filter((x) => Number.isInteger(x)); } catch { /* 壞掉當沒設定 */ } }
  const ev = await currentEvent(db);
  const cs = await db.select({ id: t.combo.id, name: t.combo.name }).from(t.combo).where(eq(t.combo.eventId, ev.id));
  return cs.filter((c) => /尊榮|感恩/.test(c.name)).map((c) => c.id);
}

export async function setFinanceCombos(db: Db, actor: string, ids: number[]) {
  const ev = await currentEvent(db);
  const cs = await db.select({ id: t.combo.id, name: t.combo.name }).from(t.combo).where(eq(t.combo.eventId, ev.id));
  const ok = [...new Set(ids)].filter((id) => cs.some((c) => c.id === id));
  await db.insert(t.appSetting).values({ key: KEY, value: JSON.stringify(ok) }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: JSON.stringify(ok) } });
  await db.insert(t.auditLog).values({ actor, action: 'finance_combos', target: `event:${ev.id}`, detail: cs.filter((c) => ok.includes(c.id)).map((c) => c.name).join('、') || '（全部不勾）' });
  return { ids: ok };
}

const itemsOk = (items: { kind: string; id: number }[] | null | undefined, allowed: number[]) =>
  !!items?.length && items.every((it) => it.kind === 'combo' && allowed.includes(it.id));

/** 這幾張發票財務都能操作嗎？不行就整批擋下 */
export async function assertFinanceInvoices(db: Db, ids: number[]) {
  const allowed = await getFinanceCombos(db);
  const rows = ids.length ? await db.select({ id: t.invoice.id, items: t.preorder.items }).from(t.invoice)
    .leftJoin(t.preorder, eq(t.preorder.id, t.invoice.preorderId)).where(inArray(t.invoice.id, ids)) : [];
  if (rows.length !== new Set(ids).size || rows.some((r) => !itemsOk(r.items, allowed))) {
    throw new BookingError('FORBIDDEN', '財務帳號只能處理後台開放的方案的發票');
  }
}

/** 這幾張訂單（認購單）財務都能對帳嗎？ */
export async function assertFinancePreorders(db: Db, ids: number[]) {
  const allowed = await getFinanceCombos(db);
  const rows = ids.length ? await db.select({ id: t.preorder.id, items: t.preorder.items }).from(t.preorder).where(inArray(t.preorder.id, ids)) : [];
  if (rows.length !== new Set(ids).size || rows.some((r) => !itemsOk(r.items, allowed))) {
    throw new BookingError('FORBIDDEN', '財務帳號只能處理後台開放的方案的訂單');
  }
}

/** 財務登入後看到的資料：可開方案的發票、訂單（對帳）、網銀入帳 */
export async function financeState(db: Db, user: { username: string; displayName: string; role: string }) {
  const allowed = await getFinanceCombos(db);
  const ev = await currentEvent(db);
  const pos = await db.select({ id: t.preorder.id, items: t.preorder.items }).from(t.preorder).where(eq(t.preorder.eventId, ev.id));
  const okPo = new Set(pos.filter((p) => itemsOk(p.items, allowed)).map((p) => p.id));
  const cs = await db.select({ id: t.combo.id, name: t.combo.name }).from(t.combo).where(eq(t.combo.eventId, ev.id));
  const e = await publicEinvConfig(db);
  const all = await listPreorders(db);
  return {
    finance: true as const, user, event: { name: ev.name, showAt: ev.showAt.toISOString() },
    einvoice: { enabled: e.enabled, mode: e.mode, timing: e.timing, taxType: e.taxType },
    combos: cs.filter((c) => allowed.includes(c.id)).map((c) => c.name),
    invoices: (await listInvoices(db)).filter((x) => x.preorderId !== null && okPo.has(x.preorderId)),
    preorders: all.filter((p) => okPo.has(p.id)).map((p) => ({ ...p, linkCode: null })), // 不給劃位連結代碼
    // 其他方案的訂單只給比對用的欄位（沒有姓名），讓網銀入帳能正確歸屬、不會誤列成「找不到訂單」
    others: all.filter((p) => !okPo.has(p.id)).map((p) => ({ id: p.id, no: p.no, amount: p.amount, last5: p.last5, paidAmount: p.paidAmount, paidOk: !!p.paidOkAt, status: p.status, waitlist: p.waitlist })),
    bank: await listBank(db),
    // 可售組數（與首頁「全場銷售總覽」2M 方案同一套計算），只列財務負責的方案
    plans: ((await salesOverview(db))?.twoM.plans ?? []).filter((p) => allowed.includes(p.id)),
    at: new Date().toISOString(),
  };
}
