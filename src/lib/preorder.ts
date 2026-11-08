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
import { BookingError, loadCombos, linkEntitle } from './booking';
import { comboDesc } from './pricing';
import { giftLine } from './gift';
import { createInviteLink, linkUrl } from './admin';
import { normalizePhone } from './validation';
import { formatRemits, parseRemits } from './reconcile';
import { siteOrigin } from './push';
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
  const zones = await db.select().from(t.priceZone).where(and(eq(t.priceZone.eventId, ev.id), eq(t.priceZone.floor, '2M'))); // 認購單只賣 2M
  const zoneName = (id: number) => zones.find((z) => z.id === id)?.name ?? '';
  const all2m = (await loadCombos(db, ev.id)).filter((c) => c.floor === '2M');
  const combos = all2m.filter((c) => pub.comboIds.includes(c.id) && !c.isSingle && c.price > 0);
  const giftCat = ev.giftShow?.buy ? await db.select().from(t.giftItem).where(eq(t.giftItem.eventId, ev.id)) : [];
  const singleOpen = all2m.some((c) => c.isSingle && pub.comboIds.includes(c.id));
  const items = [
    ...combos.map((c) => {
      // 白話：一組＝付哪幾張＋送哪幾張（送的票種＝票價 0）
      const isGift = (zid: number) => zones.find((z) => z.id === zid)?.price === 0;
      const buy = c.items.filter((i) => !isGift(i.zoneId)).map((i) => `認購${zoneName(i.zoneId)} ${i.qty} 席`);
      const gift = c.items.filter((i) => isGift(i.zoneId)).map((i) => `致贈${zoneName(i.zoneId)} ${i.qty} 席${i.qty > 1 ? '（座位相連）' : ''}`);
      const auto = [...buy, ...gift].join('，');
      const present = ev.giftShow?.buy ? giftLine(c.gifts, giftCat) : ''; // 預設不顯示贈品（驚喜）
      return { kind: 'combo' as const, id: c.id, name: c.name, price: c.price, desc: (c.description.trim() || auto) + (present ? `（贈 ${present}）` : ''), unit: '份', zoneIds: c.items.map((i) => i.zoneId), hidden: c.hidden };
    }),
    ...(singleOpen ? zones.filter((z) => pub.zoneIds.includes(z.id) && z.price > 0).sort((a, b) => a.sort - b.sort)
      .map((z) => ({ kind: 'zone' as const, id: z.id, name: `${z.name} 單張`, price: z.price, desc: `認購${z.name} 1 席`, unit: '席', zoneIds: [z.id], hidden: false })) : []),
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

/** 公開給預購頁：不含任何金額。staff＝登入後台的人員代填：看得到隱藏方案，認購單關閉時也能填 */
export async function preorderMenu(db: Db, opts: { staff?: boolean } = {}) {
  const staff = !!opts.staff;
  const m = await preorderMenuFull(db);
  const shown = staff ? m.items : m.items.filter((i) => !i.hidden);
  const { publicSeatMap } = await import('./booking');
  const cap = await capacityOf(db);
  const ps = await getPreorderSettings(db);
  const fi = await getFlowImage(db);
  const ext = fi ? (fi.type === 'image/png' ? 'png' : fi.type === 'image/webp' ? 'webp' : 'jpg') : '';
  // 圖檔網址帶版本與副檔名：Cloudflare 會在各地快取，不必每個人都從家裡電腦下載
  return { ...m, staff, open: staff ? shown.length > 0 : m.open && shown.length > 0, intro: ps.intro, flowImage: fi ? `/buy/flow/${fi.ver}.${ext}` : null, items: shown.map(({ price: _p, ...x }) => { void _p; return { ...x, status: x.kind === 'combo' ? capState(cap[x.id]) : 'open' as const }; }), map: await publicSeatMap(db) };
}

/**
 * 公開認購頁的資料，人多時共用：同一時間只算一次，3 秒內重複使用（名額狀態最多晚 3 秒，送出時仍以伺服器即時檢查為準）。
 * 回傳已壓縮好的 JSON，減少從家裡電腦上傳的資料量。
 */
let menuCache: { at: number; json: string; gz: Buffer } | null = null;
let menuBusy: Promise<{ json: string; gz: Buffer }> | null = null;
export async function preorderMenuShared(db: Db, now = Date.now()) {
  if (menuCache && now - menuCache.at < 3000) return menuCache;
  if (!menuBusy) {
    menuBusy = (async () => {
      const json = JSON.stringify({ ok: true, data: await preorderMenu(db) });
      const { gzipSync } = await import('node:zlib');
      const v = { at: Date.now(), json, gz: gzipSync(json) };
      menuCache = v;
      return v;
    })().finally(() => { menuBusy = null; });
  }
  return menuBusy;
}
export const clearMenuCache = () => { menuCache = null; };

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
  last5Later: z.boolean().optional().default(false), // 還沒匯款：後五碼之後再補填（確認信有連結）
  confirmMismatch: z.boolean().optional().default(false), // 買方看到「金額與數量不相當」後，仍確認送出
  confirmDup: z.boolean().optional().default(false), // 同一支手機已登記過，買方確認要再登記一筆
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
  invType: z.enum(['member', 'mobile', 'cert', 'donate', 'company']).default('member'),
  invCode: z.string().trim().toUpperCase().max(20).default(''),
  invTitle: z.string().trim().max(60).default(''),
  lineJoined: z.array(z.string().max(20)).max(10).optional().default([]),
});

/* ---------- 預購單的系統設定（後台可改） ---------- */
export const DEFAULT_INTRO = `古儒吉蒞臨台灣的活動行程。
我們誠摯邀請您以尊榮貴賓的身份蒞臨出席 2026/12/9（週三）晚上，古儒吉於台北國際會議中心的大師課程（Master Class）。
主題：「萬變中 喚醒不變的力量」
我們為您保留「尊榮席」專屬席位，一同參與這場盛會。

## 認購流程
1. 認席位：選擇尊榮席或感恩席。
2. 填個資：填寫您的匯款帳號後五碼與認購金額。
3. 勾發票：勾選發票開立需求。
4. 送出認購單：確認內容無誤後送出。
5. 收確認：畫面與 Email 會回覆已收到，並附上匯款帳戶。
6. 匯款：依指示完成款項匯出。

## 劃位順序說明
1. 系統將依您送出本認購登記的先後順序進行劃位。
2. 主辦方於確認匯款入帳後，將依序通知您劃位。
3. 若尚未完成匯款，劃位順序將順延給下一位已完成流程的認購者。
4. 輪到您劃位時，專屬劃位連結將寄送至您的 Email，主辦方亦可能透過電話或 LINE 主動與您聯繫。`;

export async function getPreorderSettings(db: Db) {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, ['preorder.rateLimit', 'preorder.waitlistCap', 'preorder.intro']));
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const num = (x: string | undefined, d: number) => (x !== undefined && /^\d+$/.test(x) ? parseInt(x) : d);
  return { rateLimit: num(v('preorder.rateLimit'), 100), waitlistCap: num(v('preorder.waitlistCap'), 5), intro: v('preorder.intro') ?? DEFAULT_INTRO, defaultIntro: DEFAULT_INTRO };
}
/** 預購單的流程說明圖（後台上傳，選用）：存成 data URL */
const FLOW_KEY = 'preorder.flowImage';
export async function getFlowImage(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, FLOW_KEY));
  const m = r?.value.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!m) return null;
  let h = 0; for (let i = 0; i < m[2].length; i += 97) h = (h * 31 + m[2].charCodeAt(i)) % 99991;
  return { type: m[1], data: Buffer.from(m[2], 'base64'), ver: `${h}-${m[2].length}` };
}
export async function setFlowImage(db: Db, actor: string, dataUrl: string | null) {
  if (dataUrl === null) {
    await db.delete(t.appSetting).where(eq(t.appSetting.key, FLOW_KEY));
  } else {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new BookingError('INVALID', '圖片格式不支援，請用 JPG 或 PNG');
    if (dataUrl.length > 4_000_000) throw new BookingError('INVALID', '圖片太大，請縮小到 3 MB 以下');
    await db.insert(t.appSetting).values({ key: FLOW_KEY, value: dataUrl }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: dataUrl } });
  }
  await db.insert(t.auditLog).values({ actor, action: 'preorder_flow_image', target: 'app_setting', detail: dataUrl ? '上傳' : '移除' });
}

export async function setPreorderSettings(db: Db, actor: string, x: { rateLimit?: number; waitlistCap?: number; intro?: string }) {
  const put = async (key: string, value: string) => db.insert(t.appSetting).values({ key, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  if (x.rateLimit !== undefined) await put('preorder.rateLimit', String(Math.max(1, Math.min(10000, Math.round(x.rateLimit)))));
  if (x.waitlistCap !== undefined) await put('preorder.waitlistCap', String(Math.max(0, Math.min(1000, Math.round(x.waitlistCap)))));
  if (x.intro !== undefined) await put('preorder.intro', x.intro.slice(0, 5000));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_settings', target: 'app_setting', detail: JSON.stringify({ ...x, intro: x.intro !== undefined ? '（已修改）' : undefined }) });
}

const recent = new Map<string, number[]>();
/** 防灌單：同一來源 10 分鐘內最多 N 筆（後台可設定，預設 100） */
function rateLimit(ip: string, now: number, max: number) {
  const list = (recent.get(ip) ?? []).filter((x) => now - x < 600_000);
  if (list.length >= max) throw new BookingError('TOO_MANY', '送出太頻繁，請稍後再試。');
  list.push(now); recent.set(ip, list);
}

/** 名額：每個限量方案已登記多少（正取、候補分開算），用來判斷「收到／候補／已圓滿」 */
export async function capacityOf(db: Db) {
  const ev = await currentEvent(db);
  const combos = (await loadCombos(db, ev.id)).filter((c) => c.floor === '2M' && !c.isSingle && c.limitSets > 0);
  const rows = await db.select({ items: t.preorder.items, waitlist: t.preorder.waitlist }).from(t.preorder)
    .where(and(eq(t.preorder.eventId, ev.id), sql`${t.preorder.status} <> 'cancelled'`, sql`${t.preorder.source} <> 'card'`));
  const { waitlistCap } = await getPreorderSettings(db);
  const sum = (id: number, w: boolean) => rows.filter((r) => r.waitlist === w).reduce((a, r) => a + r.items.filter((i) => i.kind === 'combo' && i.id === id).reduce((b, i) => b + i.qty, 0), 0);
  return Object.fromEntries(combos.map((c) => [c.id, { limit: c.limitSets, used: sum(c.id, false), wait: sum(c.id, true), waitCap: waitlistCap }])) as Record<number, { limit: number; used: number; wait: number; waitCap: number }>;
}
const capState = (c: { limit: number; used: number; wait: number; waitCap: number } | undefined, qty = 1): 'open' | 'waitlist' | 'full' =>
  !c || c.used + qty <= c.limit ? 'open' : c.wait + qty <= c.waitCap ? 'waitlist' : 'full';

/** staff：登入後台的人員代填時傳入姓名；可選隱藏方案，認購單關閉時也能送出 */
export async function submitPreorder(db: Db, raw: unknown, ip = '', now = new Date(), einvPost?: EinvPost, staff = '') {
  const p = submitBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const menu = await preorderMenuFull(db);
  if (!staff && (!menu.open || !menu.items.some((i) => !i.hidden))) throw new BookingError('SALE_CLOSED', '目前未開放預購。');
  const items: t.PreorderItem[] = [];
  for (const it of p.data.items.filter((x) => x.qty > 0)) {
    const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id);
    if (!m || (m.hidden && !staff)) throw new BookingError('INVALID', '認購方案已變更，請重新整理頁面。');
    items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
  }
  if (!items.length) throw new BookingError('INVALID', '請至少選擇一項認購方案');
  const later = p.data.last5Later;
  const remits = later ? [] : p.data.remits?.length ? p.data.remits : [{ last5: p.data.last5, amount: p.data.paidAmount }];
  for (const r of remits) {
    if (!/^\d{5}$/.test(r.last5)) throw new BookingError('INVALID', '匯款帳號末 5 碼應為 5 位數字');
    if (!(r.amount > 0)) throw new BookingError('INVALID', '請填寫匯款金額');
  }
  if (later && !(p.data.paidAmount > 0)) throw new BookingError('INVALID', '請填寫認購金額');
  const paidAmount = later ? p.data.paidAmount : remits.reduce((a, r) => a + r.amount, 0);
  const last5 = formatRemits(remits);
  const lineMiss = lineNeeded(menu.line, items).filter((g) => !p.data.lineJoined.includes(g.name));
  if (lineMiss.length) throw new BookingError('INVALID', `請先加入 LINE 群：${lineMiss.map((g) => g.name).join('、')}，並勾選「我已加入」`);
  // 發票：預購單只問二聯（個人）／三聯（公司名稱＋統編）；電子發票之後由後台統一開立
  const inv = p.data.invType === 'company' ? { invType: 'company' as const, invCode: p.data.invCode, invTitle: p.data.invTitle }
    : menu.invoice ? { invType: p.data.invType, invCode: p.data.invType === 'member' ? '' : p.data.invCode, invTitle: '' }
    : { invType: 'member' as const, invCode: '', invTitle: '' };
  const ip2 = invProblem(inv.invType, inv.invCode, inv.invTitle);
  if (ip2) throw new BookingError('INVALID', ip2);
  const ps = await getPreorderSettings(db);
  // 名額：每個限量方案依登記先後檢查，超過就進候補，候補也滿就不能送出
  const cap = await capacityOf(db);
  const states = items.filter((i) => i.kind === 'combo').map((i) => ({ i, st: capState(cap[i.id], i.qty) }));
  const full = states.filter((x) => x.st === 'full');
  if (full.length) throw new BookingError('FULL', `感謝您的心意，「${full.map((x) => x.i.name).join('、')}」名額已圓滿，暫時無法再登記。如有需要，歡迎直接與我們聯繫。`);
  const waitlist = states.some((x) => x.st === 'waitlist');
  // 金額與數量不相當：先提醒，買方確認後才送出（不告訴他應付多少）
  const amount0 = items.reduce((a, x) => a + x.price * x.qty, 0);
  if (paidAmount !== amount0 && !p.data.confirmMismatch) throw new BookingError('AMOUNT_MISMATCH', '認購金額與認購數量不相當，請檢查確認後，再按送出。');
  // 同一支手機已登記過（未取消）：先提醒，避免「不確定剛才有沒有送出成功」而重複登記
  if (!p.data.confirmDup) {
    const ev0 = await currentEvent(db);
    const [dup] = await db.select({ no: t.preorder.no, at: t.preorder.createdAt }).from(t.preorder)
      .where(and(eq(t.preorder.eventId, ev0.id), eq(t.preorder.phone, p.data.phone), sql`${t.preorder.status} <> 'cancelled'`)).orderBy(desc(t.preorder.createdAt)).limit(1);
    if (dup) {
      const when = dup.at.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      throw new BookingError('DUPLICATE', `這支手機在 ${when} 已送出過認購登記（${dup.no}），不需要重送。若您是要「再多認購一筆」，請按「確定要再登記一筆」。`);
    }
  }
  if (!staff) rateLimit(ip, now.getTime(), ps.rateLimit);
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
        paidAmount, last5, lineName: p.data.lineName, createdAt: now, viewToken, waitlist, ...inv,
        note: staff ? `${now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${staff} 代填` : '',
      }).returning();
      if (staff) await db.insert(t.auditLog).values({ actor: staff, action: 'preorder_staff_entry', target: `preorder:${row.id}`, detail: JSON.stringify({ no, items: itemsText(items) }) });
      await db.insert(t.notification).values({
        channel: 'email', template: 'preorder_received', recipient: row.email,
        content: receivedText(ev, row.name, no, items, waitlist ? await waitPos(db, row.id) : null, false, await payUrl(db, viewToken), !last5),
      });
      // token 只交給送出的這台裝置：之後用它查進度、開推播；不能用電話或姓名查（避免別人拿走劃位連結）
      return { no, token: viewToken, waitlist: waitlist ? await waitPos(db, row.id) : null }; // 買方看不到金額
    } catch (e) {
      if (!/unique|duplicate/i.test(String((e as Error).message))) throw e;
    }
  }
  throw new BookingError('SERVER', '系統忙碌中，請再送出一次。');
}

/** 候補第幾位（依登記時間） */
async function waitPos(db: Db, id: number) {
  const ev = await currentEvent(db);
  const rows = await db.select({ id: t.preorder.id }).from(t.preorder)
    .where(and(eq(t.preorder.eventId, ev.id), eq(t.preorder.waitlist, true), sql`${t.preorder.status} <> 'cancelled'`)).orderBy(t.preorder.createdAt, t.preorder.id);
  return rows.findIndex((r) => r.id === id) + 1;
}

/** 候補轉正取（老大按） */
export async function promoteWaitlist(db: Db, actor: string, id: number) {
  await db.update(t.preorder).set({ waitlist: false }).where(eq(t.preorder.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_promote', target: `preorder:${id}` });
}

export const itemsText = (items: t.PreorderItem[]) => items.map((x) => `${x.name} × ${x.qty}`).join('、');

export const itemKey = (i: { kind: string; id: number }) => `${i.kind}:${i.id}`;

export async function listPreorders(db: Db) {
  const ev = await currentEvent(db);
  // 三樓刷卡單（source=card）不進「四、訂單核帳」
  const rows = await db.select().from(t.preorder).where(and(eq(t.preorder.eventId, ev.id), sql`${t.preorder.source} <> 'card'`)).orderBy(desc(t.preorder.id));
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
    seq: seq.get(r.id) ?? null, lineName: r.lineName, waitlist: r.waitlist, paidOkAt: r.paidOkAt?.toISOString() ?? null, paidOkBy: r.paidOkBy, lineOk: r.lineOk,
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
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項（${itemsText(po.items)}）。請點以下專屬連結選座位並確認出席貴賓：${url}　連結有效至演出當天，請勿轉傳他人。`,
  });
  if (!fromForm) await db.insert(t.notification).values({
    linkId: link.id, channel: 'email', template: 'preorder_link', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項（登記編號 ${po.no}：${itemsText(po.items)}）。請點以下專屬連結選座位並確認出席貴賓：${url}　連結有效至演出當天，請勿轉傳他人。`,
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

/**
 * 後台設定／修改訂單的內容與份數（表單來的沒有數量；或買方誤填）。
 * 已發劃位連結的也能改：劃位頁的上限立刻跟著變。
 * 不能改到比已劃（含劃位中）的還少，也不能拿掉已劃過的項目。
 */
export async function setPreorderItems(db: Db, actor: string, id: number, pick: { kind: 'combo' | 'zone'; id: number; qty: number }[], now = new Date()) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這張訂單已取消');
  const menu = await preorderMenuFull(db);
  const items: t.PreorderItem[] = [];
  for (const it of pick.filter((x) => x.qty > 0)) {
    const m = menu.items.find((x) => x.kind === it.kind && x.id === it.id) ?? po.items.find((x) => x.kind === it.kind && x.id === it.id);
    if (!m) throw new BookingError('INVALID', '選擇的項目已變更，請重新整理頁面。');
    items.push({ kind: it.kind, id: it.id, name: m.name, price: m.price, qty: it.qty });
  }
  if (!items.length) throw new BookingError('INVALID', '請至少填一項的數量（整筆不要了請用「取消」）');
  const before = itemsText(po.items);
  const after = itemsText(items);
  if (before === after) throw new BookingError('INVALID', '內容沒有變更');
  if (po.linkId) {
    const e = await linkEntitle(db, po.linkId, items);
    if (e?.over) {
      const used = (await linkEntitle(db, po.linkId, po.items))?.rows.filter((r) => r.used > 0).map((r) => `${r.name} ${r.used} ${r.unit}`).join('、');
      throw new BookingError('INVALID', `他已經劃了（含劃位中）${used || '其他項目'}，不能改得比這更少。請先在劃位頁或後台取消多的座位再改。`);
    }
  }
  // 已發出的項目維持已發（數量改了上限立刻生效）；新加的項目要再到「五」發出
  const done = po.released ?? (po.linkId ? po.items.map(itemKey) : []);
  const released = po.linkId ? done.filter((k) => items.some((i) => itemKey(i) === k)) : po.released;
  const stamp = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const note = po.items.length ? `${po.note ? `${po.note}\n` : ''}${stamp} ${actor} 改份數：${before} → ${after}`.slice(-1000) : po.note;
  await db.update(t.preorder).set({ items, amount: items.reduce((a, x) => a + x.price * x.qty, 0), released, note }).where(eq(t.preorder.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_items', target: `preorder:${id}`, detail: `${before} → ${after}` });
  const cap = await capacityOf(db);
  const full = items.filter((i) => i.kind === 'combo' && !po.waitlist && cap[i.id] && cap[i.id].used > cap[i.id].limit)
    .map((i) => `${i.name} 已超過名額（${cap[i.id].used}／${cap[i.id].limit}）`);
  const added = po.linkId ? items.filter((i) => !(released ?? []).includes(itemKey(i))).map((i) => i.name) : [];
  return { warn: [...full, ...(added.length ? [`新加的 ${added.join('、')} 還沒發，請到「五」發出`] : [])].join('；') };
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
    content: `【${ev.name}】${po.name} 您好，已確認收到您的款項，現在輪到您劃位：${itemsText(rel)}。請點以下專屬連結選座位並確認出席貴賓：${url}　${rest.length ? `${itemsText(rest)} 輪到時會再通知您，用同一個連結劃位。` : ''}連結有效至演出當天，請勿轉傳他人。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_release', target: `preorder:${id}`, detail: JSON.stringify({ link: code, items: rel.map(itemKey) }) });
  return { code, linkId, email: po.email, items: itemsText(rel), rest: itemsText(rest) };
}

/** 改 Email（買方打錯時）；已發過劃位連結的，可以順便補寄一封到新信箱 */
/** 「已收到您的認購登記」確認信內容（送出時與後台補寄共用；不含金額） */
function receivedText(ev: { name: string; bankName: string; bankAccount: string; accountName: string }, name: string, no: string, items: t.PreorderItem[], wait: number | null, again = false, pay = '', noLast5 = false) {
  const tag = again ? '（補寄）' : '';
  const fill = pay ? (noLast5
    ? `　您尚未填寫匯款帳號後五碼：匯款後，請點以下連結填寫，方便我們核對款項：${pay}`
    : `　如果匯款帳號與登記時不同，或分成多筆匯款，請點以下連結更正後五碼：${pay}`) : '';
  return wait
    ? `【${ev.name}】${name} 您好，已收到您的認購登記 ${no}${tag}：${itemsText(items)}。目前為候補第 ${wait} 位，有名額釋出時，我們會依序與您聯繫，感恩您的耐心等候。`
    : `【${ev.name}】${name} 您好，已收到您的認購登記 ${no}${tag}：${itemsText(items)}，感恩您的護持。請依以下帳戶完成匯款：${ev.bankName} 帳號 ${ev.bankAccount}，戶名 ${ev.accountName}。主辦方確認款項、並依登記順序輪到您時，會由寄這封信的同一個信箱寄出「劃位通知」。若沒看到，請查看垃圾郵件匣，並建議先把這個信箱加入聯絡人。${fill}`;
}

/** 買方自己補填／更正後五碼的網址（確認信裡附上） */
async function payUrl(db: Db, token: string) {
  return `${await siteOrigin(db)}/buy/pay/${token}`;
}

const remitsBody = z.array(z.object({
  last5: z.string().trim().regex(/^\d{5}$/, '匯款帳號後五碼應為 5 位數字'),
  amount: z.number().int().min(1, '請填寫每一筆的匯款金額').max(10_000_000),
})).max(5);

async function saveRemits(db: Db, po: typeof t.preorder.$inferSelect, raw: unknown, actor: string, by: string) {
  const p = remitsBody.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
  const remits = p.data;
  const last5 = formatRemits(remits);
  const paidAmount = remits.length ? remits.reduce((a, r) => a + r.amount, 0) : po.paidAmount;
  if (last5 === po.last5 && paidAmount === po.paidAmount) throw new BookingError('INVALID', '內容沒有變更');
  const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const note = `${po.note ? `${po.note}\n` : ''}${stamp} ${by}改後五碼：${po.last5 || '（未填）'} → ${last5 || '（未填）'}`.slice(-1000);
  await db.update(t.preorder).set({ last5, paidAmount, note }).where(eq(t.preorder.id, po.id));
  await db.insert(t.auditLog).values({ actor, action: 'preorder_last5', target: `preorder:${po.id}`, detail: `${po.last5} → ${last5}` });
  return { last5 };
}

/** 後台補填／修改後五碼（可多筆，各自金額） */
export async function setPreorderRemits(db: Db, actor: string, id: number, remits: unknown) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這張訂單已取消');
  return saveRemits(db, po, remits, actor, `${actor} `);
}

/** 買方用確認信裡的連結查看自己的登記（只認隨機碼） */
export async function payInfo(db: Db, token: string) {
  if (!/^[\w-]{20,40}$/.test(token)) throw new BookingError('NOT_FOUND', '連結不正確');
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.viewToken, token));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這筆認購登記，請確認連結是否完整');
  const ev = await currentEvent(db);
  return {
    no: po.no, name: po.name, items: itemsText(po.items), status: po.status,
    locked: po.status === 'cancelled' ? '這筆登記已取消。' : po.paidOkAt ? '主辦方已核對到您的款項，不需要再填寫。' : '',
    remits: parseRemits(po.last5, po.paidAmount), bank: { name: ev.bankName, account: ev.bankAccount, holder: ev.accountName },
  };
}

/** 買方自己補填／更正後五碼（已核對收款或已取消就不能再改） */
export async function payUpdate(db: Db, token: string, remits: unknown) {
  if (!/^[\w-]{20,40}$/.test(token)) throw new BookingError('NOT_FOUND', '連結不正確');
  const [po] = await db.select().from(t.preorder).where(eq(t.preorder.viewToken, token));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這筆認購登記');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這筆登記已取消');
  if (po.paidOkAt) throw new BookingError('INVALID', '主辦方已核對到您的款項，不需要再填寫。如需更正請與主辦方聯繫。');
  if (!Array.isArray(remits) || !remits.length) throw new BookingError('INVALID', '請至少填一筆匯款帳號後五碼');
  return saveRemits(db, po, remits, 'buyer', '買方');
}

/** 後台補寄「已收到您的認購登記」確認信，寄到這筆訂單目前的 Email */
export async function resendReceived(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status === 'cancelled') throw new BookingError('INVALID', '這張訂單已取消');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(po.email ?? '')) throw new BookingError('INVALID', '這筆訂單沒有正確的 Email，請先按「改 Email」');
  const wait = po.waitlist ? await waitPos(db, po.id) : null;
  const [n] = await db.insert(t.notification).values({
    channel: 'email', template: 'preorder_received', recipient: po.email, content: receivedText(ev, po.name, po.no, po.items, wait, true, po.viewToken ? await payUrl(db, po.viewToken) : '', !po.last5),
  }).returning({ id: t.notification.id });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_resend_received', target: `preorder:${id}`, detail: JSON.stringify({ to: po.email }) });
  return { notificationId: n.id, email: po.email };
}

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
    content: `【${ev.name}】${po.name} 您好，這是您的專屬劃位連結（補寄）：${itemsText(rel)}。請點以下連結選座位並確認出席貴賓：${linkUrl(l.code, base)}　請勿轉傳他人。`,
  });
  return { linkId: po.linkId, resent: true };
}

export async function cancelPreorder(db: Db, actor: string, id: number, reason = '') {
  reason = reason.trim();
  if (reason.length < 2) throw new BookingError('INVALID', '請填寫取消原因');
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status !== 'submitted') throw new BookingError('INVALID', '只有待確認的訂單可以取消');
  const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const note = `${po.note ? `${po.note}\n` : ''}${stamp} ${actor} 取消${reason ? `：${reason}` : ''}`.slice(-1000);
  await db.update(t.preorder).set({ status: 'cancelled', note, seenAt: po.seenAt ?? new Date() }).where(eq(t.preorder.id, id));
  if (po.source !== 'form') await db.insert(t.notification).values({
    channel: 'email', template: 'preorder_cancelled', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，您的認購登記 ${po.no} 已取消${reason ? `（${reason}）` : ''}。如有疑問或已匯款，請聯繫主辦方。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_cancel', target: `preorder:${id}`, detail: JSON.stringify({ reason }) });
}

/** 恢復誤按取消的登記（回到待核帳，順位不變）；可選擇寄「登記已恢復」信 */
export async function restorePreorder(db: Db, actor: string, id: number, notify: boolean) {
  const ev = await currentEvent(db);
  const [po] = await db.select().from(t.preorder).where(and(eq(t.preorder.id, id), eq(t.preorder.eventId, ev.id)));
  if (!po) throw new BookingError('NOT_FOUND', '找不到這張訂單');
  if (po.status !== 'cancelled') throw new BookingError('INVALID', '這張訂單沒有取消');
  const stamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const note = `${po.note ? `${po.note}\n` : ''}${stamp} ${actor} 恢復（取消前的狀態）`.slice(-1000);
  await db.update(t.preorder).set({ status: 'submitted', note }).where(eq(t.preorder.id, id));
  if (notify && po.source !== 'form' && po.email) await db.insert(t.notification).values({
    channel: 'email', template: 'preorder_restored', recipient: po.email,
    content: `【${ev.name}】${po.name} 您好，先前寄給您的「認購登記 ${po.no} 已取消」通知是我們作業疏失，非常抱歉。您的登記（${itemsText(po.items)}）仍然有效，順序不變，請不用重新登記。主辦方確認款項、並依登記順序輪到您時，會寄出劃位通知。`,
  });
  await db.insert(t.auditLog).values({ actor, action: 'preorder_restore', target: `preorder:${id}`, detail: JSON.stringify({ notify }) });
  const cap = await capacityOf(db);
  const over = po.waitlist ? [] : po.items.filter((i) => i.kind === 'combo' && cap[i.id] && cap[i.id].used > cap[i.id].limit).map((i) => `${i.name} 已超過名額（${cap[i.id].used}／${cap[i.id].limit}）`);
  return { warn: over.join('；') };
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
