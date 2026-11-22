/**
 * 驗票即時看板：獨立連結（不用登入、只有數字、沒有姓名），每框「已驗／應驗」。
 *
 * 每張票先歸到一個「來源」，再由框的設定決定來源算進哪一框（後台可改，做活的）：
 *  - cz:<方案>:<票種>  我們系統已確認的訂單座位（例：感恩席・金區、感恩席・贈席）
 *  - vip:<類別>        招待（類別：招待／公益／VIP…，空白＝招待）
 *  - viprow            VIP 排的座位（不論哪種訂單，優先）
 *  - gift3f            三樓揪團贈席選 QR 的（序號 JG…）
 *  - era:3F/4F/5F      年代票：應驗＝年代售出明細該樓層已售張數；已驗＝掃到的年代 QR（樓層看驗票手機的開關）
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { giftCheckRows } from './joinGift';
import { ERA_FLOORS, eraFloorOf, eraFloorOfSeat } from './eraQr';

const LINK_KEY = 'checkin.board';
const BOX_KEY = 'checkin.boxes';

export type BoxCfg = { boxes: { name: string; hidden?: boolean }[]; assign: Record<string, string> };
type Src = { key: string; label: string; total: number; done: number };

async function ev0(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  return ev;
}
async function getJson<T>(db: Db, key: string, dflt: T): Promise<T> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, key));
  try { return r?.value ? { ...dflt, ...JSON.parse(r.value) } : dflt; } catch { return dflt; }
}
async function putJson(db: Db, key: string, v: unknown) {
  await db.insert(t.appSetting).values({ key, value: JSON.stringify(v) }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: JSON.stringify(v) } });
}

/* ---------- 連結 ---------- */

export async function boardLink(db: Db) {
  return getJson(db, LINK_KEY, { token: '', active: false });
}

/** 建立／換新連結（舊連結立即失效）、啟用、停用 */
export async function updateBoardLink(db: Db, actor: string, v: { renew?: boolean; active?: boolean }) {
  const cur = await boardLink(db);
  const next = { token: v.renew || !cur.token ? randomBytes(15).toString('base64url') : cur.token, active: v.active ?? (v.renew ? true : cur.active) };
  await putJson(db, LINK_KEY, next);
  await db.insert(t.auditLog).values({ actor, action: 'checkin_board_link', target: 'checkin.board', detail: JSON.stringify({ renew: !!v.renew || !cur.token, active: next.active }) });
  return next;
}

/* ---------- 來源與預設框 ---------- */

/** 預設歸屬：尊榮／感恩（買五送一併入感恩）＋「贈席」；招待；VIP 排；3F 贈票；年代各樓 */
export function defaultBox(key: string, label: string): string {
  if (key.startsWith('era:')) return `年代 ${key.slice(4)}`;
  if (key === 'gift3f') return '3F 贈票';
  if (key === 'viprow') return 'VIP';
  if (key.startsWith('vip:')) return '招待';
  const [plan, zone] = label.split('・');
  const gift = /贈/.test(zone ?? '');
  if (/尊榮/.test(plan)) return gift ? '尊榮贈席' : '尊榮';
  if (/感恩|買五送一/.test(plan)) return gift ? '感恩贈席' : '感恩';
  return '其他';
}
const ORDER = ['尊榮', '尊榮贈席', '感恩', '感恩贈席', '招待', 'VIP', '3F 贈票', '年代 3F', '年代 4F', '年代 5F'];
/** 沒有票也一直顯示的框 */
const ALWAYS = new Set(['3F 贈票', '年代 3F', '年代 4F', '年代 5F']);

async function sources(db: Db) {
  const ev = await ev0(db);
  const seats = await db.select({
    orderId: t.orders.id, seatId: t.orderSeat.seatId, vip: t.orders.vip, cat: t.orders.vipCat, comboId: t.orders.comboId,
    type: t.venueSeat.seatType, zoneId: t.eventSeat.zoneId,
  }).from(t.orderSeat).innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId))
    .leftJoin(t.eventSeat, and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, t.orderSeat.seatId)))
    .where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  const combos = await db.select({ id: t.combo.id, name: t.combo.name }).from(t.combo).where(eq(t.combo.eventId, ev.id));
  const zones = await db.select({ id: t.priceZone.id, name: t.priceZone.name }).from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const src = new Map<string, Src>();
  const add = (key: string, label: string, total: number) => { const s = src.get(key) ?? { key, label, total: 0, done: 0 }; s.total += total; src.set(key, s); };
  const seatKey = new Map<string, string>(); // orderId|seatId → 來源
  for (const s of seats) {
    let key: string, label: string;
    if (s.type === 'vip') { key = 'viprow'; label = 'VIP 排'; }
    else if (s.vip) { const c = s.cat || '招待'; key = `vip:${c}`; label = c; }
    else {
      const cn = combos.find((c) => c.id === s.comboId)?.name || `方案 ${s.comboId}`;
      const zn = zones.find((z) => z.id === s.zoneId)?.name || '';
      key = `cz:${s.comboId}:${s.zoneId ?? 0}`; label = zn ? `${cn}・${zn}` : cn;
    }
    add(key, label, 1);
    seatKey.set(`${s.orderId}|${s.seatId}`, key);
  }
  const gifts = (await giftCheckRows(db, ev.id)).filter((x) => x.serial);
  add('gift3f', '三樓揪團贈席（QR）', gifts.length);
  const giftSerials = new Set(gifts.map((x) => x.serial));
  // 年代：售出明細依樓層（已退不算）
  const era = await db.select({ floor: t.joinEraTicket.floor, at: t.joinEraTicket.updatedAt }).from(t.joinEraTicket)
    .where(and(eq(t.joinEraTicket.eventId, ev.id), eq(t.joinEraTicket.status, 'sold')));
  for (const f of ERA_FLOORS) add(`era:${f}`, `年代 ${f}`, 0);
  for (const x of era) { const f = eraFloorOf(x.floor); if (f) add(`era:${f}`, `年代 ${f}`, 1); }
  const eraAt = era.reduce<Date | null>((a, x) => (!a || x.at > a ? x.at : a), null);
  // 已驗
  const ck = await db.select({ serial: t.checkin.serial, orderId: t.checkin.orderId, seatId: t.checkin.seatId, gateId: t.checkin.gateId })
    .from(t.checkin).where(eq(t.checkin.eventId, ev.id));
  for (const c of ck) {
    let key: string | undefined;
    if (c.serial.startsWith('ERA:')) { const f = eraFloorOfSeat(c.seatId); key = `era:${f}`; if (!src.has(key)) add(key, `年代 ${f || '未分樓層'}`, 0); }
    else if (c.serial.startsWith('JG')) key = giftSerials.has(c.serial) ? 'gift3f' : undefined;
    else key = seatKey.get(`${c.orderId}|${c.seatId}`);
    if (!key) { key = 'other'; if (!src.has(key)) add(key, '其他（已取消或已改的票）', 0); }
    src.get(key)!.done++;
  }
  return { ev, src: [...src.values()], ck, eraAt };
}

export async function getBoxCfg(db: Db): Promise<BoxCfg> {
  return getJson<BoxCfg>(db, BOX_KEY, { boxes: [], assign: {} });
}

/** 依設定把來源分到框；設定沒提到的來源用預設 */
function group(src: Src[], cfg: BoxCfg) {
  const boxOf = (s: Src) => cfg.assign[s.key] || defaultBox(s.key, s.label);
  const names = [...cfg.boxes.map((b) => b.name)];
  // 還沒存過設定：用預設順序；存過就照設定（改名後舊名字不再出現）
  for (const n of [...(cfg.boxes.length ? [] : ORDER), ...src.map(boxOf)]) if (!names.includes(n)) names.push(n);
  return names.map((name) => {
    const list = src.filter((s) => boxOf(s) === name);
    return {
      name, hidden: !!cfg.boxes.find((b) => b.name === name)?.hidden,
      total: list.reduce((a, s) => a + s.total, 0), done: list.reduce((a, s) => a + s.done, 0),
      lines: list.map((s) => ({ key: s.key, label: s.label, total: s.total, done: s.done })),
    };
  });
}

/** 看板資料（公開連結用：只有數字） */
export async function boardData(db: Db) {
  const { ev, src, ck, eraAt } = await sources(db);
  const boxes = group(src, await getBoxCfg(db)).filter((b) => !b.hidden && (b.total > 0 || b.done > 0 || ALWAYS.has(b.name)))
    .map((b) => ({ name: b.name, total: b.total, done: b.done, lines: b.lines.length > 1 ? b.lines.filter((l) => l.total || l.done).map(({ label, total, done }) => ({ label, total, done })) : [] }));
  const gates = await db.select({ id: t.gate.id, name: t.gate.name }).from(t.gate).where(eq(t.gate.eventId, ev.id)).orderBy(t.gate.sort, t.gate.id);
  return {
    event: ev.name, showAt: ev.showAt.toISOString(), at: new Date().toISOString(), eraAt: eraAt?.toISOString() ?? null,
    boxes, total: src.reduce((a, s) => a + s.total, 0), done: ck.length,
    gates: [...gates.map((g) => ({ name: g.name, n: ck.filter((c) => c.gateId === g.id).length })), ...(ck.some((c) => !c.gateId) ? [{ name: '後台', n: ck.filter((c) => !c.gateId).length }] : [])].filter((g) => g.n > 0),
  };
}

export async function boardByToken(db: Db, token: string) {
  const l = await boardLink(db);
  if (!l.token || token !== l.token) throw new BookingError('LINK_NOT_FOUND', '看板連結不存在或已換新，請向主辦方索取新連結。');
  if (!l.active) throw new BookingError('LINK_DISABLED', '看板連結已停用。');
  return boardData(db);
}

/** 後台：連結＋每個來源目前歸哪一框（設定用） */
export async function boardAdminState(db: Db) {
  const { src } = await sources(db);
  const cfg = await getBoxCfg(db);
  return {
    link: await boardLink(db),
    boxes: group(src, cfg).map((b) => ({ name: b.name, hidden: b.hidden, total: b.total, done: b.done })),
    sources: src.map((s) => ({ key: s.key, label: s.label, total: s.total, done: s.done, box: cfg.assign[s.key] || defaultBox(s.key, s.label) })),
  };
}

/** 存框設定：框的順序／名稱／隱藏、每個來源算哪一框 */
export async function saveBoxCfg(db: Db, actor: string, v: BoxCfg) {
  const names = v.boxes.map((b) => b.name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new BookingError('INVALID', '框的名稱不能重複');
  const clean: BoxCfg = { boxes: v.boxes.filter((b) => b.name.trim()).map((b) => ({ name: b.name.trim(), hidden: !!b.hidden })), assign: {} };
  for (const [k, n] of Object.entries(v.assign)) if (n.trim()) clean.assign[k] = n.trim();
  await putJson(db, BOX_KEY, clean);
  await db.insert(t.auditLog).values({ actor, action: 'checkin_board_boxes', target: 'checkin.boxes', detail: JSON.stringify(clean) });
  return { ok: true };
}

/** 招待類別清單（新增招待時可選；之後可再加） */
const CAT_KEY = 'vip.cats';
export const DEFAULT_CATS = ['招待', '公益', 'VIP'];
export async function getVipCats(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, CAT_KEY));
  const list = (r?.value ?? '').split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : DEFAULT_CATS;
}
export async function setVipCats(db: Db, actor: string, text: string) {
  const list = [...new Set(text.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean))];
  if (!list.length) throw new BookingError('INVALID', '至少要有一個類別');
  if (list.some((x) => x.length > 10)) throw new BookingError('INVALID', '類別名稱最多 10 個字');
  await db.insert(t.appSetting).values({ key: CAT_KEY, value: list.join('、') }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: list.join('、') } });
  await db.insert(t.auditLog).values({ actor, action: 'vip_cats', target: CAT_KEY, detail: list.join('、') });
  return { cats: list };
}

/** 指定訂單是否都在 VIP 排（新增招待時自動帶 VIP 用） */
export async function allVipRow(db: Db, seatIds: string[]) {
  if (!seatIds.length) return false;
  const rows = await db.select({ type: t.venueSeat.seatType }).from(t.venueSeat).where(inArray(t.venueSeat.id, seatIds));
  return rows.length === seatIds.length && rows.every((r) => r.type === 'vip');
}
