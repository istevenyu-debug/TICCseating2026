/**
 * 買方核對（11/20）：把全部方案的買方分成 二聯（個人）／三聯（有統編）／招待，給系統管理員、會計核對資料是否有誤。
 * 只讀不寫：不改發票、不寄信。唯一可存的是「我們自己的信箱」清單（系統管理員）。
 * 可能有誤的提示：
 * - Email 是我們自己的信箱（測試或代收時改成自己的，忘了改回）：寄件 Gmail 帳號＋後台填的清單
 * - 同一個 Email 用在不同姓名的買方
 * - 二聯但名稱像公司／團體（可能漏打統編）
 * - 三聯：統編格式、檢查碼不對，沒有抬頭，同一統編不同抬頭
 * - Email 空白或格式不對
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { currentEvent } from './admin';
import { BookingError } from './booking';
import { invDesc, ubnValid } from './invoiceRules';

const KEY = 'check.internalEmails';

export type BuyerKind = 'b2c' | 'b2b' | 'vip';
export interface BuyerRow {
  key: string; kind: BuyerKind; no: string; plans: string; amount: number | null; status: string;
  name: string; phone: string; email: string; qrEmails: string[];
  ubn: string; title: string; carrier: string;
  invoice: { status: string; invoiceNo: string } | null;
  flags: string[];
}

const normEmail = (s: string) => s.trim().toLowerCase();
const normName = (s: string) => s.replace(/\s+/g, '');
const ORG = /公司|有限|股份|協會|基金會|學會|工會|商會|商行|企業|事務所|診所|醫院|學校|社團|法人|中心|工作室|行號/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function getInternalEmails(db: Db): Promise<{ list: string[]; sender: string }> {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [KEY, 'email.user']));
  const v = (k: string) => rows.find((r) => r.key === k)?.value ?? '';
  return { list: v(KEY).split(/[\s,;，、]+/).map(normEmail).filter(Boolean), sender: normEmail(v('email.user')) };
}

export async function setInternalEmails(db: Db, actor: string, text: string) {
  const list = [...new Set(text.split(/[\s,;，、]+/).map(normEmail).filter(Boolean))];
  const bad = list.filter((e) => !EMAIL_OK.test(e));
  if (bad.length) throw new BookingError('INVALID', `Email 格式不對：${bad.join('、')}`);
  if (list.length > 50) throw new BookingError('INVALID', '最多 50 個');
  await db.insert(t.appSetting).values({ key: KEY, value: list.join('\n') }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: list.join('\n') } });
  await db.insert(t.auditLog).values({ actor, action: 'check_internal_emails', target: 'setting', detail: list.join('、') || '（清空）' });
  return { list };
}

const PRE_STATUS: Record<string, string> = { submitted: '待確認', confirmed: '已收訖' };

export async function buyerCheck(db: Db) {
  const ev = await currentEvent(db);
  const { list, sender } = await getInternalEmails(db);
  const internal = new Set([...list, ...(sender ? [sender] : [])]);

  const pos = await db.select().from(t.preorder).where(and(eq(t.preorder.eventId, ev.id), ne(t.preorder.status, 'cancelled')));
  const linkIds = pos.map((p) => p.linkId).filter((x): x is number => !!x);
  const os = linkIds.length ? await db.select({ linkId: t.orders.linkId, email: t.orders.buyerEmail, status: t.orders.status }).from(t.orders).where(inArray(t.orders.linkId, linkIds)) : [];
  const invs = pos.length ? await db.select().from(t.invoice).where(inArray(t.invoice.preorderId, pos.map((p) => p.id))).orderBy(t.invoice.id) : [];
  const vips = await db.select().from(t.orders).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.vip, true), ne(t.orders.status, 'cancelled')));
  const vipSeats = vips.length ? await db.select({ orderId: t.orderSeat.orderId }).from(t.orderSeat).where(inArray(t.orderSeat.orderId, vips.map((v) => v.id))) : [];

  const rows: BuyerRow[] = [];
  for (const p of pos) {
    const inv = invs.filter((x) => x.preorderId === p.id).at(-1);
    const b2b = p.invType === 'company';
    rows.push({
      key: `p${p.id}`, kind: b2b ? 'b2b' : 'b2c', no: p.no,
      plans: p.items.map((i) => `${i.name}×${i.qty}`).join('、') || '（未選內容）',
      amount: p.amount, status: p.source === 'card' ? '已刷卡' : p.waitlist ? '候補' : PRE_STATUS[p.status] ?? p.status,
      name: p.name, phone: p.phone, email: p.email,
      qrEmails: [...new Set(os.filter((o) => o.linkId === p.linkId && (o.status === 'paid' || o.status === 'pending') && o.email).map((o) => o.email!.trim()))],
      ubn: b2b ? p.invCode : '', title: b2b ? p.invTitle : '', carrier: b2b ? '' : invDesc(p.invType, p.invCode, p.invTitle, ''),
      invoice: inv ? { status: inv.status, invoiceNo: inv.invoiceNo } : null, flags: [],
    });
  }
  for (const v of vips) {
    const n = vipSeats.filter((s) => s.orderId === v.id).length;
    rows.push({
      key: `v${v.id}`, kind: 'vip', no: v.orderNo ?? `招待${v.id}`, plans: `招待 ${n} 席`, amount: null, status: '招待',
      name: v.buyerName ?? '', phone: v.buyerPhone ?? '', email: v.buyerEmail ?? '', qrEmails: [],
      ubn: '', title: '', carrier: '', invoice: null, flags: [],
    });
  }

  // 同一個 Email → 用過的姓名
  const byEmail = new Map<string, { name: string; no: string }[]>();
  const addUse = (e: string, name: string, no: string) => {
    const k = normEmail(e); if (!k) return;
    const a = byEmail.get(k) ?? []; a.push({ name, no }); byEmail.set(k, a);
  };
  for (const r of rows) { addUse(r.email, r.name, r.no); for (const q of r.qrEmails) if (normEmail(q) !== normEmail(r.email)) addUse(q, r.name, r.no); }
  // 同一統編 → 抬頭
  const byUbn = new Map<string, Set<string>>();
  for (const r of rows.filter((x) => x.kind === 'b2b' && x.ubn)) byUbn.set(r.ubn, (byUbn.get(r.ubn) ?? new Set()).add(normName(r.title)));

  for (const r of rows) {
    const f = r.flags;
    const label = r.kind === 'vip' ? 'Email' : '發票 Email';
    if (!r.email.trim()) { if (r.kind !== 'vip') f.push('發票 Email 空白'); }
    else if (!EMAIL_OK.test(r.email.trim())) f.push(`${label}格式不對`);
    for (const [e, what] of [[r.email, label], ...r.qrEmails.map((q) => [q, 'QR 寄送 Email'])] as [string, string][]) {
      const k = normEmail(e); if (!k) continue;
      if (internal.has(k)) f.push(`${what} 是我們自己的信箱（${e.trim()}），是否忘了改回買方的？`);
      const others = (byEmail.get(k) ?? []).filter((u) => normName(u.name) !== normName(r.name));
      if (others.length) f.push(`${what} ${e.trim()} 也用在 ${[...new Set(others.map((u) => `${u.name}（${u.no}）`))].slice(0, 3).join('、')}`);
    }
    if (r.kind === 'b2c' && ORG.test(r.name)) f.push('姓名像公司／團體，是否漏打統編？');
    if (r.kind === 'b2b') {
      if (!ubnValid(r.ubn)) f.push('統編不正確（8 碼或檢查碼）');
      if (!r.title.trim()) f.push('沒有公司抬頭');
      if ((byUbn.get(r.ubn)?.size ?? 0) > 1) f.push('同一統編有不同抬頭');
    }
    r.flags = [...new Set(f)];
  }
  const order: Record<BuyerKind, number> = { b2b: 0, b2c: 1, vip: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.no.localeCompare(b.no));
  return { rows, internal: list, sender };
}
