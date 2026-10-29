/**
 * 公開訂購：消費者在公開訂購頁選購（不劃位）→ 匯款 → 填身分證姓名、手機、Email、匯款金額、帳號末五碼送出；
 * 後台確認收訖後，自動建立不限張數的專屬劃位連結，寄到 Email（有手機也寄簡訊）。
 * 訂購不佔名額（確認收訖、實際劃位時才算），也不會自動取消。
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError, loadCombos } from './booking';
import { comboDesc } from './pricing';
import { createInviteLink, linkUrl } from './admin';
import { normalizePhone } from './validation';
import { invDesc, invProblem } from './invoiceRules';
import { getEinvConfig } from './einvoice';

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 訂購頁可選的項目：已發布的組合票（每組）＋已發布、票價大於 0 的票種（單張） */
export async function preorderMenu(db: Db) {
  const ev = await currentEvent(db);
  const pub = ev.published ?? { open: false, zoneIds: [], comboIds: [], at: '' };
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const zoneName = (id: number) => zones.find((z) => z.id === id)?.name ?? '';
  const combos = (await loadCombos(db, ev.id)).filter((c) => pub.comboIds.includes(c.id) && !c.isSingle && c.price > 0);
  const singleOpen = (await loadCombos(db, ev.id)).some((c) => c.isSingle && pub.comboIds.includes(c.id));
  const items = [
    ...combos.map((c) => ({ kind: 'combo' as const, id: c.id, name: c.name, price: c.price, desc: `每組 ${comboDesc(c, zoneName)}`, unit: '組' })),
    ...(singleOpen ? zones.filter((z) => pub.zoneIds.includes(z.id) && z.price > 0).sort((a, b) => a.sort - b.sort)
      .map((z) => ({ kind: 'zone' as const, id: z.id, name: `${z.name} 單張`, price: z.price, desc: '單張購票', unit: '張' })) : []),
  ];
  return {
    invoice: (await getEinvConfig(db)).enabled, // 有開電子發票時，預購單要選發票開立方式
    open: ev.preorderOpen && items.length > 0,
    event: { name: ev.name, showAt: ev.showAt.toISOString(), bankName: ev.bankName, bankAccount: ev.bankAccount, accountName: ev.accountName },
    items,
  };
}

const submitBody = z.object({
  items: z.array(z.object({ kind: z.enum(['combo', 'zone']), id: z.number().int().positive(), qty: z.number().int().min(0).max(200) })).max(30),
  name: z.string().trim().min(1, '請填寫身分證上的姓名').max(40),
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字')),
  email: z.string().trim().email('Email 格式不正確，劃位連結會寄到這個信箱').max(120),
  paidAmount: z.number().int().min(1, '請填寫匯款金額').max(10_000_000),
  last5: z.string().trim().regex(/^\d{5}$/, '匯款帳號末 5 碼應為 5 位數字'),
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
  invType: z.enum(['member', 'mobile', 'cert', 'donate', 'company']).default('member'),
  invCode: z.string().trim().toUpperCase().max(20).default(''),
  invTitle: z.string().trim().max(60).default(''),
});

const recent = new Map<string, number[]>();
/** 簡單防灌單：同一來源 10 分鐘內最多 10 筆 */
function rateLimit(ip: string, now: number) {
  const list = (recent.get(ip) ?? []).filter((x) => now - x < 600_000);
  if (list.length >= 10) throw new BookingError('TOO_MANY', '送出太頻繁，請稍後再試。');
  list.push(now); recent.set(ip, list);
}

export async function submitPreorder(db: Db, raw: unknown, ip = '', now = new Date()) {
  const p = submitBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const menu = await preorderMenu(db);
  if (!menu.open) throw new BookingError('SALE_CLOSED', '目前未開放預購。');
  const items: t.PreorderItem[] = [];
  for (const it of p.data.items.filter((x) => x.qty > 0)) {
    const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id);
    if (!m) throw new BookingError('INVALID', '選購項目已變更，請重新整理頁面。');
    items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
  }
  if (!items.length) throw new BookingError('INVALID', '請至少選購一項');
  const inv = menu.invoice ? { invType: p.data.invType, invCode: p.data.invType === 'member' ? '' : p.data.invCode, invTitle: p.data.invType === 'company' ? p.data.invTitle : '' }
    : { invType: 'member' as const, invCode: '', invTitle: '' };
  const ip2 = invProblem(inv.invType, inv.invCode, inv.invTitle);
  if (ip2) throw new BookingError('INVALID', ip2);
  rateLimit(ip, now.getTime());
  const amount = items.reduce((a, x) => a + x.price * x.qty, 0);
  const ev = await currentEvent(db);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.preorder).where(eq(t.preorder.eventId, ev.id));
    const no = `P${String(n + 1 + attempt).padStart(4, '0')}`;
    try {
      const viewToken = randomBytes(18).toString('base64url');
      const [row] = await db.insert(t.preorder).values({
        eventId: ev.id, no, items, amount, name: p.data.name, phone: p.data.phone, email: p.data.email,
        paidAmount: p.data.paidAmount, last5: p.data.last5, createdAt: now, viewToken, ...inv,
      }).returning();
      await db.insert(t.notification).values({
        channel: 'email', template: 'preorder_received', recipient: row.email,
        content: `【${ev.name}】${row.name} 您好，已收到您的訂單 ${no}：${itemsText(items)}，合計 NT$${amount.toLocaleString('en-US')}（您填寫的匯款金額 NT$${row.paidAmount.toLocaleString('en-US')}、帳號末五碼 ${row.last5}）。主辦方確認收到款項後，會寄出您的專屬劃位連結到這個信箱。`,
      });
      // token 只交給送出的這台裝置：之後用它查進度、開推播；不能用電話或姓名查（避免別人拿走劃位連結）
      return { no, amount, mismatch: amount !== row.paidAmount, token: viewToken };
    } catch (e) {
      if (!/unique|duplicate/i.test(String((e as Error).message))) throw e;
    }
  }
  throw new BookingError('SERVER', '系統忙碌中，請再送出一次。');
}

export const itemsText = (items: t.PreorderItem[]) => items.map((x) => `${x.name} × ${x.qty}`).join('、');

export async function listPreorders(db: Db) {
  const ev = await currentEvent(db);
  const rows = await db.select().from(t.preorder).where(eq(t.preorder.eventId, ev.id)).orderBy(desc(t.preorder.id));
  const linkIds = rows.map((r) => r.linkId).filter((x): x is number => !!x);
  const links = linkIds.length ? await db.select({ id: t.inviteLink.id, code: t.inviteLink.code }).from(t.inviteLink).where(inArray(t.inviteLink.id, linkIds)) : [];
  return rows.map((r) => ({
    id: r.id, no: r.no, items: r.items, amount: r.amount, name: r.name, phone: r.phone, email: r.email, paidAmount: r.paidAmount, last5: r.last5,
    status: r.status, note: r.note, createdAt: r.createdAt.toISOString(), confirmedAt: r.confirmedAt?.toISOString() ?? null, confirmedBy: r.confirmedBy,
    isNew: r.status === 'submitted' && !r.seenAt, linkCode: links.find((l) => l.id === r.linkId)?.code ?? null,
    invoice: invDesc(r.invType, r.invCode, r.invTitle, r.email),
  }));
}

/** 確認收訖：建立不限張數的專屬劃位連結（有效到演出當天），寄到 Email；有手機也寄簡訊 */
export async function confirmPreorder(db: Db, actor: string, id: number, base?: string, now = new Date()) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status !== 'submitted') throw new BookingError('INVALID', po.status === 'confirmed' ? '這張訂單已確認過了' : '這張訂單已取消');
  const expiresAt = new Date(`${ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}T23:59:59+08:00`);
  const link = await createInviteLink(db, actor, {
    name: po.name, phone: po.phone, quota: 0, expiresAt,
    note: `訂單 ${po.no}・${itemsText(po.items)}・匯款 NT$${po.paidAmount.toLocaleString('en-US')}・末五碼 ${po.last5}`,
  }, base);
  const url = linkUrl(link.code, base);
  await db.update(t.preorder).set({ status: 'confirmed', linkId: link.id, confirmedAt: now, confirmedBy: actor, seenAt: po.seenAt ?? now }).where(eq(t.preorder.id, id));
  // 訂購人送出訂單時開了手機通知：只通知「已收款，請查看 Email」，劃位連結只用 Email 寄送
  await db.update(t.pushSub).set({ linkId: link.id }).where(eq(t.pushSub.preorderId, po.id));
  await db.insert(t.notification).values({
    linkId: link.id, channel: 'push', template: 'preorder_link', recipient: '訂購人手機',
    content: `已確認收到您的款項（訂單 ${po.no}）。劃位連結已寄到您的 Email（${maskEmail(po.email)}），請查看信箱，也看看垃圾郵件匣。`,
  });
  await db.insert(t.notification).values({
    linkId: link.id, channel: 'email', template: 'preorder_link', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項 NT$${po.paidAmount.toLocaleString('en-US')}（訂單 ${po.no}：${itemsText(po.items)}）。請點以下專屬連結選位並填寫持票人資料：${url}　連結有效至演出當天，請勿轉傳他人。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_confirm', target: `preorder:${id}`, detail: JSON.stringify({ link: link.code }) });
  return { code: link.code, linkId: link.id };
}

export async function cancelPreorder(db: Db, actor: string, id: number, reason = '') {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status !== 'submitted') throw new BookingError('INVALID', '只有待確認的訂單可以取消');
  await db.update(t.preorder).set({ status: 'cancelled', note: reason, seenAt: po.seenAt ?? new Date() }).where(eq(t.preorder.id, id));
  await db.insert(t.notification).values({
    channel: 'email', template: 'preorder_cancelled', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，您的訂單 ${po.no} 已取消${reason ? `（${reason}）` : ''}。如有疑問或已匯款，請聯繫主辦方。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_cancel', target: `preorder:${id}`, detail: JSON.stringify({ reason }) });
}

export async function markPreorderSeen(db: Db, id: number) {
  await db.update(t.preorder).set({ seenAt: new Date() }).where(and(eq(t.preorder.id, id), sql`${t.preorder.seenAt} is null`));
}

export const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1***$2');

/** 訂購人裝置查進度：只認送出時拿到的隨機碼，一次最多 20 筆。不提供劃位連結（連結只用 Email 寄送） */
export async function preorderStatus(db: Db, tokens: string[]) {
  const list = [...new Set(tokens.filter((x) => typeof x === 'string' && /^[\w-]{20,40}$/.test(x)))].slice(0, 20);
  if (!list.length) return [];
  const rows = await db.select().from(t.preorder).where(inArray(t.preorder.viewToken, list)).orderBy(desc(t.preorder.id));
  return rows.map((r) => ({
    token: r.viewToken!, no: r.no, status: r.status, items: itemsText(r.items), amount: r.amount, createdAt: r.createdAt.toISOString(),
    email: maskEmail(r.email),
  }));
}

/** 訂購人裝置開啟推播：還沒收款就先掛在預購單上，確認收訖時改掛到劃位連結 */
export async function savePreorderPush(db: Db, token: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  if (!/^https:\/\//.test(sub.endpoint)) throw new BookingError('INVALID', '推播訂閱資料不正確');
  const [po] = token ? await db.select().from(t.preorder).where(eq(t.preorder.viewToken, token)) : [];
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  const v = { linkId: po.linkId, preorderId: po.id, visitorId: null, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
  await db.insert(t.pushSub).values({ ...v, endpoint: sub.endpoint }).onConflictDoUpdate({ target: t.pushSub.endpoint, set: v });
}

export async function preorderExists(db: Db, token: string) {
  const [po] = token ? await db.select({ id: t.preorder.id }).from(t.preorder).where(eq(t.preorder.viewToken, token)) : [];
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
}
