/**
 * 驗票練習（11/29 使用者）：正式驗票時間（預設演出當天 17:00）以前的所有掃描都只算練習，
 * 存在 checkin_practice，不會把票變成「已入場」。另有特例練習票（練習單），正式時間後一律無效。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';

const LIVE_KEY = 'checkin.liveAt';

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}

/** 正式驗票開始時間：預設演出當天 17:00（台北） */
export async function liveAt(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, LIVE_KEY));
  if (r?.value && !Number.isNaN(Date.parse(r.value))) return new Date(r.value);
  const ev = await ev0(db);
  const d = ev.showAt.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  return new Date(`${d}T17:00:00+08:00`);
}

export async function setLiveAt(db: Db, actor: string, iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BookingError('INVALID', '時間格式不正確');
  await db.insert(t.appSetting).values({ key: LIVE_KEY, value: d.toISOString() }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: d.toISOString() } });
  await db.insert(t.auditLog).values({ actor, action: 'checkin_live_at', target: 'app_setting', detail: d.toISOString() });
  return { liveAt: d.toISOString() };
}

/* ---------- 特例練習票 ---------- */

/** 練習單上的 QR 內容（印在 /crew/practice），正式時間後掃到一律「練習票，不可入場」 */
export const PRACTICE_QR = {
  ok: 'TICCPRAC|OK',
  used: 'TICCPRAC|USED',
  cancel: 'TICCPRAC|CANCEL',
  vip: 'TICCPRAC|VIP',
  era: 'PRAC0000000001-29120000027',
  eraPaper: 'PRAC00000000002',
  pending: '轉贈待接收',
  invalid: 'HELLO-PRACTICE-0000',
} as const;
export const PRACTICE_SERIAL = 'P-0001';
/** 練習用的紙本贈席座位：搜尋 99-1 */
export const PRACTICE_SEAT = { row: 99, seat: 1, label: '三樓 99 排 1 號（練習座位）', group: '練習群', holderName: '練習生' };

export const isPracticeQr = (s: string) => /^TICCPRAC\|/.test(s.trim()) || /^PRAC\d{10}/i.test(s.trim());
export const isPracticeSerial = (s: string) => s.trim().toUpperCase() === PRACTICE_SERIAL;

/* ---------- 練習紀錄 ---------- */

/** 後台：練習統計（每個門口練了幾張、看過哪些票種）＋最近的原文（看年代紙本格式） */
export async function practiceStats(db: Db) {
  const ev = await ev0(db);
  const byGate = await db.select({ g: t.checkinPractice.gateId, n: sql<number>`count(*)::int`, kinds: sql<string[]>`array_agg(distinct ${t.checkinPractice.kind})` })
    .from(t.checkinPractice).where(eq(t.checkinPractice.eventId, ev.id)).groupBy(t.checkinPractice.gateId);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.checkinPractice).where(eq(t.checkinPractice.eventId, ev.id));
  const recent = await db.select().from(t.checkinPractice).where(eq(t.checkinPractice.eventId, ev.id)).orderBy(sql`${t.checkinPractice.id} desc`).limit(30);
  return {
    total: n,
    byGate: byGate.map((x) => ({ gateId: x.g, n: x.n, kinds: (x.kinds ?? []).filter(Boolean) })),
    recent: recent.map((r) => ({ id: r.id, gateId: r.gateId, kind: r.kind, result: r.result, reason: r.reason, raw: r.raw, serial: r.serial, at: r.at.toISOString() })),
  };
}

/** 清除練習資料：只刪練習紀錄，正式入場紀錄一筆都不動 */
export async function clearPractice(db: Db, actor: string) {
  const ev = await ev0(db);
  const del = await db.delete(t.checkinPractice).where(eq(t.checkinPractice.eventId, ev.id)).returning({ id: t.checkinPractice.id });
  await db.insert(t.auditLog).values({ actor, action: 'checkin_practice_clear', target: 'checkin_practice', detail: JSON.stringify({ count: del.length }) });
  return { count: del.length };
}

/** 某個門口的練習張數（成功入場的） */
export async function practiceHere(db: Db, eventId: number, gateId: number) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.checkinPractice)
    .where(and(eq(t.checkinPractice.eventId, eventId), eq(t.checkinPractice.gateId, gateId), eq(t.checkinPractice.result, 'ok')));
  return n;
}
