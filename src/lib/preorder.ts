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
import { getEinvConfig, verifyBuyer, type EinvPost } from './einvoice';

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 訂購頁可選的項目：已發布的組合票（每組）＋已發布、票價大於 0 的票種（單張） */
/** 含價格：後台與伺服器計算用 */
export async function preorderMenuFull(db: Db) {
  const ev = await currentEvent(db);
  const pub = ev.published ?? { open: false, zoneIds: [], comboIds: [], at: '' };
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const zoneName = (id: number) => zones.find((z) => z.id === id)?.name ?? '';
  const combos = (await loadCombos(db, ev.id)).filter((c) => pub.comboIds.includes(c.id) && !c.isSingle && c.price > 0);
  const singleOpen = (await loadCombos(db, ev.id)).some((c) => c.isSingle && pub.comboIds.includes(c.id));
  const items = [
    ...combos.map((c) => {
      // 白話：一組＝付哪幾張＋送哪幾張（送的票種＝票價 0）
      const isGift = (zid: number) => zones.find((z) => z.id === zid)?.price === 0;
      const buy = c.items.filter((i) => !isGift(i.zoneId)).map((i) => `${zoneName(i.zoneId)} ${i.qty} 張`);
      const gift = c.items.filter((i) => isGift(i.zoneId)).map((i) => `送 ${zoneName(i.zoneId)} ${i.qty} 張${i.qty > 1 ? '（相連）' : ''}`);
      return { kind: 'combo' as const, id: c.id, name: c.name, price: c.price, desc: `一組：${[...buy, ...gift].join('＋')}`, unit: '組', zoneIds: c.items.map((i) => i.zoneId) };
    }),
    ...(singleOpen ? zones.filter((z) => pub.zoneIds.includes(z.id) && z.price > 0).sort((a, b) => a.sort - b.sort)
      .map((z) => ({ kind: 'zone' as const, id: z.id, name: `${z.name} 單張`, price: z.price, desc: `${z.name} 1 張`, unit: '張', zoneIds: [z.id] })) : []),
  ];
  return {
    invoice: (await getEinvConfig(db)).enabled, // 有開電子發票時，預購單要選發票開立方式
    open: ev.preorderOpen && items.length > 0,
    mailFrom: (await (await import('./notify')).getNotifyConfig(db)).email?.user ?? '',
    pushLink: await getPushLink(db),
    line: await getLineCfg(db), // 選了哪些項目，就必須先加入對應的 LINE 群才能送出
    event: { name: ev.name, showAt: ev.showAt.toISOString(), bankName: ev.bankName, bankAccount: ev.bankAccount, accountName: ev.accountName },
    items,
  };
}

/** 公開給預購頁：不含任何金額 */
export async function preorderMenu(db: Db) {
  const m = await preorderMenuFull(db);
  const { publicSeatMap } = await import('./booking');
  return { ...m, items: m.items.map(({ price: _p, ...x }) => { void _p; return x; }), map: await publicSeatMap(db) };
}

const submitBody = z.object({
  items: z.array(z.object({ kind: z.enum(['combo', 'zone']), id: z.number().int().positive(), qty: z.number().int().min(0).max(200) })).max(30),
  name: z.string().trim().min(1, '請填寫身分證上的姓名').max(40),
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字')),
  email: z.string().trim().email('Email 格式不正確，劃位連結會寄到這個信箱').max(120),
  paidAmount: z.number().int().min(0).max(10_000_000).optional().default(0),
  last5: z.string().trim().max(5).optional().default(''),
  // 用兩個以上帳號匯款：分別列出末五碼與金額
  remits: z.array(z.object({
    last5: z.string().trim().regex(/^\d{5}$/, '匯款帳號末 5 碼應為 5 位數字'),
    amount: z.number().int().min(1, '請填寫每一筆的匯款金額').max(10_000_000),
  })).max(5).optional(),
  lineName: z.string().trim().max(40).optional().default(''),
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
  invType: z.enum(['member', 'mobile', 'cert', 'donate', 'company']).default('member'),
  invCode: z.string().trim().toUpperCase().max(20).default(''),
  invTitle: z.string().trim().max(60).default(''),
  lineJoined: z.array(z.string().max(20)).max(10).optional().default([]),
});

const recent = new Map<string, number[]>();
/** 簡單防灌單：同一來源 10 分鐘內最多 10 筆 */
function rateLimit(ip: string, now: number) {
  const list = (recent.get(ip) ?? []).filter((x) => now - x < 600_000);
  if (list.length >= 10) throw new BookingError('TOO_MANY', '送出太頻繁，請稍後再試。');
  list.push(now); recent.set(ip, list);
}

export async function submitPreorder(db: Db, raw: unknown, ip = '', now = new Date(), einvPost?: EinvPost) {
  const p = submitBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const menu = await preorderMenuFull(db);
  if (!menu.open) throw new BookingError('SALE_CLOSED', '目前未開放預購。');
  const items: t.PreorderItem[] = [];
  for (const it of p.data.items.filter((x) => x.qty > 0)) {
    const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id);
    if (!m) throw new BookingError('INVALID', '選購項目已變更，請重新整理頁面。');
    items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
  }
  if (!items.length) throw new BookingError('INVALID', '請至少選購一項');
  const remits = p.data.remits?.length ? p.data.remits : [{ last5: p.data.last5, amount: p.data.paidAmount }];
  for (const r of remits) {
    if (!/^\d{5}$/.test(r.last5)) throw new BookingError('INVALID', '匯款帳號末 5 碼應為 5 位數字');
    if (!(r.amount > 0)) throw new BookingError('INVALID', '請填寫匯款金額');
  }
  const paidAmount = remits.reduce((a, r) => a + r.amount, 0);
  const last5 = remits.length > 1 ? remits.map((r) => `${r.last5}（NT$${r.amount.toLocaleString('en-US')}）`).join('、') : remits[0].last5;
  const lineMiss = lineNeeded(menu.line, items).filter((g) => !p.data.lineJoined.includes(g.name));
  if (lineMiss.length) throw new BookingError('INVALID', `請先加入 LINE 群：${lineMiss.map((g) => g.name).join('、')}，並勾選「我已加入」`);
  // 發票：預購單只問二聯（個人）／三聯（公司名稱＋統編）；電子發票之後由後台統一開立
  const inv = p.data.invType === 'company' ? { invType: 'company' as const, invCode: p.data.invCode, invTitle: p.data.invTitle }
    : menu.invoice ? { invType: p.data.invType, invCode: p.data.invType === 'member' ? '' : p.data.invCode, invTitle: '' }
    : { invType: 'member' as const, invCode: '', invTitle: '' };
  const ip2 = invProblem(inv.invType, inv.invCode, inv.invTitle);
  if (ip2) throw new BookingError('INVALID', ip2);
  rateLimit(ip, now.getTime());
  // 手機條碼、愛心碼、統編：送出前先向綠界確認，確定錯的請訂購人改正
  if (menu.invoice) {
    const v = await verifyBuyer(db, inv.invType, inv.invCode, inv.invTitle, einvPost);
    if (v.block) throw new BookingError('INVALID', v.block);
  }
  const amount = items.reduce((a, x) => a + x.price * x.qty, 0);
  const ev = await currentEvent(db);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.preorder).where(eq(t.preorder.eventId, ev.id));
    const no = `P${String(n + 1 + attempt).padStart(4, '0')}`;
    try {
      const viewToken = randomBytes(18).toString('base64url');
      const [row] = await db.insert(t.preorder).values({
        eventId: ev.id, no, items, amount, name: p.data.name, phone: p.data.phone, email: p.data.email,
        paidAmount, last5, lineName: p.data.lineName, createdAt: now, viewToken, ...inv,
      }).returning();
      await db.insert(t.notification).values({
        channel: 'email', template: 'preorder_received', recipient: row.email,
        content: `【${ev.name}】${row.name} 您好，已收到您的訂單 ${no}：${itemsText(items)}。主辦方確認款項、並依送單順序輪到您時，會由寄這封信的同一個信箱寄出「劃位通知」。若沒看到，請查看垃圾郵件匣，並建議先把這個信箱加入聯絡人。`,
      });
      // token 只交給送出的這台裝置：之後用它查進度、開推播；不能用電話或姓名查（避免別人拿走劃位連結）
      return { no, token: viewToken }; // 買方看不到金額
    } catch (e) {
      if (!/unique|duplicate/i.test(String((e as Error).message))) throw e;
    }
  }
  throw new BookingError('SERVER', '系統忙碌中，請再送出一次。');
}

export const itemsText = (items: t.PreorderItem[]) => items.map((x) => `${x.name} × ${x.qty}`).join('、');

export const itemKey = (i: { kind: string; id: number }) => `${i.kind}:${i.id}`;

export async function listPreorders(db: Db) {
  const ev = await currentEvent(db);
  const rows = await db.select().from(t.preorder).where(eq(t.preorder.eventId, ev.id)).orderBy(desc(t.preorder.id));
  const cfg = await getLineCfg(db);
  // 送單順序：依送出時間（取消的不算）
  const seq = new Map([...rows].filter((r) => r.status !== 'cancelled').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id).map((r, i) => [r.id, i + 1]));
  // 已發連結的：劃位進度（還剩幾張沒劃、選位中、待確認、已確認）
  const { linkEntitle } = await import('./booking');
  const prog = new Map<number, { left: number; held: number; pending: number; paid: number }>();
  for (const r of rows.filter((x) => x.linkId && x.status === 'confirmed')) {
    const ent = await linkEntitle(db, r.linkId!);
    const os = await db.select({ status: t.orders.status }).from(t.orders).where(eq(t.orders.linkId, r.linkId!));
    const n = (s: string) => os.filter((o) => o.status === s).length;
    prog.set(r.id, { left: ent ? ent.rows.reduce((a, x) => a + Math.max(0, x.left), 0) : 0, held: n('held'), pending: n('pending'), paid: n('paid') });
  }
  const linkIds = rows.map((r) => r.linkId).filter((x): x is number => !!x);
  const links = linkIds.length ? await db.select({ id: t.inviteLink.id, code: t.inviteLink.code }).from(t.inviteLink).where(inArray(t.inviteLink.id, linkIds)) : [];
  const invs = rows.length ? await db.select().from(t.invoice).where(inArray(t.invoice.preorderId, rows.map((r) => r.id))).orderBy(t.invoice.id) : [];
  return rows.map((r) => ({
    id: r.id, no: r.no, items: r.items, amount: r.amount, name: r.name, phone: r.phone, email: r.email, paidAmount: r.paidAmount, last5: r.last5,
    source: r.source, answers: r.answers, invType: r.invType, invTitle: r.invTitle, invCode: r.invCode,
    seq: seq.get(r.id) ?? null, lineName: r.lineName, paidOkAt: r.paidOkAt?.toISOString() ?? null, paidOkBy: r.paidOkBy, lineOk: r.lineOk,
    released: r.released ?? (r.linkId ? r.items.map(itemKey) : []),
    needGroups: Object.fromEntries(r.items.map((i) => [itemKey(i), lineNeeded(cfg, [i]).map((g) => g.name)])) as Record<string, string[]>,
    progress: prog.get(r.id) ?? null,
    status: r.status, note: r.note, createdAt: r.createdAt.toISOString(), confirmedAt: r.confirmedAt?.toISOString() ?? null, confirmedBy: r.confirmedBy,
    isNew: r.status === 'submitted' && !r.seenAt, linkCode: links.find((l) => l.id === r.linkId)?.code ?? null,
    invoice: invDesc(r.invType, r.invCode, r.invTitle, r.email),
    invoiceState: (() => { const v = invs.filter((x) => x.preorderId === r.id).at(-1); return v ? { status: v.status, invoiceNo: v.invoiceNo, checks: v.checks.length } : null; })(),
  }));
}

/** 確認收訖：建立不限張數的專屬劃位連結（有效到演出當天），寄到 Email；有手機也寄簡訊 */
export async function confirmPreorder(db: Db, actor: string, id: number, base?: string, now = new Date(), pickItems?: { kind: 'combo' | 'zone'; id: number; qty: number }[]) {
  const ev = await currentEvent(db);
  const [po0] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po0) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po0.status !== 'submitted') throw new BookingError('INVALID', po0.status === 'confirmed' ? '這張訂單已確認過了' : '這張訂單已取消');
  let po = po0;
  // Google 表單來的沒有數量：由後台在確認收訖時選內容與數量
  if (!po.items.length) {
    const menu = await preorderMenuFull(db);
    const items: t.PreorderItem[] = [];
    for (const it of (pickItems ?? []).filter((x) => x.qty > 0)) {
      const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id);
      if (!m) throw new BookingError('INVALID', '選擇的項目已變更，請重新整理頁面。');
      items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
    }
    if (!items.length) throw new BookingError('INVALID', '請先選擇他可以劃的內容與數量');
    const amount = items.reduce((a, x) => a + x.price * x.qty, 0);
    [po] = await db.update(t.preorder).set({ items, amount }).where(eq(t.preorder.id, id)).returning();
  }
  const fromForm = po.source === 'form';
  const expiresAt = new Date(`${ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}T23:59:59+08:00`);
  const link = await createInviteLink(db, actor, {
    name: po.name, phone: po.phone, quota: 0, expiresAt,
    note: fromForm ? `表單 ${po.no}・${itemsText(po.items)}・匯款 ${po.last5}`.slice(0, 300)
      : `訂單 ${po.no}・${itemsText(po.items)}・匯款 NT$${po.paidAmount.toLocaleString('en-US')}・末五碼 ${po.last5}`,
  }, base);
  const url = linkUrl(link.code, base);
  await db.update(t.preorder).set({ status: 'confirmed', linkId: link.id, confirmedAt: now, confirmedBy: actor, seenAt: po.seenAt ?? now }).where(eq(t.preorder.id, id));
  // 訂購人送出訂單時開了手機通知：只通知「已收款，請查看 Email」，劃位連結只用 Email 寄送
  await db.update(t.pushSub).set({ linkId: link.id }).where(eq(t.pushSub.preorderId, po.id));
  if (!fromForm) await db.insert(t.notification).values({
    linkId: link.id, channel: 'push', template: 'preorder_link', recipient: '訂購人手機',
    content: (await getPushLink(db))
      ? `已確認收到您的款項（訂單 ${po.no}），請點這則通知開始選位。劃位連結也已寄到您的 Email（${maskEmail(po.email)}）。`
      : `已確認收到您的款項（訂單 ${po.no}）。劃位連結已寄到您的 Email（${maskEmail(po.email)}），請查看信箱，也看看垃圾郵件匣。`,
  });
  if (fromForm && po.email) await db.insert(t.notification).values({
    linkId: link.id, channel: 'email', template: 'preorder_link', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項（${itemsText(po.items)}）。請點以下專屬連結選位並填寫持票人資料：${url}　連結有效至演出當天，請勿轉傳他人。`,
  });
  if (!fromForm) await db.insert(t.notification).values({
    linkId: link.id, channel: 'email', template: 'preorder_link', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項（訂單 ${po.no}：${itemsText(po.items)}）。請點以下專屬連結選位並填寫持票人資料：${url}　連結有效至演出當天，請勿轉傳他人。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_confirm', target: `preorder:${id}`, detail: JSON.stringify({ link: link.code }) });
  return { code: link.code, linkId: link.id, fromForm, email: po.email };
}

/** 老大核對：已匯款、已入 LINE 群。只記錄，不寄任何東西 */
export async function checkPreorder(db: Db, actor: string, id: number, v: { paid?: boolean; line?: string[] }, now = new Date()) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這張訂單已取消');
  const set: Partial<typeof t.preorder.$inferInsert> = { seenAt: po.seenAt ?? now };
  if (v.paid !== undefined) Object.assign(set, v.paid ? { paidOkAt: now, paidOkBy: actor } : { paidOkAt: null, paidOkBy: null });
  if (v.line) set.lineOk = [...new Set(v.line.map((x) => x.trim()).filter(Boolean))].slice(0, 10);
  await db.update(t.preorder).set(set).where(eq(t.preorder.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_check', target: `preorder:${id}`, detail: JSON.stringify(v) });
}

/** 表單來的（沒有數量）：由後台設定他可以劃的內容 */
export async function setPreorderItems(db: Db, actor: string, id: number, pick: { kind: 'combo' | 'zone'; id: number; qty: number }[]) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.linkId) throw new BookingError('INVALID', '已發出劃位連結，不能再改內容');
  const menu = await preorderMenuFull(db);
  const items: t.PreorderItem[] = [];
  for (const it of pick.filter((x) => x.qty > 0)) {
    const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id);
    if (!m) throw new BookingError('INVALID', '選擇的項目已變更，請重新整理頁面。');
    items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
  }
  if (!items.length) throw new BookingError('INVALID', '請至少填一項的數量');
  await db.update(t.preorder).set({ items, amount: items.reduce((a, x) => a + x.price * x.qty, 0) }).where(eq(t.preorder.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_items', target: `preorder:${id}`, detail: itemsText(items) });
}

/**
 * 發出劃位連結（老大按第三顆鈕才寄）。可以分批：例如週二只發功德、週三再發金區。
 * 第一次發出時建立專屬連結；之後同一個連結再開放下一批，並再寄一封信。
 * 必須已勾「已匯款」，以及這批項目需要的 LINE 群都已勾。
 */
export async function releasePreorder(db: Db, actor: string, id: number, keys: string[], base?: string, now = new Date()) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這張訂單已取消');
  if (!po.items.length) throw new BookingError('INVALID', '請先設定他可以劃的內容與數量');
  if (!po.paidOkAt) throw new BookingError('INVALID', '請先勾「已匯款」');
  const done = po.released ?? (po.linkId ? po.items.map(itemKey) : []);
  const rel = po.items.filter((i) => keys.includes(itemKey(i)) && !done.includes(itemKey(i)));
  if (!rel.length) throw new BookingError('INVALID', '這些項目已經發過劃位連結了');
  const missing = lineNeeded(await getLineCfg(db), rel).filter((g) => !po.lineOk.includes(g.name));
  if (missing.length) throw new BookingError('INVALID', `請先勾「已入 ${missing.map((g) => g.name).join('、')}」`);
  let linkId = po.linkId;
  let code = '';
  if (!linkId) {
    const expiresAt = new Date(`${ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}T23:59:59+08:00`);
    const link = await createInviteLink(db, actor, {
      name: po.name, phone: po.phone, quota: 0, expiresAt,
      note: `訂單 ${po.no}・${itemsText(po.items)}・匯款 ${po.source === 'form' ? po.last5 : `NT$${po.paidAmount.toLocaleString('en-US')}・末五碼 ${po.last5}`}`.slice(0, 300),
    }, base, { sms: false });
    linkId = link.id; code = link.code;
  } else {
    const [l] = await db.select({ code: t.inviteLink.code }).from(t.inviteLink).where(eq(t.inviteLink.id, linkId));
    code = l.code;
  }
  const released = [...done, ...rel.map(itemKey)];
  await db.update(t.preorder).set({ status: 'confirmed', linkId, released, confirmedAt: po.confirmedAt ?? now, confirmedBy: po.confirmedBy ?? actor, seenAt: po.seenAt ?? now }).where(eq(t.preorder.id, id));
  const rest = po.items.filter((i) => !released.includes(itemKey(i)));
  const url = linkUrl(code, base);
  if (po.email) await db.insert(t.notification).values({
    linkId, channel: 'email', template: 'preorder_link', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項，現在輪到您劃位：${itemsText(rel)}。請點以下專屬連結選位並填寫持票人資料：${url}　${rest.length ? `${itemsText(rest)} 輪到時會再通知您，用同一個連結劃位。` : ''}連結有效至演出當天，請勿轉傳他人。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_release', target: `preorder:${id}`, detail: JSON.stringify({ link: code, items: rel.map(itemKey) }) });
  return { code, linkId, email: po.email, items: itemsText(rel), rest: itemsText(rest) };
}

/** 改 Email（買方打錯時）；已發過劃位連結的，可以順便補寄一封到新信箱 */
export async function updatePreorderEmail(db: Db, actor: string, id: number, email: string, resend: boolean, base?: string) {
  const ev = await currentEvent(db);
  const e = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new BookingError('INVALID', 'Email 格式不正確');
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  await db.update(t.preorder).set({ email: e }).where(eq(t.preorder.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_email', target: `preorder:${id}`, detail: JSON.stringify({ from: po.email, to: e, resend }) });
  if (!resend || !po.linkId) return { linkId: po.linkId, resent: false };
  const [l] = await db.select({ code: t.inviteLink.code }).from(t.inviteLink).where(eq(t.inviteLink.id, po.linkId));
  const rel = po.items.filter((i) => (po.released ?? po.items.map(itemKey)).includes(itemKey(i)));
  await db.insert(t.notification).values({
    linkId: po.linkId, channel: 'email', template: 'preorder_link', recipient: e,
    content: `【${ev.name}】${po.name} 您好，這是您的專屬劃位連結（補寄）：${itemsText(rel)}。請點以下連結選位並填寫持票人資料：${linkUrl(l.code, base)}　請勿轉傳他人。`,
  });
  return { linkId: po.linkId, resent: true };
}

export async function cancelPreorder(db: Db, actor: string, id: number, reason = '') {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status !== 'submitted') throw new BookingError('INVALID', '只有待確認的訂單可以取消');
  await db.update(t.preorder).set({ status: 'cancelled', note: reason, seenAt: po.seenAt ?? new Date() }).where(eq(t.preorder.id, id));
  if (po.source !== 'form') await db.insert(t.notification).values({
    channel: 'email', template: 'preorder_cancelled', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，您的訂單 ${po.no} 已取消${reason ? `（${reason}）` : ''}。如有疑問或已匯款，請聯繫主辦方。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_cancel', target: `preorder:${id}`, detail: JSON.stringify({ reason }) });
}

export async function markPreorderSeen(db: Db, id: number) {
  await db.update(t.preorder).set({ seenAt: new Date() }).where(and(eq(t.preorder.id, id), sql`${t.preorder.seenAt} is null`));
}

/** 後台開關：劃位連結是否也送到訂購人手機（推播＋預購頁「開始劃位」按鈕）。預設開啟 */
/**
 * 預購單的 LINE 群：可設定多個群（例如「功德群」「金群」），每個選購項目指定要加入哪個群。
 * 買方選了哪些項目，就必須先按那些群的「加入」並勾選「已加入」才能送出。
 */
export type LineGroup = { name: string; url: string };
export type LineCfg = { groups: LineGroup[]; map: Record<string, number> }; // map：'combo:3' → groups 的第幾個
const LINE_KEY = 'preorder.lineGroups';
const lineCfgSchema = z.object({
  groups: z.array(z.object({
    name: z.string().trim().min(1, '請填寫群組名稱').max(20),
    url: z.string().trim().regex(/^https:\/\/\S+$/, 'LINE 群連結應為 https:// 開頭的網址').max(500),
  })).max(8),
  map: z.record(z.string().regex(/^(combo|zone):\d+$/), z.number().int().min(0)),
});
export async function getLineCfg(db: Db): Promise<LineCfg> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, LINE_KEY));
  try { const v = lineCfgSchema.parse(JSON.parse(r?.value || '{}')); return v; } catch { return { groups: [], map: {} }; }
}
export async function setLineCfg(db: Db, actor: string, raw: unknown) {
  const p = lineCfgSchema.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? 'LINE 群設定不正確');
  const map = Object.fromEntries(Object.entries(p.data.map).filter(([, i]) => i < p.data.groups.length));
  const value = JSON.stringify({ groups: p.data.groups, map });
  await db.insert(t.appSetting).values({ key: LINE_KEY, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_line_groups', target: 'app_setting', detail: value });
}
/** 這些選購項目需要加入的 LINE 群（不重複、依設定順序） */
export function lineNeeded(cfg: LineCfg, items: { kind: string; id: number }[]) {
  const idx = new Set(items.map((i) => cfg.map[`${i.kind}:${i.id}`]).filter((x): x is number => x !== undefined && x < cfg.groups.length));
  return cfg.groups.filter((_, i) => idx.has(i));
}

export async function getPushLink(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, 'preorder.pushLink'));
  void r; return false; // 「推到手機＋開始劃位按鈕」已停用：劃位連結只用 Email 寄出
}
export async function setPushLink(db: Db, actor: string, on: boolean) {
  const value = on ? '1' : '0';
  await db.insert(t.appSetting).values({ key: 'preorder.pushLink', value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_push_link', target: 'app_setting', detail: value });
}

export const maskEmail = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, '$1***$2');

/** 訂購人裝置查進度：只認送出時拿到的隨機碼，一次最多 20 筆。不提供劃位連結（連結只用 Email 寄送） */
export async function preorderStatus(db: Db, tokens: string[]) {
  const list = [...new Set(tokens.filter((x) => typeof x === 'string' && /^[\w-]{20,40}$/.test(x)))].slice(0, 20);
  if (!list.length) return [];
  const rows = await db.select().from(t.preorder).where(inArray(t.preorder.viewToken, list)).orderBy(desc(t.preorder.id));
  // 開關打開時：已收款的訂單，在送出訂單的這台裝置上直接給劃位連結（只認送出時的隨機碼，別人查不到）
  const show = await getPushLink(db);
  const linkIds = rows.map((r) => r.linkId).filter((x): x is number => !!x);
  const links = show && linkIds.length ? await db.select({ id: t.inviteLink.id, code: t.inviteLink.code, status: t.inviteLink.status }).from(t.inviteLink).where(inArray(t.inviteLink.id, linkIds)) : [];
  return rows.map((r) => {
    const l = links.find((x) => x.id === r.linkId);
    return {
      token: r.viewToken!, no: r.no, status: r.status, items: itemsText(r.items), createdAt: r.createdAt.toISOString(),
      email: maskEmail(r.email), url: r.status === 'confirmed' && l && l.status === 'active' ? `/t/${l.code}` : null,
    };
  });
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
