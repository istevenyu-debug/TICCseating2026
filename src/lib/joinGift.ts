/**
 * 揪團贈席的取票方式（11/19）：
 * - 後台設定取票選項（做活的：可新增、修改、停用、排序）。類型 qr＝電子票 QR；paper＝紙本（微風小站、郵寄、現場…）。
 * - 寄「贈票領取方式」調查信給負責人（可先寄單一群測試，再一鍵寄全部；全部只寄還沒寄過的）。
 * - 負責人在劃位頁每席選擇方式、填實際入座的人（預設負責人）；QR 可填 Email，存檔時寄一次 QR 信。
 * - 回覆截止＝調查信寄出時間＋設定的小時數；逾期沒選＝預設選項。截止後只能改姓名、Email，不能改方式（後台可改）。
 * - 每席只有一種入場方式：紙本的不出 QR；改姓名或改成紙本時 QR 換新版，舊的失效。
 * - 驗票：序號 JG<劃位序 3 碼>-<版本>，與一般票共用「九、驗票」。
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { seatLabel } from './layout';
import { clean, emailRe, ev0, getJoinSettings, pickUrl } from './join';
import { qrSecret, qrValue } from './qr';
import { normalizePhone } from './validation';

export type GiftKind = 'qr' | 'paper';
export interface GiftOption { key: string; name: string; desc: string; kind: GiftKind; needAddress: boolean; active: boolean }
export interface GiftSettings { options: GiftOption[]; hours: number; defaultKey: string }

const KEY = 'join.gift';

export const DEFAULT_GIFT: GiftSettings = {
  options: [
    { key: 'qr', name: '改用本活動專屬電子票 QR code（推薦）', desc: '免領取、免排隊。劃位頁立刻看得到 QR，可用 LINE 轉給同行親友，入場時出示手機即可。', kind: 'qr', needAddress: false, active: true },
    { key: 'shop', name: '到微風小站領紙本票', desc: '領取時間另行通知。', kind: 'paper', needAddress: false, active: true },
    { key: 'mail', name: '郵寄紙本票', desc: '郵資 50 元自付。', kind: 'paper', needAddress: true, active: true },
    { key: 'onsite', name: '12/9（三）現場取票', desc: '開場前可能需要排隊。', kind: 'paper', needAddress: false, active: true },
  ],
  hours: 24,
  defaultKey: 'qr',
};

const optionSchema = z.object({
  key: z.string().regex(/^[a-z0-9]{0,12}$/).default(''),
  name: z.string().transform(clean).pipe(z.string().min(1, '選項名稱不能空白').max(40, '選項名稱最多 40 字')),
  desc: z.string().transform(clean).pipe(z.string().max(120, '說明最多 120 字')).default(''),
  kind: z.enum(['qr', 'paper']),
  needAddress: z.boolean().default(false),
  active: z.boolean().default(true),
});
const settingsSchema = z.object({
  options: z.array(optionSchema).min(1, '至少要有一個選項').max(10, '最多 10 個選項'),
  hours: z.number().int().min(1, '回覆時間至少 1 小時').max(720, '回覆時間最多 720 小時'),
  defaultKey: z.string().max(12),
});

export async function getGiftSettings(db: Db): Promise<GiftSettings> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY));
  if (!r?.value) return DEFAULT_GIFT;
  try {
    const p = settingsSchema.safeParse(JSON.parse(r.value));
    if (!p.success || p.data.options.some((o) => !o.key)) return DEFAULT_GIFT;
    return p.data as GiftSettings;
  } catch { return DEFAULT_GIFT; }
}

/** 儲存取票選項。已有人選的選項不能刪、不能改類型（只能停用） */
export async function saveGiftSettings(db: Db, actor: string, raw: unknown) {
  const p = settingsSchema.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '設定格式不正確');
  const old = await getGiftSettings(db);
  const used = await usedKeys(db);
  const options: GiftOption[] = [];
  for (const o of p.data.options) {
    const key = o.key || randomBytes(4).toString('hex').slice(0, 6);
    if (options.some((x) => x.key === key)) throw new BookingError('INVALID', '選項代號重複，請重新整理後再試');
    options.push({ ...o, key, needAddress: o.kind === 'paper' && o.needAddress });
  }
  for (const [key, n] of used) {
    const now = options.find((o) => o.key === key);
    const before = old.options.find((o) => o.key === key);
    if (!now) throw new BookingError('INVALID', `「${before?.name ?? key}」已有 ${n} 席選擇，不能刪除，請改成「停用」。`);
    if (before && before.kind !== now.kind) throw new BookingError('INVALID', `「${before.name}」已有 ${n} 席選擇，不能改類型（QR／紙本）。`);
  }
  const def = options.find((o) => o.key === p.data.defaultKey);
  if (!def || !def.active) throw new BookingError('INVALID', '請選一個啟用中的「逾期未回覆」預設選項');
  const value: GiftSettings = { options, hours: p.data.hours, defaultKey: def.key };
  await db.insert(t.appSetting).values({ key: KEY, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: t.appSetting.key, set: { value: JSON.stringify(value) } });
  await db.insert(t.auditLog).values({ actor, action: 'join_gift_settings', target: 'app_setting', detail: JSON.stringify(value) });
  return value;
}

async function usedKeys(db: Db) {
  const rows = await db.select({ k: t.joinGift.optionKey, n: sql<number>`count(*)::int` }).from(t.joinGift)
    .where(sql`${t.joinGift.optionKey} <> ''`).groupBy(t.joinGift.optionKey);
  return new Map(rows.map((r) => [r.k, r.n]));
}

/* ---------- 共用 ---------- */

export const giftSerial = (no: number, ver: number) => `JG${String(no).padStart(3, '0')}-${ver}`;
export const isGiftSerial = (s: string) => /^JG\d{3,}-\d+$/.test(s);
export const giftUrl = (base: string, code: string) => `${base}/join/q/${code}`;
const newCode = () => randomBytes(12).toString('base64url');
/** 入座者是不是群主本人（比對時去空白） */
export const isSelf = (name: string, headName: string) => clean(name).replace(/\s/g, '') === clean(headName).replace(/\s/g, '');
export const deadlineOf = (sentAt: Date | null, hours: number) => (sentAt ? new Date(sentAt.getTime() + hours * 3600_000) : null);

type Gift = typeof t.joinGift.$inferSelect;
type Reg = typeof t.joinReg.$inferSelect;

/** 實際適用的方式：有選用選的；沒選但已過截止用預設；否則尚未決定 */
export function effectiveOf(g: Gift, reg: Pick<Reg, 'giftSentAt'> | undefined, s: GiftSettings, now: Date) {
  const chosen = g.optionKey ? s.options.find((o) => o.key === g.optionKey) : undefined;
  if (chosen) return { opt: chosen, defaulted: false };
  const dl = deadlineOf(reg?.giftSentAt ?? null, s.hours);
  if (dl && now > dl) {
    const def = s.options.find((o) => o.key === s.defaultKey);
    if (def) return { opt: def, defaulted: true };
  }
  return { opt: null as GiftOption | null, defaulted: false };
}

/** 已選位（done、有座位）的劃位序都要有一筆取票資料；沒有的補上（入座者預設負責人） */
export async function ensureGifts(db: Db, eventId: number) {
  const missing = await db.select({ id: t.joinSlot.id, regId: t.joinSlot.regId }).from(t.joinSlot)
    .leftJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id))
    .where(and(eq(t.joinSlot.eventId, eventId), eq(t.joinSlot.status, 'done'), sql`${t.joinSlot.seatId} is not null`, sql`${t.joinGift.slotId} is null`));
  if (!missing.length) return 0;
  const regs = await db.select({ id: t.joinReg.id, headName: t.joinReg.headName }).from(t.joinReg).where(inArray(t.joinReg.id, [...new Set(missing.map((m) => m.regId))]));
  for (const m of missing) {
    await db.insert(t.joinGift).values({ slotId: m.id, eventId, name: regs.find((r) => r.id === m.regId)?.headName ?? '', code: newCode() }).onConflictDoNothing();
  }
  return missing.length;
}

/** 某些群（或全部）的已選位座位＋取票資料 */
async function seatRows(db: Db, eventId: number, regIds?: number[]) {
  await ensureGifts(db, eventId);
  return db.select({
    slot: t.joinSlot, gift: t.joinGift,
    rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code, entrance: t.venueSeat.entrance, x: t.venueSeat.x, y: t.venueSeat.y,
  }).from(t.joinSlot)
    .innerJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id))
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.joinSlot.seatId))
    .where(and(eq(t.joinSlot.eventId, eventId), eq(t.joinSlot.status, 'done'), regIds ? inArray(t.joinSlot.regId, regIds.length ? regIds : [0]) : undefined))
    .orderBy(asc(t.venueSeat.y), asc(t.venueSeat.x));
}

async function enteredSerials(db: Db, eventId: number, serials: string[]) {
  if (!serials.length) return new Map<string, Date>();
  const rows = await db.select({ serial: t.checkin.serial, at: t.checkin.at }).from(t.checkin)
    .where(and(eq(t.checkin.eventId, eventId), inArray(t.checkin.serial, serials)));
  return new Map(rows.map((r) => [r.serial, r.at]));
}

async function groupName(db: Db, r: Reg) {
  if (!r.venueId) return r.venueText;
  const [v] = await db.select().from(t.joinVenue).where(eq(t.joinVenue.id, r.venueId));
  return v?.name ?? r.venueText;
}

/* ---------- 負責人劃位頁 ---------- */

/** 劃位頁「贈票取票方式」區塊。調查信還沒寄出前不顯示（null） */
export async function giftForLeader(db: Db, reg: Reg, now = new Date(), base = '') {
  if (!reg.giftSentAt) return null;
  const s = await getGiftSettings(db);
  const rows = await seatRows(db, reg.eventId, [reg.id]);
  if (!rows.length) return null;
  const secret = await qrSecret(db);
  const dl = deadlineOf(reg.giftSentAt, s.hours)!;
  const entered = await enteredSerials(db, reg.eventId, rows.map((r) => giftSerial(r.slot.no, r.gift.ver)));
  const usedHere = new Set(rows.map((r) => r.gift.optionKey).filter(Boolean));
  return {
    deadline: dl.toISOString(), open: now <= dl, defaultName: s.options.find((o) => o.key === s.defaultKey)?.name ?? '',
    options: s.options.filter((o) => o.active || usedHere.has(o.key)),
    seats: rows.map((r) => {
      const e = effectiveOf(r.gift, reg, s, now);
      const serial = giftSerial(r.slot.no, r.gift.ver);
      const qr = e.opt?.kind === 'qr';
      // 群主自己持有（入座者＝群主）才在群主頁顯示 QR；設給別人的只寄到對方信箱，群主頁不給 QR
      const self = isSelf(r.gift.name, reg.headName);
      return {
        slotId: r.slot.id, no: r.slot.no, label: seatLabel(r), optionKey: r.gift.optionKey, effectiveKey: e.opt?.key ?? '', defaulted: e.defaulted,
        name: r.gift.name, email: r.gift.email, phone: r.gift.phone, address: r.gift.address, self, isQr: qr, serial: qr ? serial : '',
        qr: qr && self ? { serial, value: qrValue(secret, serial), url: base ? giftUrl(base, r.gift.code) : `/join/q/${r.gift.code}` } : null,
        mailedTo: qr && r.gift.mailedVer === r.gift.ver ? r.gift.mailedTo : '', entered: entered.get(serial)?.toISOString() ?? null,
      };
    }),
  };
}

const seatInput = z.object({
  slotId: z.number().int().positive(),
  optionKey: z.string().max(12).default(''),
  name: z.string().transform(clean).pipe(z.string().min(1, '請填寫每一席入座者的姓名').max(30, '姓名最多 30 字')),
  email: z.string().trim().max(120).default(''),
  phone: z.string().transform(normalizePhone).default(''),
  address: z.string().transform(clean).pipe(z.string().max(150)).default(''),
});
const saveInput = z.object({ seats: z.array(seatInput).min(1).max(60) });

/**
 * 儲存取票方式（負責人：只能改自己群、截止後不能改方式；後台 admin=true：不受截止限制）。
 * 回傳寄出 QR 信的席數。
 */
export async function saveGiftSeats(db: Db, actor: string, regId: number | null, raw: unknown, now = new Date(), base = '', admin = false) {
  const p = saveInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const ev = await ev0(db);
  const s = await getGiftSettings(db);
  const js = await getJoinSettings(db);
  const ids = [...new Set(p.data.seats.map((x) => x.slotId))];
  await ensureGifts(db, ev.id);
  const rows = await db.select({ slot: t.joinSlot, gift: t.joinGift, reg: t.joinReg }).from(t.joinSlot)
    .innerJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id)).innerJoin(t.joinReg, eq(t.joinReg.id, t.joinSlot.regId))
    .where(and(eq(t.joinSlot.eventId, ev.id), inArray(t.joinSlot.id, ids), eq(t.joinSlot.status, 'done')));
  if (rows.length !== ids.length || (regId !== null && rows.some((r) => r.reg.id !== regId))) throw new BookingError('INVALID', '座位資料已變更，請重新整理頁面。');
  const entered = await enteredSerials(db, ev.id, rows.map((r) => giftSerial(r.slot.no, r.gift.ver)));
  const mails: { to: string; content: string }[] = [];
  let changed = 0;
  for (const x of p.data.seats) {
    const r = rows.find((y) => y.slot.id === x.slotId)!;
    const g = r.gift;
    if (!admin && !r.reg.giftSentAt) throw new BookingError('INVALID', '取票方式調查尚未開始。');
    const cur = effectiveOf(g, r.reg, s, now);
    const key = x.optionKey || g.optionKey;
    const opt = key ? s.options.find((o) => o.key === key) : undefined;
    if (key && !opt) throw new BookingError('INVALID', '這個取票方式已不存在，請重新整理頁面。');
    const optChanged = !!opt && opt.key !== (cur.opt?.key ?? '');
    if (optChanged && !admin) {
      const dl = deadlineOf(r.reg.giftSentAt, s.hours);
      if (dl && now > dl) throw new BookingError('INVALID', `已過回覆截止時間，取票方式不能再改。如需更改，請聯絡${js.contact}。`);
      if (!opt!.active) throw new BookingError('INVALID', `「${opt!.name}」目前不開放選擇。`);
    }
    const email = x.email.trim();
    if (email && !emailRe.test(email)) throw new BookingError('INVALID', `${x.name} 的 Email 格式不正確`);
    if (opt?.needAddress) {
      if (x.address.length < 6) throw new BookingError('INVALID', `選「${opt.name}」的座位，請填寫收件地址。`);
      if (!/^09\d{8}$/.test(x.phone)) throw new BookingError('INVALID', `選「${opt.name}」的座位，請填寫收件人手機（09 開頭 10 碼）。`);
    }
    if (!admin && (opt ?? cur.opt)?.kind === 'qr' && !isSelf(x.name, r.reg.headName) && !email) {
      throw new BookingError('INVALID', `${x.name}：設給別人的電子票，請填入座者 Email（電子票只寄給本人）。`);
    }
    const wasQr = cur.opt?.kind === 'qr';
    const nowQr = (opt ?? cur.opt)?.kind === 'qr';
    const nameChanged = x.name !== g.name;
    const serialOld = giftSerial(r.slot.no, g.ver);
    const isIn = entered.has(serialOld);
    if (isIn && wasQr && (nameChanged || !nowQr)) throw new BookingError('INVALID', `第 ${r.slot.no} 號已經入場，不能再改姓名或取票方式。`);
    // 改姓名、或從 QR 改成紙本：QR 換新版、連結換新，舊的失效
    const bump = (nameChanged && wasQr) || (wasQr && !nowQr);
    const set: Partial<typeof t.joinGift.$inferInsert> = {
      name: x.name, email, phone: opt?.needAddress ? x.phone : (x.phone || g.phone), address: opt?.needAddress ? x.address : (x.address || g.address), updatedAt: now,
    };
    if (optChanged || (opt && !g.optionKey)) Object.assign(set, { optionKey: opt!.key, chosenBy: actor, chosenAt: now });
    if (bump) Object.assign(set, { ver: g.ver + 1, code: newCode() });
    const same = set.name === g.name && set.email === g.email && set.phone === g.phone && set.address === g.address && !set.optionKey && !bump;
    if (same) continue;
    const [u] = await db.update(t.joinGift).set(set).where(and(eq(t.joinGift.slotId, g.slotId), eq(t.joinGift.ver, g.ver))).returning();
    if (!u) throw new BookingError('INVALID', '資料剛被更改，請重新整理頁面。');
    changed++;
    // QR 信：是 QR、有 Email、這一版還沒寄到這個信箱 → 寄一次
    if (nowQr && u.email && (u.mailedTo !== u.email || u.mailedVer !== u.ver) && base) {
      mails.push({ to: u.email, content: await qrMailText(db, ev, r.reg, r.slot.no, u, base) });
      await db.update(t.joinGift).set({ mailedTo: u.email, mailedVer: u.ver, mailedAt: now }).where(eq(t.joinGift.slotId, u.slotId));
    }
  }
  for (const m of mails) await db.insert(t.notification).values({ channel: 'email', template: 'join_qr', recipient: m.to, content: m.content });
  // 負責人確認送出：寄一封「已收到您的回覆」給負責人（後台修改不寄；沒有變更不寄）
  if (!admin && regId !== null && changed && base) {
    const reg = rows[0].reg;
    if (reg.email) {
      const now2 = await db.select({ gift: t.joinGift, slot: t.joinSlot }).from(t.joinGift).innerJoin(t.joinSlot, eq(t.joinSlot.id, t.joinGift.slotId))
        .where(and(eq(t.joinSlot.regId, reg.id), eq(t.joinSlot.status, 'done')));
      const seatRowsAll = await seatRows(db, ev.id, [reg.id]);
      const lines = seatRowsAll.map((r) => {
        const g = now2.find((x) => x.gift.slotId === r.slot.id)?.gift ?? r.gift;
        const e = effectiveOf(g, reg, s, now);
        const how = e.opt ? e.opt.name.replace(/（推薦）/, '') : '尚未選擇';
        const to = e.opt?.kind === 'qr' ? (isSelf(g.name, reg.headName) ? '（您本人持有，請在劃位頁查看票卡）' : g.email ? `（電子票已寄到 ${g.email}）` : '') : '';
        return `三樓 ${seatLabel(r)}：${how}・${g.name}${to}`;
      });
      const content = `【${ev.name}】${reg.headName} 您好，已收到您的贈票取票方式回覆，謝謝您。回覆內容：${lines.join('、')}。設給別人的電子票只寄到對方信箱。劃位頁：${pickUrl(base, reg.pickCode ?? '')}`;
      await db.insert(t.notification).values({ channel: 'email', template: 'join_gift_ok', recipient: reg.email, content });
    }
  }
  if (changed) await db.insert(t.auditLog).values({ actor, action: 'join_gift_save', target: regId ? `join_reg:${regId}` : 'join_gift', detail: JSON.stringify({ seats: p.data.seats.map((x) => ({ ...x, address: x.address ? '（已填）' : '' })), mailed: mails.length }) });
  return { changed, mailed: mails.length };
}

async function seatOf(db: Db, seatId: string) {
  const [v] = await db.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType }).from(t.venueSeat).where(eq(t.venueSeat.id, seatId));
  return v ?? { rowNo: null, seatNo: '', seatType: '' };
}

async function qrMailText(db: Db, ev: { name: string; showAt: Date }, reg: Reg, no: number, g: Gift, base: string) {
  const [slot] = await db.select().from(t.joinSlot).where(eq(t.joinSlot.id, g.slotId));
  const seat = slot?.seatId ? seatLabel(await seatOf(db, slot.seatId)) : '';
  const when = ev.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return `【${ev.name}】${g.name} 您好，${await groupName(db, reg)}（負責人 ${reg.headName}）為您保留的座位：三樓 ${seat}。演出時間：${when}・台北國際會議中心 大會堂。這是您的入場電子票，入場時出示 QR code 即可。電子票連結：${giftUrl(base, g.code)}`;
}

/** 重寄某一席的 QR 信（負責人或後台）。只寄 QR、有 Email 的 */
export async function resendGiftQr(db: Db, actor: string, regId: number | null, slotId: number, now = new Date(), base = '') {
  const ev = await ev0(db);
  const s = await getGiftSettings(db);
  const [r] = await db.select({ slot: t.joinSlot, gift: t.joinGift, reg: t.joinReg }).from(t.joinSlot)
    .innerJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id)).innerJoin(t.joinReg, eq(t.joinReg.id, t.joinSlot.regId))
    .where(and(eq(t.joinSlot.id, slotId), eq(t.joinSlot.eventId, ev.id), eq(t.joinSlot.status, 'done')));
  if (!r || (regId !== null && r.reg.id !== regId)) throw new BookingError('NOT_FOUND', '找不到這一席，請重新整理頁面。');
  if (effectiveOf(r.gift, r.reg, s, now).opt?.kind !== 'qr') throw new BookingError('INVALID', '這一席不是電子票 QR，不用寄。');
  if (!r.gift.email) throw new BookingError('INVALID', '這一席沒有填 Email。');
  if (regId !== null && r.gift.mailedAt && now.getTime() - r.gift.mailedAt.getTime() < 120_000) throw new BookingError('TOO_MANY', '剛剛寄過了，請 2 分鐘後再試。');
  if (!base) throw new BookingError('INVALID', '還不知道網站網址，請從正式網址開啟後再試');
  await db.insert(t.notification).values({ channel: 'email', template: 'join_qr', recipient: r.gift.email, content: await qrMailText(db, ev, r.reg, r.slot.no, r.gift, base) });
  await db.update(t.joinGift).set({ mailedTo: r.gift.email, mailedVer: r.gift.ver, mailedAt: now }).where(eq(t.joinGift.slotId, slotId));
  await db.insert(t.auditLog).values({ actor, action: 'join_gift_qr_resend', target: `join_slot:${slotId}`, detail: r.gift.email });
  return { to: r.gift.email };
}

/* ---------- 入座者的電子票頁 /join/q/<code> ---------- */

export async function giftTicketPage(db: Db, code: string, now = new Date()) {
  const [r] = await db.select({ slot: t.joinSlot, gift: t.joinGift, reg: t.joinReg }).from(t.joinGift)
    .innerJoin(t.joinSlot, eq(t.joinSlot.id, t.joinGift.slotId)).innerJoin(t.joinReg, eq(t.joinReg.id, t.joinSlot.regId))
    .where(eq(t.joinGift.code, code));
  const js = await getJoinSettings(db);
  if (!r || r.slot.status !== 'done' || !r.slot.seatId) throw new BookingError('NOT_FOUND', `這個電子票連結已更換或無效，請向負責人索取新連結（或聯絡${js.contact}）。`);
  const s = await getGiftSettings(db);
  const e = effectiveOf(r.gift, r.reg, s, now);
  if (e.opt?.kind !== 'qr') throw new BookingError('NOT_FOUND', `這一席不是電子票（取票方式：${e.opt?.name ?? '尚未選擇'}）。有疑問請洽負責人或${js.contact}。`);
  const ev = await ev0(db);
  const seat = await db.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, entrance: t.venueSeat.entrance }).from(t.venueSeat).where(eq(t.venueSeat.id, r.slot.seatId));
  const serial = giftSerial(r.slot.no, r.gift.ver);
  const [used] = await db.select({ at: t.checkin.at }).from(t.checkin).where(and(eq(t.checkin.eventId, ev.id), eq(t.checkin.serial, serial)));
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() }, group: await groupName(db, r.reg), name: r.gift.name,
    seat: seat[0] ? seatLabel(seat[0]) : '', entrance: seat[0]?.entrance ?? '', serial, value: qrValue(await qrSecret(db), serial),
    entered: used?.at.toISOString() ?? null, contact: js.contact,
  };
}

/* ---------- 驗票 ---------- */

/** 用序號找贈席電子票：只有目前版本、取票方式是 QR、劃位序有效的才算 */
export async function findGiftTicket(db: Db, eventId: number, serial: string, now = new Date()) {
  const m = serial.match(/^JG(\d{3,})-(\d+)$/);
  if (!m) return { ticket: null, reason: '查無此票' };
  const no = parseInt(m[1], 10); const ver = parseInt(m[2], 10);
  const [r] = await db.select({ slot: t.joinSlot, gift: t.joinGift, reg: t.joinReg }).from(t.joinSlot)
    .innerJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id)).innerJoin(t.joinReg, eq(t.joinReg.id, t.joinSlot.regId))
    .where(and(eq(t.joinSlot.eventId, eventId), eq(t.joinSlot.no, no)));
  if (!r || r.slot.status !== 'done' || !r.slot.seatId) return { ticket: null, reason: '此贈席已取消，票券無效' };
  if (r.gift.ver !== ver) return { ticket: null, reason: '此 QR code 已更換（改過姓名），請出示新的 QR code' };
  const s = await getGiftSettings(db);
  const e = effectiveOf(r.gift, r.reg, s, now);
  if (e.opt?.kind !== 'qr') return { ticket: null, reason: e.opt ? `此席已選「${e.opt.name}」（紙本票），請出示紙本票` : '此席尚未選擇取票方式' };
  const [v] = await db.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code }).from(t.venueSeat).where(eq(t.venueSeat.id, r.slot.seatId));
  return {
    ticket: {
      serial, seatId: r.slot.seatId, label: v ? seatLabel(v) : '', code: v?.code ?? '', zoneName: '揪團贈席', holderName: r.gift.name,
      group: await groupName(db, r.reg), no,
    }, reason: '',
  };
}

/** 驗票頁搜尋、斷線入場名單用：所有已選位的贈席（含紙本，紙本 serial 為空） */
export async function giftCheckRows(db: Db, eventId: number, now = new Date()) {
  const s = await getGiftSettings(db);
  const rows = await seatRows(db, eventId);
  const regs = await db.select().from(t.joinReg).where(inArray(t.joinReg.id, [...new Set(rows.map((r) => r.slot.regId))].concat(0)));
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, eventId));
  return rows.map((r) => {
    const reg = regs.find((x) => x.id === r.slot.regId);
    const e = effectiveOf(r.gift, reg, s, now);
    const group = reg ? (reg.venueId ? vs.find((v) => v.id === reg.venueId)?.name ?? reg.venueText : reg.venueText) : '';
    return {
      slotId: r.slot.id, no: r.slot.no, serial: e.opt?.kind === 'qr' ? giftSerial(r.slot.no, r.gift.ver) : '', paper: e.opt?.kind === 'paper' ? e.opt.name : e.opt ? '' : '尚未選擇',
      holderName: r.gift.name, label: seatLabel(r), code: r.code, group, headName: reg?.headName ?? '', headPhone: reg?.headPhone ?? '',
    };
  });
}

/** 已選 QR（含逾期預設）的贈席數：驗票頁「應到」人數用 */
export async function giftQrCount(db: Db, eventId: number, now = new Date()) {
  return (await giftCheckRows(db, eventId, now)).filter((r) => r.serial).length;
}

/* ---------- 調查信 ---------- */

/** 可以寄調查信的群：已核准、有 Email、至少一席已選位 */
async function eligibleRegs(db: Db, eventId: number) {
  const regs = await db.select().from(t.joinReg).where(and(eq(t.joinReg.eventId, eventId), eq(t.joinReg.status, 'approved')));
  const done = await db.select({ regId: t.joinSlot.regId, n: sql<number>`count(*)::int` }).from(t.joinSlot)
    .where(and(eq(t.joinSlot.eventId, eventId), eq(t.joinSlot.status, 'done'), sql`${t.joinSlot.seatId} is not null`)).groupBy(t.joinSlot.regId);
  return regs.map((r) => ({ reg: r, seats: done.find((d) => d.regId === r.id)?.n ?? 0 })).filter((x) => x.seats > 0);
}

/**
 * 寄「贈票領取方式」調查信給負責人。
 * - ids 沒給＝全部：只寄還沒寄過、有 Email 的群（已寄過的一律不再寄）。
 * - ids 給一個＋resend＝重寄那一群（不改截止時間）。
 * - dry＝只算會寄給誰，不寄。
 */
export async function sendGiftSurvey(db: Db, actor: string, base: string, o: { ids?: number[]; resend?: boolean; dry?: boolean } = {}, now = new Date()) {
  const ev = await ev0(db);
  if (!base && !o.dry) throw new BookingError('INVALID', '還不知道網站網址，請從正式網址開啟後台再試');
  if (o.resend && o.ids?.length !== 1) throw new BookingError('INVALID', '重寄只能一次一群');
  if (o.ids && !o.ids.length) throw new BookingError('INVALID', '請選擇要寄的群');
  const s = await getGiftSettings(db);
  const def = s.options.find((x) => x.key === s.defaultKey);
  const list = (await eligibleRegs(db, ev.id)).filter((x) => !o.ids || o.ids.includes(x.reg.id));
  const targets = list.filter((x) => x.reg.email && x.reg.pickCode && (o.resend || !x.reg.giftSentAt));
  const skipped = { noEmail: list.filter((x) => !x.reg.email).length, sent: list.filter((x) => x.reg.email && x.reg.giftSentAt && !o.resend).length };
  if (o.dry) return { count: targets.length, names: targets.map((x) => x.reg.headName), skipped };
  if (o.ids && !targets.length) throw new BookingError('INVALID', skipped.sent ? '這一群已經寄過了；要再寄請按「重寄」。' : skipped.noEmail ? '這一群沒有 Email，請複製連結用 LINE 傳。' : '這一群還沒有選好的座位，不用寄。');
  let count = 0;
  for (const x of targets) {
    // 先標記已寄（只有標記成功的才寄），避免同時按兩次寄兩封
    const sentAt = x.reg.giftSentAt ?? now;
    const upd = o.resend
      ? await db.update(t.joinReg).set({ giftSentAt: sentAt }).where(eq(t.joinReg.id, x.reg.id)).returning({ id: t.joinReg.id })
      : await db.update(t.joinReg).set({ giftSentAt: now }).where(and(eq(t.joinReg.id, x.reg.id), sql`${t.joinReg.giftSentAt} is null`)).returning({ id: t.joinReg.id });
    if (!upd.length) continue;
    const dl = deadlineOf(sentAt, s.hours)!;
    const fmt = dl.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const opts = s.options.filter((y) => y.active).map((y, i) => `${'①②③④⑤⑥⑦⑧⑨⑩'[i]} ${y.name}${y.desc ? `：${y.desc}` : ''}`).join('　');
    const content = `【${ev.name}】${x.reg.headName} 您好，感謝您協助揪團！${await groupName(db, x.reg)} 的 ${x.seats} 席贈席已劃位完成。請在 ${fmt} 前，為每一席選擇取票方式，並填寫實際入座的貴賓姓名（預設為您）。可選擇：　${opts}　逾期未回覆將視為選擇「${def?.name ?? ''}」。請點以下連結選擇：${pickUrl(base, x.reg.pickCode!)}`;
    await db.insert(t.notification).values({ channel: 'email', template: 'join_gift', recipient: x.reg.email, content });
    count++;
  }
  await db.insert(t.auditLog).values({ actor, action: o.resend ? 'join_gift_survey_resend' : 'join_gift_survey', target: o.ids ? `join_reg:${o.ids.join(',')}` : 'all', detail: JSON.stringify({ count, skipped }) });
  return { count, skipped };
}

/* ---------- 後台 ---------- */

export async function giftAdminState(db: Db, base: string, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  const settings = await getGiftSettings(db);
  if (!ev) return { testUntil: '', testOpen: false, settings, groups: [], seats: [], tally: [], undecided: 0, sendable: 0 };
  const rows = await seatRows(db, ev.id);
  const regs = await db.select().from(t.joinReg).where(eq(t.joinReg.eventId, ev.id));
  const vs = await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, ev.id));
  const gname = (r: Reg) => (r.venueId ? vs.find((v) => v.id === r.venueId)?.name ?? r.venueText : r.venueText);
  const entered = await enteredSerials(db, ev.id, rows.map((r) => giftSerial(r.slot.no, r.gift.ver)));
  const seats = rows.map((r) => {
    const reg = regs.find((x) => x.id === r.slot.regId)!;
    const e = effectiveOf(r.gift, reg, settings, now);
    const serial = giftSerial(r.slot.no, r.gift.ver);
    return {
      slotId: r.slot.id, no: r.slot.no, regId: reg.id, group: gname(reg), headName: reg.headName, label: seatLabel(r), rowNo: r.rowNo, seatNo: r.seatNo,
      optionKey: r.gift.optionKey, effectiveKey: e.opt?.key ?? '', defaulted: e.defaulted, kind: e.opt?.kind ?? '',
      name: r.gift.name, email: r.gift.email, phone: r.gift.phone, address: r.gift.address,
      serial: e.opt?.kind === 'qr' ? serial : '', url: base ? giftUrl(base, r.gift.code) : '', mailedAt: r.gift.mailedVer === r.gift.ver ? r.gift.mailedAt?.toISOString() ?? null : null,
      entered: e.opt?.kind === 'qr' ? entered.get(serial)?.toISOString() ?? null : null, chosenBy: r.gift.chosenBy, chosenAt: r.gift.chosenAt?.toISOString() ?? null,
    };
  });
  const groupIds = [...new Set(rows.map((r) => r.slot.regId))];
  const allIn = await db.select({ serial: t.checkin.serial }).from(t.checkin).where(and(eq(t.checkin.eventId, ev.id), eq(t.checkin.orderId, 0), sql`${t.checkin.serial} like 'JG%'`));
  const checkinsByReg = new Map<number, number>();
  for (const c of allIn) {
    const no = parseInt(c.serial.slice(2), 10);
    const r = rows.find((x) => x.slot.no === no);
    if (r) checkinsByReg.set(r.slot.regId, (checkinsByReg.get(r.slot.regId) ?? 0) + 1);
  }
  const groups = groupIds.map((id) => {
    const r = regs.find((x) => x.id === id)!;
    const mine = seats.filter((x) => x.regId === id);
    return {
      regId: id, group: gname(r), headName: r.headName, email: r.email, seats: mine.length, decided: mine.filter((x) => x.effectiveKey).length,
      sentAt: r.giftSentAt?.toISOString() ?? null, deadline: deadlineOf(r.giftSentAt, settings.hours)?.toISOString() ?? null,
      pickUrl: r.pickCode && base ? pickUrl(base, r.pickCode) : '',
      checkins: checkinsByReg.get(id) ?? 0,
    };
  }).sort((a, b) => a.group.localeCompare(b.group, 'zh-Hant'));
  const tally = settings.options.map((o) => ({ key: o.key, name: o.name, kind: o.kind, active: o.active, seats: seats.filter((x) => x.effectiveKey === o.key).length, groups: new Set(seats.filter((x) => x.effectiveKey === o.key).map((x) => x.regId)).size }));
  const until = await testUntil(db);
  return {
    testUntil: until.toISOString(), testOpen: now < until,
    settings, groups, seats, tally, undecided: seats.filter((x) => !x.effectiveKey).length,
    sendable: groups.filter((g) => g.email && !g.sentAt).length,
  };
}

/* ---------- 測試用：重設一群、刪除全部入場紀錄（截止時間前才能用） ---------- */

const TEST_KEY = 'checkin.testUntil';

/** 測試清除的截止時間：預設演出當天 16:00（台北） */
export async function testUntil(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, TEST_KEY));
  if (r?.value && !Number.isNaN(Date.parse(r.value))) return new Date(r.value);
  const ev = await ev0(db);
  const d = ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  return new Date(`${d}T16:00:00+08:00`);
}
export async function setTestUntil(db: Db, actor: string, iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BookingError('INVALID', '時間格式不正確');
  await db.insert(t.appSetting).values({ key: TEST_KEY, value: d.toISOString() }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: d.toISOString() } });
  await db.insert(t.auditLog).values({ actor, action: 'checkin_test_until', target: 'app_setting', detail: d.toISOString() });
  return { until: d.toISOString() };
}
async function mustBeforeTestUntil(db: Db, now: Date) {
  const u = await testUntil(db);
  if (now >= u) throw new BookingError('INVALID', `已過 ${u.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}，測試用的清除功能已停用（個別入場紀錄仍可撤銷）。`);
}

/**
 * 重設一群（重新測試）：回到「還沒寄調查信」。取票方式、入座者、Email 清空（姓名回到負責人），
 * 版本號繼續往上加（舊 QR、截圖永遠失效），一併刪除這群的贈席入場紀錄。不寄任何信。
 */
export async function resetGiftGroup(db: Db, actor: string, regId: number, now = new Date()) {
  await mustBeforeTestUntil(db, now);
  const ev = await ev0(db);
  const [reg] = await db.select().from(t.joinReg).where(and(eq(t.joinReg.id, regId), eq(t.joinReg.eventId, ev.id)));
  if (!reg) throw new BookingError('NOT_FOUND', '找不到這一群');
  await ensureGifts(db, ev.id);
  const rows = await db.select({ slot: t.joinSlot, gift: t.joinGift }).from(t.joinSlot).innerJoin(t.joinGift, eq(t.joinGift.slotId, t.joinSlot.id)).where(eq(t.joinSlot.regId, regId));
  let checkins = 0;
  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx.update(t.joinGift).set({
        optionKey: '', name: reg.headName, email: '', phone: '', address: '', ver: r.gift.ver + 1, code: newCode(),
        chosenBy: '', chosenAt: null, mailedTo: '', mailedVer: 0, mailedAt: null, updatedAt: now,
      }).where(eq(t.joinGift.slotId, r.slot.id));
      const del = await tx.delete(t.checkin).where(and(eq(t.checkin.eventId, ev.id), eq(t.checkin.orderId, 0), sql`${t.checkin.serial} like ${`JG${String(r.slot.no).padStart(3, '0')}-%`}`)).returning({ id: t.checkin.id });
      checkins += del.length;
    }
    await tx.update(t.joinReg).set({ giftSentAt: null }).where(eq(t.joinReg.id, regId));
    await tx.insert(t.auditLog).values({ actor, action: 'join_gift_reset', target: `join_reg:${regId}`, detail: JSON.stringify({ seats: rows.length, checkins }) });
  });
  return { seats: rows.length, checkins };
}

/** 這一群目前有幾筆贈席入場紀錄（重設前的確認畫面用） */
export async function giftCheckinsOf(db: Db, regId: number) {
  const slots = await db.select({ no: t.joinSlot.no }).from(t.joinSlot).where(eq(t.joinSlot.regId, regId));
  if (!slots.length) return 0;
  const rows = await db.select({ serial: t.checkin.serial }).from(t.checkin).where(and(eq(t.checkin.orderId, 0), sql`${t.checkin.serial} like 'JG%'`));
  const pre = slots.map((x) => `JG${String(x.no).padStart(3, '0')}-`);
  return rows.filter((r) => pre.some((p) => r.serial.startsWith(p))).length;
}

/** 刪除全部入場紀錄（下週測驗票用）。截止時間後停用 */
export async function clearAllCheckins(db: Db, actor: string, now = new Date()) {
  await mustBeforeTestUntil(db, now);
  const ev = await ev0(db);
  const del = await db.delete(t.checkin).where(eq(t.checkin.eventId, ev.id)).returning({ id: t.checkin.id });
  await db.insert(t.auditLog).values({ actor, action: 'checkin_clear_all', target: 'checkin', detail: JSON.stringify({ count: del.length }) });
  return { count: del.length };
}
