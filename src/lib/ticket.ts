/**
 * 入場 QR code 與驗票。
 * QR 內容：TICC|序號|簽章。簽章是用只存在資料庫的密鑰算出來的，偽造或改序號的 QR 會判為無效。
 * 每張票只能入場一次（資料庫唯一索引保證，多個門同時掃也只會成功一次）。
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { ticketData } from './admin';

import { qrSecret, readQr } from './qr';
import { findGiftTicket, giftCheckRows, giftPaperSerial, isGiftPaperSerial, isGiftSerial } from './joinGift';
import { PRACTICE_QR, PRACTICE_SEAT, isPracticeQr, isPracticeSerial, liveAt, practiceHere } from './practice';
import { ERA_SEAT, eraSerial, parseEraQr } from './eraQr';
import { isSafeMode } from './safeMode';
export { qrSecret, qrValue, readQr } from './qr';

/** 入口建議：單號在左、雙號在右 */
export function sideOf(code: string) {
  const n = parseInt((code.split('-')[1] ?? '').replace(/\D/g, ''), 10);
  return Number.isNaN(n) ? '' : n % 2 ? '左側門' : '右側門';
}

async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 依序號找票（只有劃位成功的訂單才有效） */
async function findTicket(db: Db, serial: string) {
  const m = serial.match(/^(.+)-(\d{2,3})$/);
  if (!m) return { ticket: null, order: null };
  const [order] = await db.select().from(t.orders).where(eq(t.orders.orderNo, m[1]));
  if (!order) return { ticket: null, order: null };
  if (order.status !== 'paid') return { ticket: null, order };
  const { tickets } = await ticketData(db, [order.id]);
  return { ticket: tickets.find((x) => x.serial === serial) ?? null, order };
}

/* ---------- 驗票門口 ---------- */

export const DEFAULT_GATES = ['左1', '左2', '左3', '左4', '右1', '右2', '右3', '右4'];

export async function listGates(db: Db) {
  const ev = await currentEvent(db);
  const gates = await db.select().from(t.gate).where(eq(t.gate.eventId, ev.id)).orderBy(t.gate.sort, t.gate.id);
  const counts = await db.select({ g: t.checkin.gateId, n: sql<number>`count(*)::int` }).from(t.checkin)
    .where(eq(t.checkin.eventId, ev.id)).groupBy(t.checkin.gateId);
  return gates.map((g) => ({ id: g.id, name: g.name, token: g.token, active: g.active, count: counts.find((c) => c.g === g.id)?.n ?? 0 }));
}

export async function createGates(db: Db, actor: string, names: string[]) {
  const ev = await currentEvent(db);
  const have = await db.select().from(t.gate).where(eq(t.gate.eventId, ev.id));
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].filter((n) => !have.some((g) => g.name === n));
  if (!clean.length) throw new BookingError('INVALID', '這些門口都已經建立過了');
  for (const [i, name] of clean.entries()) {
    await db.insert(t.gate).values({ eventId: ev.id, name, token: randomBytes(15).toString('base64url'), sort: have.length + i });
  }
  await db.insert(t.auditLog).values({ actor, action: 'gate_create', target: `event:${ev.id}`, detail: JSON.stringify(clean) });
  return { created: clean.length };
}

export async function updateGate(db: Db, actor: string, id: number, v: { active?: boolean; renewToken?: boolean; name?: string }) {
  const set: Partial<typeof t.gate.$inferInsert> = {};
  if (v.active !== undefined) set.active = v.active;
  if (v.name) set.name = v.name.trim();
  if (v.renewToken) set.token = randomBytes(15).toString('base64url');
  await db.update(t.gate).set(set).where(eq(t.gate.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'gate_update', target: `gate:${id}`, detail: JSON.stringify(v) });
}

async function gateByToken(db: Db, token: string) {
  const [g] = await db.select().from(t.gate).where(eq(t.gate.token, token));
  if (!g) throw new BookingError('LINK_NOT_FOUND', '驗票連結不存在，請向主辦方索取正確連結。');
  if (!g.active) throw new BookingError('LINK_DISABLED', '這條驗票連結已停用，請向主辦方索取新連結。');
  return g;
}

async function counts(db: Db, eventId: number, gateId: number, now = new Date()) {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).where(and(eq(t.orders.eventId, eventId), eq(t.orders.status, 'paid')));
  // 年代票（序號 ERA:…）另計：不在「應到」裡
  const [{ entered, era }] = await db.select({
    entered: sql<number>`(count(*) filter (where ${t.checkin.serial} not like 'ERA:%'))::int`,
    era: sql<number>`(count(*) filter (where ${t.checkin.serial} like 'ERA:%'))::int`,
  }).from(t.checkin).where(eq(t.checkin.eventId, eventId));
  const gift = (await giftCheckRows(db, eventId, now)).length; // 揪團贈席：QR 與紙本（11-29 起紙本也在驗票頁入場）
  const [{ here }] = await db.select({ here: sql<number>`count(*)::int` }).from(t.checkin).where(and(eq(t.checkin.eventId, eventId), eq(t.checkin.gateId, gateId)));
  const live = await liveAt(db);
  return { total: total + gift, entered, here, era, practice: now < live, liveAt: live.toISOString(), prac: await practiceHere(db, eventId, gateId) };
}
type Counts = Awaited<ReturnType<typeof counts>>;

/** 記錄這條連結有人在用（負責人頁看「已開啟／在線」） */
async function touchGate(db: Db, id: number, now: Date) {
  await db.update(t.gate).set({ seenAt: now, openedAt: sql`coalesce(${t.gate.openedAt}, ${now.toISOString()}::timestamptz)` }).where(eq(t.gate.id, id));
}

export async function gateInfo(db: Db, token: string, now = new Date()) {
  const g = await gateByToken(db, token);
  await touchGate(db, g.id, now);
  const [ev] = await db.select().from(t.event).where(eq(t.event.id, g.eventId));
  return { gate: g.name, event: ev.name, showAt: ev.showAt.toISOString(), safeMode: isSafeMode(), ...(await counts(db, ev.id, g.id, now)) };
}

export type ScanResult =
  | { result: 'ok'; serial: string; label: string; code: string; zoneName: string; side: string; holderName: string; holderId4: string; orderNo: string; manual: boolean; isEra?: true; eraPaper?: true; giftPaper?: true }
  | { result: 'used'; serial: string; label: string; holderName: string; at: string; gate: string; isEra?: true }
  | { result: 'invalid'; reason: string };

const pad3 = (n: number) => String(n).padStart(3, '0');

/**
 * 掃描、手動輸入序號，或紙本贈席入場（paper＝劃位序；-1＝練習座位）。
 * 正式驗票時間（預設演出當天 17:00）以前一律只記「練習」，不會讓票變成已入場。
 */
export async function scan(db: Db, token: string, input: { qr?: string; serial?: string; paper?: number }, now = new Date()): Promise<ScanResult & Counts> {
  const g = await gateByToken(db, token);
  await touchGate(db, g.id, now);
  const practice = now < (await liveAt(db));
  const manual = !input.qr;
  const raw = (input.qr ?? input.serial ?? (input.paper !== undefined ? `紙本贈席 ${input.paper}` : '')).slice(0, 200);
  let kind = '';
  const done = async (r: ScanResult) => {
    // 練習時無效的掃描也記下來（看年代紙本格式、志工練了什麼）
    if (practice && r.result === 'invalid') {
      await db.insert(t.checkinPractice).values({ eventId: g.eventId, gateId: g.id, key: null, kind, result: 'invalid', reason: r.reason, raw, manual, at: now });
    }
    return { ...r, ...(await counts(db, g.eventId, g.id, now)) };
  };
  /** 入場（或練習入場）：同一張票只能一次；回傳之前那次的時間、門口 */
  const record = async (serial: string, orderId: number, seatId: string): Promise<{ fresh: true } | { fresh: false; at: string; gate: string }> => {
    if (!practice) {
      const ins = await db.insert(t.checkin).values({ eventId: g.eventId, serial, orderId, seatId, gateId: g.id, manual, at: now }).onConflictDoNothing().returning();
      if (ins.length) return { fresh: true };
      const [prev] = await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, g.eventId), eq(t.checkin.serial, serial)));
      const [pg] = prev?.gateId ? await db.select().from(t.gate).where(eq(t.gate.id, prev.gateId)) : [];
      return { fresh: false, at: prev.at.toISOString(), gate: pg?.name ?? '後台' };
    }
    const key = `${g.id}|${serial}`;
    const ins = await db.insert(t.checkinPractice).values({ eventId: g.eventId, gateId: g.id, key, serial, kind, result: 'ok', raw, manual, at: now }).onConflictDoNothing().returning();
    if (ins.length) return { fresh: true };
    const [prev] = await db.select().from(t.checkinPractice).where(and(eq(t.checkinPractice.eventId, g.eventId), eq(t.checkinPractice.key, key)));
    await db.insert(t.checkinPractice).values({ eventId: g.eventId, gateId: g.id, key: null, serial, kind, result: 'used', raw, manual, at: now });
    return { fresh: false, at: prev.at.toISOString(), gate: `${g.name}（練習）` };
  };

  // 練習單上的特例練習票：正式時間後一律無效
  if ((input.qr && isPracticeQr(input.qr)) || (input.serial && isPracticeSerial(input.serial)) || input.paper === -1) {
    kind = '練習票';
    if (!practice) return done({ result: 'invalid', reason: '練習票，不可入場。這是驗票練習單上的票，請對方出示真正的票。' });
    return done(await practiceTicket(input, record));
  }

  // 揪團贈席拿年代紙本（貴賓券）：搜排號後按「紙本入場」
  if (input.paper !== undefined) {
    kind = '贈席紙本';
    const row = (await giftCheckRows(db, g.eventId, now)).find((x) => x.no === input.paper);
    if (!row) return done({ result: 'invalid', reason: '找不到這個贈席，請重新搜尋。' });
    if (row.serial) return done({ result: 'invalid', reason: `這席（${row.label}）選了 QR 電子票，請對方出示 QR；沒有 QR 時請搜尋姓名入場。` });
    const serial = giftPaperSerial(row.no);
    const label = `三樓 ${row.label}`;
    const r = await record(serial, 0, row.seatId);
    if (!r.fresh) return done({ result: 'used', serial, label, holderName: row.group, at: r.at, gate: r.gate });
    return done({ result: 'ok', serial, label, code: row.code, zoneName: '揪團贈席・紙本', side: '', holderName: row.group, holderId4: '', orderNo: `劃位序 ${row.no}`, manual: true, giftPaper: true });
  }

  let serial: string;
  // 年代票（電子、紙本）：掃到就計數（同一張只算一次），不分樓層（11-25 使用者）
  const era = input.qr ? parseEraQr(input.qr) : null;
  if (era?.kind === 'pending') { kind = '年代轉贈待接收'; return done({ result: 'invalid', reason: '年代票：轉贈尚未接收。請收票的人先在年代 App 按「接收票券」，再出示 QR。' }); }
  if (era?.kind === 'era') {
    kind = era.paper ? '年代紙本' : '年代';
    serial = eraSerial(era.id);
    const label = era.paper ? '年代紙本票' : '年代票';
    const r = await record(serial, 0, ERA_SEAT);
    if (!r.fresh) return done({ result: 'used', serial, label, holderName: '', at: r.at, gate: r.gate, isEra: true });
    return done({ result: 'ok', serial, label, code: '', zoneName: '', side: '', holderName: '', holderId4: '', orderNo: '', manual: false, isEra: true, ...(era.paper ? { eraPaper: true as const } : {}) });
  }
  if (input.qr) {
    const q = readQr(await qrSecret(db), input.qr);
    if (!q) return done({ result: 'invalid', reason: /^TICC\|/.test(input.qr.trim()) ? '偽造或已失效的 QR code' : '不是本活動的入場 QR code' });
    serial = q.serial;
  } else {
    serial = (input.serial ?? '').trim().toUpperCase();
    if (!serial) return done({ result: 'invalid', reason: '請輸入序號' });
  }
  // 揪團贈席電子票（序號 JG…）
  if (isGiftSerial(serial)) {
    kind = '贈席 QR';
    const { ticket: gt, reason } = await findGiftTicket(db, g.eventId, serial, now);
    if (!gt) return done({ result: 'invalid', reason });
    const label = `三樓 ${gt.label}`;
    const r = await record(serial, 0, gt.seatId);
    if (!r.fresh) return done({ result: 'used', serial, label, holderName: gt.holderName, at: r.at, gate: r.gate });
    return done({ result: 'ok', serial, label, code: gt.code, zoneName: gt.zoneName, side: gt.side, holderName: gt.holderName, holderId4: '', orderNo: `${gt.group}・劃位序 ${gt.no}`, manual });
  }
  kind = '我們的票';
  const { ticket, order } = await findTicket(db, serial);
  if (!ticket) {
    return done({ result: 'invalid', reason: !order ? '查無此票' : order.status === 'pending' ? '尚未確認劃位，不能入場' : '此訂單已取消，票券無效' });
  }
  const r = await record(serial, ticket.orderId, ticket.seatId);
  if (!r.fresh) return done({ result: 'used', serial, label: ticket.label, holderName: ticket.holderName, at: r.at, gate: r.gate });
  return done({
    result: 'ok', serial, label: ticket.label, code: ticket.code, zoneName: ticket.zoneName, side: sideOf(ticket.code),
    holderName: ticket.holderName, holderId4: ticket.holderId4, orderNo: ticket.orderNo ?? '', manual,
  });
}

type Rec = (serial: string, orderId: number, seatId: string) => Promise<{ fresh: true } | { fresh: false; at: string; gate: string }>;

/** 特例練習票（只在練習時間內） */
async function practiceTicket(input: { qr?: string; serial?: string; paper?: number }, record: Rec): Promise<ScanResult> {
  const q = (input.qr ?? '').trim().toUpperCase();
  const base = { code: '', side: '', holderId4: '', orderNo: '', manual: !input.qr };
  if (input.paper === -1) {
    const r = await record('JGP-PRAC', 0, 'PRAC');
    if (!r.fresh) return { result: 'used', serial: 'JGP-PRAC', label: PRACTICE_SEAT.label, holderName: PRACTICE_SEAT.group, at: r.at, gate: r.gate };
    return { result: 'ok', serial: 'JGP-PRAC', label: PRACTICE_SEAT.label, zoneName: '揪團贈席・紙本（練習）', holderName: PRACTICE_SEAT.group, ...base, manual: true, giftPaper: true };
  }
  if (q === PRACTICE_QR.ok || isPracticeSerial(input.serial ?? '')) {
    const r = await record('PRAC-OK', 0, 'PRAC');
    if (!r.fresh) return { result: 'used', serial: 'PRAC-OK', label: '2 樓 第 5 排 12 號（練習）', holderName: '練習生', at: r.at, gate: r.gate };
    return { result: 'ok', serial: 'PRAC-OK', label: '2 樓 第 5 排 12 號（練習）', zoneName: '練習票', holderName: '練習生', ...base, holderId4: '1234' };
  }
  if (q === PRACTICE_QR.used) {
    return { result: 'used', serial: 'PRAC-USED', label: '2 樓 第 6 排 8 號（練習）', holderName: '練習生', at: new Date(Date.now() - 12 * 60_000).toISOString(), gate: '4F左-A（練習）' };
  }
  if (q === PRACTICE_QR.cancel) return { result: 'invalid', reason: '此訂單已取消，票券無效（練習）' };
  if (q === PRACTICE_QR.vip) {
    const r = await record('PRAC-VIP', 0, 'PRAC');
    if (!r.fresh) return { result: 'used', serial: 'PRAC-VIP', label: 'VIP 排 8 號（練習）', holderName: '練習貴賓', at: r.at, gate: r.gate };
    return { result: 'ok', serial: 'PRAC-VIP', label: 'VIP 排 8 號（練習）', zoneName: 'VIP', holderName: '練習貴賓', ...base };
  }
  if (q === PRACTICE_QR.era || q === PRACTICE_QR.eraPaper) {
    const paper = q === PRACTICE_QR.eraPaper;
    const s = paper ? 'ERA:PRAC-P' : 'ERA:PRAC';
    const label = paper ? '年代紙本票（練習）' : '年代票（練習）';
    const r = await record(s, 0, ERA_SEAT);
    if (!r.fresh) return { result: 'used', serial: s, label, holderName: '', at: r.at, gate: r.gate, isEra: true };
    return { result: 'ok', serial: s, label, zoneName: '', holderName: '', ...base, isEra: true, ...(paper ? { eraPaper: true as const } : {}) };
  }
  return { result: 'invalid', reason: '不是本活動的入場 QR code（練習）' };
}

/** 驗票頁搜尋結果：paper＝紙本贈席（劃位序，-1 是練習座位），按「紙本入場」 */
export type Found = { serial: string; label: string; holderName: string; holderId4: string; entered: string | null; paper?: number; note?: string };

/** 「18-3」「18排3號」「18 3」→ 排、號 */
export function parseSeatQuery(q: string) {
  const m = q.trim().replace(/[－—]/g, '-').match(/^(?:3\s*(?:樓|F)\s*-?\s*)?(\d{1,2})\s*(?:-|排|\s)\s*(\d{1,3})\s*號?$/i);
  return m ? { row: parseInt(m[1], 10), seat: parseInt(m[2], 10) } : null;
}

/** 驗票頁搜尋：序號、持票人姓名、購票人姓名或手機；贈席另可用票上印的「排-號」搜 */
export async function searchTickets(db: Db, token: string, q: string, now = new Date()): Promise<Found[]> {
  const g = await gateByToken(db, token);
  const k = q.trim();
  if (k.length < 2) return [];
  const practice = now < (await liveAt(db));
  const seatQ = parseSeatQuery(k);
  // 揪團贈席：入座者、群名、負責人姓名或手機、序號、排號（紙本的按「紙本入場」）
  const kd = k.replace(/\D/g, '');
  const rows = await giftCheckRows(db, g.eventId, now);
  const gifts = seatQ
    ? rows.filter((x) => Number(x.rowNo) === seatQ.row && parseInt(String(x.seatNo), 10) === seatQ.seat)
    : rows.filter((x) => x.holderName.includes(k) || x.group.includes(k) || x.headName.includes(k)
      || (kd.length >= 3 && x.headPhone.includes(kd)) || (x.serial && x.serial.includes(k.toUpperCase()))).slice(0, 20);
  const giftOut: Found[] = gifts.map((x) => (x.serial
    ? { serial: x.serial, label: `三樓 ${x.label}`, holderName: x.holderName, holderId4: x.group, entered: null }
    : { serial: giftPaperSerial(x.no), label: `三樓 ${x.label}`, holderName: x.group, holderId4: x.holderName, entered: null, paper: x.no, note: x.paper === '尚未選擇' ? '紙本贈席（未選取票方式）' : '紙本贈席・貴賓券' }));
  const giftSerials = giftOut.map((x) => x.serial);
  const giftUsed = giftSerials.length
    ? await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, g.eventId), inArray(t.checkin.serial, giftSerials))) : [];
  for (const x of giftOut) x.entered = practice ? null : giftUsed.find((u) => u.serial === x.serial)?.at.toISOString() ?? null;
  if (seatQ) {
    if (practice && seatQ.row === PRACTICE_SEAT.row && seatQ.seat === PRACTICE_SEAT.seat) {
      giftOut.unshift({ serial: 'JGP-PRAC', label: PRACTICE_SEAT.label, holderName: PRACTICE_SEAT.group, holderId4: '', entered: null, paper: -1, note: '紙本贈席・貴賓券（練習）' });
    }
    return giftOut;
  }
  const hit = await db.selectDistinct({ id: t.orders.id }).from(t.orders)
    .innerJoin(t.orderSeat, eq(t.orderSeat.orderId, t.orders.id))
    .where(and(eq(t.orders.eventId, g.eventId), eq(t.orders.status, 'paid'), or(
      ilike(t.orders.orderNo, `%${k}%`), ilike(t.orders.buyerName, `%${k}%`), ilike(t.orders.buyerPhone, `%${k.replace(/\D/g, '') || k}%`),
      ilike(t.orderSeat.holderName, `%${k}%`),
    ))).limit(10);
  if (!hit.length) return giftOut;
  const { tickets } = await ticketData(db, hit.map((h) => h.id));
  const used = practice ? [] : await db.select().from(t.checkin).where(and(eq(t.checkin.eventId, g.eventId), inArray(t.checkin.serial, tickets.map((x) => x.serial))));
  return [...tickets.slice(0, 30).map((x) => ({ serial: x.serial, label: x.label, holderName: x.holderName, holderId4: x.holderId4, entered: used.find((u) => u.serial === x.serial)?.at.toISOString() ?? null })), ...giftOut];
}

/* ---------- 後台 ---------- */

export async function checkinSummary(db: Db, now = new Date()) {
  const ev = await currentEvent(db);
  const [{ total: paidSeats }] = await db.select({ total: sql<number>`count(*)::int` }).from(t.orderSeat)
    .innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  const giftRows = await giftCheckRows(db, ev.id, now);
  const total = paidSeats + giftRows.length;
  const recent = await db.select({ id: t.checkin.id, serial: t.checkin.serial, at: t.checkin.at, manual: t.checkin.manual, gate: t.gate.name, seatId: t.checkin.seatId, holder: t.orderSeat.holderName })
    .from(t.checkin).leftJoin(t.gate, eq(t.gate.id, t.checkin.gateId))
    .leftJoin(t.orderSeat, and(eq(t.orderSeat.orderId, t.checkin.orderId), eq(t.orderSeat.seatId, t.checkin.seatId)))
    .where(eq(t.checkin.eventId, ev.id)).orderBy(desc(t.checkin.id)).limit(50);
  const [{ entered, era }] = await db.select({
    entered: sql<number>`(count(*) filter (where ${t.checkin.serial} not like 'ERA:%'))::int`,
    era: sql<number>`(count(*) filter (where ${t.checkin.serial} like 'ERA:%'))::int`,
  }).from(t.checkin).where(eq(t.checkin.eventId, ev.id));
  return { total, entered, era, recent: recent.map((r) => ({ ...r, holder: r.holder ?? giftRows.find((x) => x.serial === r.serial)?.holderName
      ?? (isGiftPaperSerial(r.serial) ? `紙本贈席 ${giftRows.find((x) => giftPaperSerial(x.no) === r.serial)?.group ?? ''}` : null)
      ?? (r.serial.startsWith('ERA:') ? '年代票' : null), at: r.at.toISOString(), gate: r.gate ?? '後台' })) };
}

/** 撤銷入場（誤掃）：這張票可以再掃一次 */
export async function undoCheckin(db: Db, actor: string, id: number) {
  const [c] = await db.delete(t.checkin).where(eq(t.checkin.id, id)).returning();
  if (!c) throw new BookingError('NOT_FOUND', '找不到這筆入場紀錄');
  await db.insert(t.auditLog).values({ actor, action: 'checkin_undo', target: `ticket:${c.serial}`, detail: JSON.stringify(c) });
  return { serial: c.serial };
}

/* ---------- 斷線備案：可列印入場名單 ---------- */

const byStroke = new Intl.Collator('zh-Hant-TW-u-co-stroke');

/**
 * 所有已確認（paid）訂單的每一張票，給斷線時人工核對用。
 * sort：name＝持票人姓名（筆畫）；seat＝座位。列印時已入場的票標出時間與門口。
 */
export async function checkinList(db: Db, sort: 'name' | 'seat' = 'name', now = new Date()) {
  const ev = await currentEvent(db);
  const paid = await db.select({ id: t.orders.id, buyer: t.orders.buyerName }).from(t.orders)
    .where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  const { event, tickets } = await ticketData(db, paid.map((o) => o.id));
  const used = await db.select({ serial: t.checkin.serial, at: t.checkin.at, gate: t.gate.name }).from(t.checkin)
    .leftJoin(t.gate, eq(t.gate.id, t.checkin.gateId)).where(eq(t.checkin.eventId, ev.id));
  const seatKey = (code: string) => code.split('-').map((p) => p.replace(/\d+/g, (d) => d.padStart(4, '0'))).join('-');
  const rows = tickets.map((x) => {
    const u = used.find((c) => c.serial === x.serial);
    return {
      serial: x.serial, holderName: x.holderName || '（未填）', holderId4: x.holderId4, label: x.label, code: x.code, zoneName: x.zoneName,
      buyerName: paid.find((o) => o.id === x.orderId)?.buyer ?? '', entered: u ? { at: u.at.toISOString(), gate: u.gate ?? '後台' } : null,
    };
  });
  // 揪團贈席：電子票（QR）列序號；紙本的列「紙本：方式」，給門口核對
  for (const x of await giftCheckRows(db, ev.id, now)) {
    const u = used.find((c) => c.serial === (x.serial || giftPaperSerial(x.no)));
    rows.push({
      serial: x.serial || `紙本：${x.paper}`, holderName: x.holderName || '（未填）', holderId4: '', label: `三樓 ${x.label}`, code: x.code, zoneName: '揪團贈席',
      buyerName: `${x.group}（${x.headName}）`, entered: u ? { at: u.at.toISOString(), gate: u.gate ?? '後台' } : null,
    });
  }
  rows.sort(sort === 'seat'
    ? (a, b) => seatKey(a.code).localeCompare(seatKey(b.code)) || a.serial.localeCompare(b.serial)
    : (a, b) => byStroke.compare(a.holderName, b.holderName) || a.serial.localeCompare(b.serial));
  return { event, rows, entered: rows.filter((r) => r.entered).length };
}
