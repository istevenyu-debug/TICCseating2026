/**
 * 後台邏輯：席位用途、票種、依排數與區塊指定座位、購票方式（組合票）、發布、
 * 專屬連結、訂單（暫存／待確認／確認到帳／取消／刪除）、統計。
 *
 * 所有會改動資料的函式都會寫入 audit_log，actor 為後台帳號名稱。
 */
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import {
  ACTIVE_ORDER, BookingError, freeSeatsOf, loadCombos, sweepExpired, usedComboSets,
} from './booking';
import { BLOCKS, rowKey, seatLabel, type Block } from './layout';

export const COLOR_PRESETS = [
  '#b8ccf3', '#c4e5cf', '#f0dbb1', '#e6c3e5', '#bde2ea', '#f5c4c4', '#d9e7a8', '#c9c2f0', '#ffd29d',
  '#ffadad', '#9fd8c8', '#d3d3d3', '#4f7bd8', '#2f9a62', '#d9822b', '#c0392b', '#8e44ad', '#555e70',
];

const audit = (db: Db, actor: string, action: string, target: string, detail?: unknown) =>
  db.insert(t.auditLog).values({ actor, action, target, detail: detail === undefined ? null : JSON.stringify(detail) });

/** MVP 為主辦方自用、單一場次：取最新的場次 */
export async function currentEvent(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(desc(t.event.id)).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '尚未建立場次，請先執行 npm run db:seed。');
  return ev;
}

/* ---------- 讀取整份後台狀態 ---------- */

export async function getAdminState(db: Db, now = new Date()) {
  const ev = await currentEvent(db);
  await sweepExpired(db, ev.id, now);
  const [evNow] = await db.select().from(t.event).where(eq(t.event.id, ev.id));

  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort), asc(t.priceZone.id));
  const usages = await db.select().from(t.seatUsage).where(eq(t.seatUsage.eventId, ev.id)).orderBy(asc(t.seatUsage.id));
  const combos = await loadCombos(db, ev.id);
  const sets = await usedComboSets(db, ev.id);

  const seatRows = await db.select({
    id: t.venueSeat.id, x: t.venueSeat.x, y: t.venueSeat.y, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo,
    seatType: t.venueSeat.seatType, block: t.venueSeat.block, code: t.venueSeat.code,
    zoneId: t.eventSeat.zoneId, usageId: t.eventSeat.usageId, status: t.eventSeat.status, orderId: t.eventSeat.orderId, bundle: t.eventSeat.bundle,
  }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .where(eq(t.eventSeat.eventId, ev.id));
  const seats = seatRows.map((s) => ({
    id: s.id, x: s.x, y: s.y, no: s.seatNo, type: s.seatType, block: s.block, code: s.code,
    row: rowKey(s), label: seatLabel(s), zoneId: s.zoneId, usageId: s.usageId, status: s.status, orderId: s.orderId, bundle: s.bundle,
    installed: s.seatType !== 'vip' || evNow.vipInstalled,
  }));
  const seatById = Object.fromEntries(seats.map((s) => [s.id, s]));

  const orderRows = await db.select().from(t.orders).where(eq(t.orders.eventId, ev.id)).orderBy(desc(t.orders.id));
  const ids = orderRows.map((o) => o.id);
  const oseats = ids.length ? await db.select().from(t.orderSeat).where(inArray(t.orderSeat.orderId, ids)) : [];
  const pays = ids.length ? await db.select().from(t.payment).where(inArray(t.payment.orderId, ids)) : [];
  const links = await db.select().from(t.inviteLink).where(eq(t.inviteLink.eventId, ev.id)).orderBy(desc(t.inviteLink.id));
  const linkById = Object.fromEntries(links.map((l) => [l.id, l]));
  const comboById = Object.fromEntries(combos.map((c) => [c.id, c]));

  const orders = orderRows.map((o) => {
    const p = pays.find((x) => x.orderId === o.id);
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, amount: o.amount, comboName: `${comboById[o.comboId]?.name ?? ''}${o.sets > 1 ? ` ×${o.sets} 組` : ''}`,
      buyerName: o.buyerName ?? linkById[o.linkId]?.name ?? '', buyerPhone: o.buyerPhone ?? '', buyerEmail: o.buyerEmail ?? '',
      linkCode: linkById[o.linkId]?.code ?? '', linkKind: linkById[o.linkId]?.kind ?? 'personal', linkName: linkById[o.linkId]?.name ?? '', linkNote: linkById[o.linkId]?.note ?? '',
      createdAt: o.createdAt.toISOString(), submittedAt: o.submittedAt?.toISOString() ?? null,
      holdUntil: o.holdUntil?.toISOString() ?? null, payDueAt: o.payDueAt?.toISOString() ?? null,
      isNew: o.status === 'pending' && !o.seenAt, closedReason: o.closedReason,
      seats: oseats.filter((s) => s.orderId === o.id).map((s) => ({
        seatId: s.seatId, code: seatById[s.seatId]?.code ?? s.seatId, label: seatById[s.seatId]?.label ?? s.seatId,
        holderName: s.holderName, holderId4: s.holderId4, unitPrice: s.unitPrice,
      })),
      payment: p ? {
        last5: p.reportedLast5, amount: p.reportedAmount, time: p.reportedAt,
        confirmedDate: p.confirmedDate, confirmedAmount: p.confirmedAmount, confirmedBy: p.confirmedBy, note: p.note,
      } : null,
    };
  });

  const usedByLink = new Map<number, number>();
  orderRows.filter((o) => o.status === 'pending' || o.status === 'paid').forEach((o) => {
    usedByLink.set(o.linkId, (usedByLink.get(o.linkId) ?? 0) + oseats.filter((s) => s.orderId === o.id).length);
  });

  const usageById = Object.fromEntries(usages.map((u) => [u.id, u]));
  const inst = seats.filter((s) => s.installed);
  const stats = {
    total: inst.length,
    sale: inst.filter((s) => s.status === 'free' && usageById[s.usageId]?.sellable).length,
    held: inst.filter((s) => s.status === 'held').length,
    pending: inst.filter((s) => s.status === 'pending').length,
    sold: inst.filter((s) => s.status === 'sold').length,
    reserved: inst.filter((s) => s.status === 'free' && !usageById[s.usageId]?.sellable).length,
    revenue: orders.filter((o) => o.status === 'paid').reduce((a, o) => a + (o.payment?.confirmedAmount ?? o.amount), 0),
    newOrders: orders.filter((o) => o.isNew).length,
  };

  const draft = draftOf(evNow, zones, combos);
  const pub = evNow.published;
  const dirty = !pub || pub.open !== draft.open
    || [...pub.zoneIds].sort((a, b) => a - b).join() !== draft.zoneIds.join()
    || [...pub.comboIds].sort((a, b) => a - b).join() !== draft.comboIds.join();

  const bundlePresets = await getBundlePresets(db);
  const curMap = Object.fromEntries(seats.filter((x) => x.bundle).map((x) => [x.id, x.bundle as string]));
  const snapInfo = async (key: string) => {
    const sn = await getSnapshot(db, key);
    return sn ? { at: sn.at, by: sn.by, groups: new Set(Object.values(sn.map)).size, same: sameMap(sn.map, curMap) } : null;
  };
  return {
    bundlePresets,
    bundleSaved: await snapInfo(SNAP_SAVED),
    bundleUndo: await snapInfo(SNAP_UNDO),
    now: now.toISOString(),
    event: {
      id: evNow.id, name: evNow.name, showAt: evNow.showAt.toISOString(), vipInstalled: evNow.vipInstalled, saleOpen: evNow.saleOpen,
      saleStart: evNow.saleStart?.toISOString() ?? null, saleEnd: evNow.saleEnd?.toISOString() ?? null,
      maxPerOrder: evNow.maxPerOrder, holdMinutes: evNow.holdMinutes, payHours: evNow.payHours, payFirst: evNow.payFirst, preorderOpen: evNow.preorderOpen,
      bankName: evNow.bankName, bankAccount: evNow.bankAccount, accountName: evNow.accountName,
    },
    published: pub, dirty,
    zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, price: z.price, open: z.open, seatCount: inst.filter((s) => s.zoneId === z.id).length })),
    usages: usages.map((u) => ({ id: u.id, code: u.code, name: u.name, sellable: u.sellable })),
    combos: combos.map((c) => ({ ...c, usedSets: sets[c.id] ?? 0 })),
    seats, orders,
    links: links.map((l) => ({
      id: l.id, code: l.code, kind: l.kind, name: l.name, phone: l.phone, quota: l.quota, used: usedByLink.get(l.id) ?? 0,
      expiresAt: l.expiresAt.toISOString(), status: l.status, note: l.note,
    })),
    stats,
  };
}

export type AdminState = Awaited<ReturnType<typeof getAdminState>>;

function draftOf(ev: typeof t.event.$inferSelect, zones: { id: number; open: boolean }[], combos: { id: number; active: boolean }[]) {
  return {
    open: ev.saleOpen,
    zoneIds: zones.filter((z) => z.open).map((z) => z.id).sort((a, b) => a - b),
    comboIds: combos.filter((c) => c.active).map((c) => c.id).sort((a, b) => a - b),
  };
}

/* ---------- 開放訂購與發布 ---------- */

export async function updateEventSettings(db: Db, actor: string, v: Partial<{
  name: string; showAt: Date; saleOpen: boolean; saleStart: Date | null; saleEnd: Date | null; maxPerOrder: number; holdMinutes: number;
  payHours: number; payFirst: boolean; preorderOpen: boolean; bankName: string; bankAccount: string; accountName: string; vipInstalled: boolean;
}>) {
  const ev = await currentEvent(db);
  if (v.vipInstalled === false) {
    const [busy] = await db.select({ n: sql<number>`count(*)::int` }).from(t.eventSeat)
      .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
      .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.seatType, 'vip'), sql`${t.eventSeat.status} <> 'free'`));
    if (busy.n > 0) throw new BookingError('BUSY', `VIP 排已有 ${busy.n} 席有訂單，不能取消加裝。`);
  }
  await db.update(t.event).set(v).where(eq(t.event.id, ev.id));
  await audit(db, actor, 'event_settings', `event:${ev.id}`, v);
}

/** 把目前後台勾選的開放設定發布到購票頁 */
export async function publish(db: Db, actor: string, now = new Date()) {
  const ev = await currentEvent(db);
  const zones = await db.select({ id: t.priceZone.id, open: t.priceZone.open, name: t.priceZone.name, price: t.priceZone.price })
    .from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const combos = await loadCombos(db, ev.id);
  const d = draftOf(ev, zones, combos);
  const bad = zones.filter((z) => d.zoneIds.includes(z.id) && (!z.name || !(z.price >= 0)));
  if (bad.length) throw new BookingError('INVALID', '有開放的票種還沒填名稱或票價，請先補齊再發布。');
  // 票價 0＝贈票，只能透過組合票取得；必須有開放的組合票用到它
  const gifts = zones.filter((z) => d.zoneIds.includes(z.id) && z.price === 0);
  const orphan = gifts.filter((z) => !combos.some((c) => d.comboIds.includes(c.id) && !c.isSingle && c.items.some((i) => i.zoneId === z.id)));
  if (orphan.length) throw new BookingError('INVALID', `「${orphan[0].name}」票價為 0（贈票），但沒有開放的組合票包含它。請在組合票（例如功德組）加入它，或填寫票價。`);
  const badCombo = combos.filter((c) => d.comboIds.includes(c.id) && !c.isSingle && (!c.name || !(c.price > 0) || !c.items.length));
  if (badCombo.length) throw new BookingError('INVALID', `組合「${badCombo[0].name || '未命名'}」還沒填完名稱、內容或套票價格，請先補齊再發布。`);
  const published: t.Published = { ...d, at: now.toISOString() };
  await db.update(t.event).set({ published }).where(eq(t.event.id, ev.id));
  await audit(db, actor, 'publish', `event:${ev.id}`, published);
  return published;
}

/* ---------- 票種 ---------- */

export async function createZone(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id));
  const used = new Set(zones.map((z) => z.color.toLowerCase()));
  const color = COLOR_PRESETS.find((c) => !used.has(c)) ?? COLOR_PRESETS[0];
  const [z] = await db.insert(t.priceZone).values({
    eventId: ev.id, name: '', price: 0, color, sort: Math.max(0, ...zones.map((x) => x.sort)) + 1,
  }).returning();
  await audit(db, actor, 'zone_create', `zone:${z.id}`);
  return z;
}

export async function updateZone(db: Db, actor: string, id: number, v: Partial<{ name: string; price: number; color: string; open: boolean }>) {
  if (v.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(v.color)) throw new BookingError('INVALID', '顏色格式不正確');
  await db.update(t.priceZone).set(v).where(eq(t.priceZone.id, id));
  await audit(db, actor, 'zone_update', `zone:${id}`, v);
}

export async function deleteZone(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  const [z] = await db.select().from(t.priceZone).where(and(eq(t.priceZone.id, id), eq(t.priceZone.eventId, ev.id)));
  if (!z) throw new BookingError('NOT_FOUND', '找不到此票種');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.eventSeat).where(eq(t.eventSeat.zoneId, id));
  if (n > 0) throw new BookingError('BUSY', `「${z.name || '未命名'}」還有 ${n} 個座位，請先把這些座位改成其他票種再刪除。`);
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(t.comboItem).where(eq(t.comboItem.zoneId, id));
  if (m > 0) throw new BookingError('BUSY', `「${z.name || '未命名'}」還被組合票使用，請先修改組合內容。`);
  await db.delete(t.priceZone).where(eq(t.priceZone.id, id));
  await audit(db, actor, 'zone_delete', `zone:${id}`, z);
}

/** 依排數與區塊指定票種；blocks 為空代表全部區塊。已有訂單的座位不變。 */
export async function assignZoneByRule(db: Db, actor: string, zoneId: number, rows: number[], blocks: string[]) {
  const ev = await currentEvent(db);
  if (!rows.length) throw new BookingError('INVALID', '請選擇排數');
  const blk = new Set(blocks.length ? blocks : BLOCKS);
  const vs = await db.select().from(t.venueSeat);
  const target = vs.filter((s) => rows.includes(rowKey(s)) && blk.has(s.block as Block)).map((s) => s.id);
  return assignZoneSeats(db, actor, zoneId, target, ev.id);
}

export async function assignZoneSeats(db: Db, actor: string, zoneId: number, seatIds: string[], eventId?: number) {
  const evId = eventId ?? (await currentEvent(db)).id;
  if (!seatIds.length) return { updated: 0, skipped: 0 };
  const [z] = await db.select().from(t.priceZone).where(and(eq(t.priceZone.id, zoneId), eq(t.priceZone.eventId, evId)));
  if (!z) throw new BookingError('NOT_FOUND', '找不到此票種');
  const done = await db.update(t.eventSeat).set({ zoneId })
    .where(and(eq(t.eventSeat.eventId, evId), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free')))
    .returning({ seatId: t.eventSeat.seatId });
  await audit(db, actor, 'assign_zone', `zone:${zoneId}`, { count: done.length });
  return { updated: done.length, skipped: seatIds.length - done.length };
}

/* ---------- 連座（分組） ---------- */

export type BundleShape = 'row' | 'band2' | 'band3';

/**
 * 自動分組：把選定排數與區塊的座位，每 size 位綁成一組（按一下選整組）。
 * - shape 'row'：同一排左右連續，不跨排（例：贈票區兩位一組 → 第 2、3 排各 17 組）
 * - shape 'band2' / 'band3'：兩排／三排一起，由左到右一欄一欄往下排（例：10 位一組 → 5 位寬 × 2 排）
 * - crossAisle：可跨走道（座位數不是 size 的倍數時，讓組延伸到走道另一側，才能全部分完）
 * - skip：略過的座位（維持單人，例如保留給散客）
 * 這些座位原有的分組會先拆掉；有訂單的座位不能改。湊不滿一組的座位維持單人。
 */
export async function bundleAuto(db: Db, actor: string, o: { rows: number[]; blocks: string[]; size: number; shape: BundleShape; crossAisle: boolean; skip: string[] }, backup = true) {
  const ev = await currentEvent(db);
  if (!o.rows.length) throw new BookingError('INVALID', '請選擇排數');
  if (!Number.isInteger(o.size) || o.size < 2 || o.size > 40) throw new BookingError('INVALID', '每組人數請填 2–40');
  if (backup) await backupBeforeChange(db, actor);
  const blk = new Set(o.blocks.length ? o.blocks : BLOCKS);
  const skip = new Set(o.skip);
  const area = (await db.select().from(t.venueSeat)).filter((s) => o.rows.includes(rowKey(s)) && blk.has(s.block as Block));
  const vs = area.filter((s) => !skip.has(s.id));
  if (!vs.length) throw new BookingError('INVALID', '沒有符合條件的座位');
  return db.transaction(async (tx) => {
    const touch = [...new Set([...area.map((s) => s.id), ...skip])];
    const es = await tx.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, touch)));
    const busy = es.filter((s) => s.status !== 'free');
    if (busy.length) throw new BookingError('BUSY', `其中有 ${busy.length} 席已有訂單或暫存，不能改分組。請先處理這些訂單，或不要選這幾排。`);
    await clearBundles(tx, ev.id, es.map((s) => s.bundle).filter((b): b is string => !!b));

    const depth = o.shape === 'band3' ? 3 : o.shape === 'band2' ? 2 : 1;
    const ys = [...new Set(vs.map((s) => s.y))].sort((a, b) => a - b);
    const parts = o.crossAisle ? [vs] : [...new Set(vs.map((s) => s.block))].map((b) => vs.filter((s) => s.block === b));
    const groups: (typeof vs)[] = [];
    const singles: typeof vs = [];
    for (const part of parts) {
      let cur: typeof vs = [];
      let dir = 1;
      for (let i = 0; i < ys.length; i += depth) {
        const band = new Set(ys.slice(i, i + depth));
        const inBand = part.filter((s) => band.has(s.y));
        const xs = [...new Set(inBand.map((s) => s.x))].sort((a, b) => (a - b) * dir);
        for (const x of xs) {
          for (const s of inBand.filter((v) => v.x === x).sort((a, b) => a.y - b.y)) {
            cur.push(s);
            if (cur.length === o.size) { groups.push(cur); cur = []; }
          }
        }
        if (depth === 1) { singles.push(...cur); cur = []; } // 同一排：不接到下一排
        else dir = -dir; // 多排：蛇形，下一段從同一側接回來，組才會連在一起
      }
      singles.push(...cur);
    }
    const stamp = Date.now().toString(36);
    for (const g of groups) {
      await tx.update(t.eventSeat).set({ bundle: `${stamp}-${g[0].id}` })
        .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, g.map((s) => s.id))));
    }
    const perRow: Record<number, number> = {};
    for (const g of groups) { const r = rowKey(g[0]); perRow[r] = (perRow[r] ?? 0) + 1; }
    const crossAisle = groups.filter((g) => new Set(g.map((s) => s.block)).size > 1).length;
    await tx.insert(t.auditLog).values({ actor, action: 'bundle_auto', target: `event:${ev.id}`, detail: JSON.stringify({ ...o, skip: o.skip.length, groups: groups.length }) });
    return { groups: groups.length, perRow, leftovers: singles.map(seatLabel), skipped: skip.size, crossAisle };
  });
}

/* ---------- 預設分組（可修改） ---------- */

export interface BundlePreset { name: string; rows: number[]; blocks: string[]; size: number; shape: BundleShape; crossAisle: boolean; skip: string[] }

/** 系統預設：贈票區兩位一組、金額區十位一組、金區（左右側區）兩位一組 */
export const DEFAULT_BUNDLE_PRESETS: BundlePreset[] = [
  { name: '贈票區（功德組送 2）', rows: [2, 3], blocks: [], size: 2, shape: 'row', crossAisle: false, skip: [] },
  { name: '金額區（10 位一組）', rows: [4, 5, 6, 7, 8, 9, 10, 11, 12], blocks: ['L1', 'C0', 'R1'], size: 10, shape: 'band2', crossAisle: true,
    skip: ['4-33', '4-31', '4-29', '4-27', '4-32', '4-34'] },
  { name: '金區（買 10 送 2）', rows: [4, 5, 6, 7, 8, 9, 10, 11, 12], blocks: ['L2', 'R2'], size: 2, shape: 'row', crossAisle: false, skip: [] },
];

export async function getBundlePresets(db: Db): Promise<BundlePreset[]> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, 'bundle.presets'));
  if (!r) return DEFAULT_BUNDLE_PRESETS;
  try { return JSON.parse(r.value) as BundlePreset[]; } catch { return DEFAULT_BUNDLE_PRESETS; }
}

export async function saveBundlePresets(db: Db, actor: string, presets: BundlePreset[] | null) {
  if (presets === null) await db.delete(t.appSetting).where(eq(t.appSetting.key, 'bundle.presets')); // 恢復預設
  else {
    const value = JSON.stringify(presets);
    await db.insert(t.appSetting).values({ key: 'bundle.presets', value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  }
  await audit(db, actor, 'bundle_presets', 'app_setting', presets ? { count: presets.length } : { reset: true });
  return getBundlePresets(db);
}

/* ---------- 分組存檔：手工調整完可存起來，日後一鍵還原；自動分組/套用預設前也會自動備份一份，可「復原」 ---------- */
export const SNAP_SAVED = 'bundle.saved';
export const SNAP_UNDO = 'bundle.undo';
interface Snapshot { at: string; by: string; map: Record<string, string> }
type BTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function getSnapshot(db: Db | BTx, key: string): Promise<Snapshot | null> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, key));
  if (!r) return null;
  try { return JSON.parse(r.value) as Snapshot; } catch { return null; }
}
function sameMap(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
async function currentBundleMap(db: Db | BTx, eventId: number) {
  const rows = await db.select({ id: t.eventSeat.seatId, b: t.eventSeat.bundle }).from(t.eventSeat).where(eq(t.eventSeat.eventId, eventId));
  return Object.fromEntries(rows.filter((r) => r.b).map((r) => [r.id, r.b as string]));
}
async function writeSnapshot(db: Db | BTx, key: string, actor: string, eventId: number) {
  const snap: Snapshot = { at: new Date().toISOString(), by: actor, map: await currentBundleMap(db, eventId) };
  const value = JSON.stringify(snap);
  await db.insert(t.appSetting).values({ key, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  return snap;
}

/** 儲存目前分組（手工調整完按這個） */
export async function saveBundleSnapshot(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const snap = await writeSnapshot(db, SNAP_SAVED, actor, ev.id);
  await audit(db, actor, 'bundle_save', `event:${ev.id}`, { groups: new Set(Object.values(snap.map)).size });
  return { groups: new Set(Object.values(snap.map)).size };
}

/** 還原到存檔（which='saved'）或復原上一次自動分組前的樣子（which='undo'）。只改有變動的座位；這些座位不能有訂單 */
export async function restoreBundleSnapshot(db: Db, actor: string, which: 'saved' | 'undo') {
  const ev = await currentEvent(db);
  const key = which === 'saved' ? SNAP_SAVED : SNAP_UNDO;
  const snap = await getSnapshot(db, key);
  if (!snap) throw new BookingError('NOT_FOUND', which === 'saved' ? '還沒有儲存過分組' : '沒有可以復原的紀錄');
  return db.transaction(async (tx) => {
    const es = await tx.select().from(t.eventSeat).where(eq(t.eventSeat.eventId, ev.id));
    const changed = es.filter((s) => (s.bundle ?? null) !== (snap.map[s.seatId] ?? null));
    const busy = changed.filter((s) => s.status !== 'free');
    if (busy.length) throw new BookingError('BUSY', `有 ${busy.length} 席已有訂單或暫存，分組和存檔不同，不能還原。請先處理這些訂單。`);
    if (which === 'undo') await writeSnapshot(tx, SNAP_UNDO, actor, ev.id); // 復原後可再按一次「復原」回到剛才
    for (const s of changed) {
      await tx.update(t.eventSeat).set({ bundle: snap.map[s.seatId] ?? null }).where(and(eq(t.eventSeat.eventId, ev.id), eq(t.eventSeat.seatId, s.seatId)));
    }
    await tx.insert(t.auditLog).values({ actor, action: `bundle_restore_${which}`, target: `event:${ev.id}`, detail: JSON.stringify({ seats: changed.length }) });
    return { seats: changed.length, groups: new Set(Object.values(snap.map)).size };
  });
}

/** 自動分組、套用預設、取消分組之前，先把目前分組備份到「復原」 */
async function backupBeforeChange(db: Db, actor: string) {
  const ev = await currentEvent(db);
  await writeSnapshot(db, SNAP_UNDO, actor, ev.id);
}

/** 套用預設分組：依序執行每一條（index 不給＝全部） */
export async function applyBundlePresets(db: Db, actor: string, index?: number) {
  const all = await getBundlePresets(db);
  const list = index === undefined ? all : [all[index]].filter(Boolean);
  if (!list.length) throw new BookingError('NOT_FOUND', '找不到這條預設');
  await backupBeforeChange(db, actor);
  const results = [];
  for (const p of list) {
    const r = await bundleAuto(db, actor, p, false);
    results.push({ name: p.name, groups: r.groups, size: p.size, leftovers: r.leftovers.length, skipped: r.skipped, crossAisle: r.crossAisle });
  }
  return results;
}

/** 舊版介面相容：同一排左右分組、不跨走道 */
export function bundleByRule(db: Db, actor: string, rows: number[], blocks: string[], size: number) {
  return bundleAuto(db, actor, { rows, blocks, size, shape: 'row', crossAisle: false, skip: [] });
}

/** 手動：把選取的座位設為一組。這些座位會從原本的組移出；原組只剩一位時改回單人 */
export async function bundleManual(db: Db, actor: string, seatIds: string[]) {
  const ev = await currentEvent(db);
  const ids = [...new Set(seatIds)];
  if (ids.length < 2) throw new BookingError('INVALID', '一組至少要 2 位，請在座位圖上選取座位');
  if (ids.length > 40) throw new BookingError('INVALID', '一組最多 40 位');
  return db.transaction(async (tx) => {
    const es = await tx.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
    if (es.length !== ids.length) throw new BookingError('INVALID', '有座位不存在');
    if (es.some((s) => s.status !== 'free')) throw new BookingError('BUSY', '選取的座位中有已訂或暫存的，不能改分組。');
    const old = [...new Set(es.map((s) => s.bundle).filter((b): b is string => !!b))];
    const key = `${Date.now().toString(36)}-m-${ids[0]}`;
    await tx.update(t.eventSeat).set({ bundle: key }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
    await dissolveTiny(tx, ev.id, old);
    await tx.insert(t.auditLog).values({ actor, action: 'bundle_manual', target: `event:${ev.id}`, detail: JSON.stringify({ seats: ids }) });
    return { size: ids.length };
  });
}

/** 手動：把選取座位改回單人（只移出這些座位；原組只剩一位時也改回單人） */
export async function bundleRemove(db: Db, actor: string, seatIds: string[]) {
  const ev = await currentEvent(db);
  const ids = [...new Set(seatIds)];
  if (!ids.length) throw new BookingError('INVALID', '請先在座位圖上選取座位');
  return db.transaction(async (tx) => {
    const es = await tx.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
    if (es.some((s) => s.status !== 'free' && s.bundle)) throw new BookingError('BUSY', '選取的座位中有已訂或暫存的，不能改分組。');
    const old = [...new Set(es.map((s) => s.bundle).filter((b): b is string => !!b))];
    await tx.update(t.eventSeat).set({ bundle: null }).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
    await dissolveTiny(tx, ev.id, old);
    await tx.insert(t.auditLog).values({ actor, action: 'bundle_remove', target: `event:${ev.id}`, detail: JSON.stringify({ seats: ids }) });
    return { removed: es.filter((s) => s.bundle).length };
  });
}

/** 組員只剩一位的組，改回單人 */
async function dissolveTiny(db: Db, eventId: number, keys: string[]) {
  if (!keys.length) return;
  const left = await db.select({ b: t.eventSeat.bundle, n: sql<number>`count(*)::int` }).from(t.eventSeat)
    .where(and(eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.bundle, keys))).groupBy(t.eventSeat.bundle);
  await clearBundles(db, eventId, left.filter((r) => r.n < 2).map((r) => r.b!));
}

/** 取消連座：這些排／區塊的座位改回單人選位（整組拆開，包含組內其他位） */
export async function unbundleByRule(db: Db, actor: string, rows: number[], blocks: string[]) {
  const ev = await currentEvent(db);
  if (!rows.length) throw new BookingError('INVALID', '請選擇排數');
  const blk = new Set(blocks.length ? blocks : BLOCKS);
  const ids = (await db.select().from(t.venueSeat)).filter((s) => rows.includes(rowKey(s)) && blk.has(s.block as Block)).map((s) => s.id);
  if (!ids.length) return { cleared: 0 };
  const es = await db.select().from(t.eventSeat).where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, ids)));
  const keys = [...new Set(es.map((s) => s.bundle).filter((b): b is string => !!b))];
  if (keys.length) await backupBeforeChange(db, actor);
  await clearBundles(db, ev.id, keys);
  await audit(db, actor, 'bundle_clear', `event:${ev.id}`, { rows, blocks, groups: keys.length });
  return { cleared: keys.length };
}

async function clearBundles(db: Db, eventId: number, keys: string[]) {
  if (keys.length) await db.update(t.eventSeat).set({ bundle: null }).where(and(eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.bundle, keys)));
}

/* ---------- 席位用途 ---------- */

export async function setSeatUsage(db: Db, actor: string, usageId: number, seatIds: string[]) {
  const ev = await currentEvent(db);
  const [u] = await db.select().from(t.seatUsage).where(and(eq(t.seatUsage.id, usageId), eq(t.seatUsage.eventId, ev.id)));
  if (!u) throw new BookingError('NOT_FOUND', '找不到此用途');
  const done = await db.update(t.eventSeat).set({ usageId })
    .where(and(eq(t.eventSeat.eventId, ev.id), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free')))
    .returning({ seatId: t.eventSeat.seatId });
  await audit(db, actor, 'set_usage', `usage:${usageId}`, { count: done.length });
  return { updated: done.length, skipped: seatIds.length - done.length };
}

/* ---------- 購票方式（組合票） ---------- */

export async function createCombo(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const zones = await db.select().from(t.priceZone).where(eq(t.priceZone.eventId, ev.id)).orderBy(asc(t.priceZone.sort));
  const all = await db.select().from(t.combo).where(eq(t.combo.eventId, ev.id));
  const [c] = await db.insert(t.combo).values({ eventId: ev.id, name: '', price: 0, sort: Math.max(0, ...all.map((x) => x.sort)) + 1 }).returning();
  if (zones[0]) await db.insert(t.comboItem).values({ comboId: c.id, zoneId: zones[0].id, qty: 1 });
  await audit(db, actor, 'combo_create', `combo:${c.id}`);
  return c;
}

export async function updateCombo(db: Db, actor: string, id: number, v: Partial<{
  name: string; price: number; limitSets: number; active: boolean; autoHolders: boolean; items: { zoneId: number; qty: number }[];
}>) {
  const [c] = await db.select().from(t.combo).where(eq(t.combo.id, id));
  if (!c) throw new BookingError('NOT_FOUND', '找不到此購票方式');
  const { items, ...rest } = v;
  if (Object.keys(rest).length) await db.update(t.combo).set(rest).where(eq(t.combo.id, id));
  if (items && !c.isSingle) {
    const merged = new Map<number, number>();
    items.filter((i) => i.qty > 0).forEach((i) => merged.set(i.zoneId, (merged.get(i.zoneId) ?? 0) + i.qty));
    await db.delete(t.comboItem).where(eq(t.comboItem.comboId, id));
    if (merged.size) await db.insert(t.comboItem).values([...merged].map(([zoneId, qty]) => ({ comboId: id, zoneId, qty })));
  }
  await audit(db, actor, 'combo_update', `combo:${id}`, v);
}

export async function deleteCombo(db: Db, actor: string, id: number) {
  const [c] = await db.select().from(t.combo).where(eq(t.combo.id, id));
  if (!c) throw new BookingError('NOT_FOUND', '找不到此購票方式');
  if (c.isSingle) throw new BookingError('INVALID', '單張購票不能刪除，可改為不開放。');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.orders).where(eq(t.orders.comboId, id));
  if (n > 0) throw new BookingError('BUSY', `「${c.name}」已有訂單，不能刪除，可改為不開放。`);
  await db.delete(t.combo).where(eq(t.combo.id, id));
  await audit(db, actor, 'combo_delete', `combo:${id}`, c);
}

/* ---------- 專屬連結 ---------- */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 購票連結完整網址。base 為後台目前使用的網址（例如臨時通道網址）；正式環境可用 PUBLIC_BASE_URL 固定 */
export function linkUrl(code: string, base?: string) {
  const b = (process.env.PUBLIC_BASE_URL || base || '').replace(/\/$/, '');
  return `${b}/t/${code}`;
}

export async function createInviteLink(db: Db, actor: string, v: { name: string; phone: string; quota: number; expiresAt: Date; note?: string }, base?: string) {
  const ev = await currentEvent(db);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const [exists] = await db.select({ id: t.inviteLink.id }).from(t.inviteLink).where(eq(t.inviteLink.code, code));
    if (exists) continue;
    const [l] = await db.insert(t.inviteLink).values({ eventId: ev.id, code, ...v, note: v.note ?? '' }).returning();
    // 有填手機才寄簡訊；沒填就由主辦方自行複製連結貼給當事人
    if (v.phone) await db.insert(t.notification).values({
      linkId: l.id, channel: 'sms', template: 'invite', recipient: v.phone,
      content: `【${ev.name}】${v.name} 您好，您的專屬購票連結：${linkUrl(code, base)} 可訂 ${v.quota || '不限'} 張，${v.expiresAt.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })} 前有效。`,
    });
    await audit(db, actor, 'link_create', `link:${l.id}`, { name: v.name, quota: v.quota });
    return l;
  }
  throw new BookingError('SERVER', '產生連結代碼失敗，請再試一次。');
}


export async function updateInviteLink(db: Db, actor: string, id: number, v: Partial<{ quota: number; expiresAt: Date; status: 'active' | 'disabled' }>) {
  await db.update(t.inviteLink).set(v).where(eq(t.inviteLink.id, id));
  await audit(db, actor, 'link_update', `link:${id}`, v);
}

/* ---------- 訂單 ---------- */

export function confirmMessage(eventName: string, o: { buyerName: string | null; orderNo: string | null }, amount: number, seatText: string, showAt: Date, myOrderUrl?: string) {
  const when = showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `【${eventName}】${o.buyerName ?? ''} 您好，劃位成功：${seatText}。劃位編號 ${o.orderNo}，演出時間 ${when}。入場 QR code 請至劃位頁「我的劃位」查看${myOrderUrl ? `：${myOrderUrl}` : ''}，入場時請出示 QR code 與身分證件。`;
}

export async function markOrderSeen(db: Db, id: number, now = new Date()) {
  await db.update(t.orders).set({ seenAt: now }).where(and(eq(t.orders.id, id), isNull(t.orders.seenAt)));
}

/** 確認到帳：座位改為已售出，並通知消費者劃位成功 */
/** 劃位確認：座位改為已售出，寄出劃位成功與 QR code（款項已在預購單收訖） */
export async function confirmPayment(db: Db, actor: string, id: number, v: { date?: string; amount?: number; note?: string } = {}, now = new Date(), base?: string) {
  const ev = await currentEvent(db);
  return db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    if (o.status !== 'pending') throw new BookingError('INVALID', '只有「待確認」的劃位可以確認。');
    await tx.update(t.orders).set({ status: 'paid', seenAt: o.seenAt ?? now }).where(eq(t.orders.id, id));
    await tx.update(t.eventSeat).set({ status: 'sold', version: sql`${t.eventSeat.version} + 1` }).where(eq(t.eventSeat.orderId, id));
    await tx.update(t.payment).set({ confirmedDate: v.date ?? now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }), confirmedAmount: v.amount ?? o.amount, confirmedBy: actor, note: v.note ?? null, confirmedAt: now })
      .where(eq(t.payment.orderId, id));
    const seats = await tx.select({ rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code, holder: t.orderSeat.holderName })
      .from(t.orderSeat).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId)).where(eq(t.orderSeat.orderId, id));
    const seatText = seats.map((s) => `${seatLabel(s)}（${s.code}，持票人 ${s.holder ?? ''}）`).join('、');
    const [lk] = await tx.select({ code: t.inviteLink.code }).from(t.inviteLink).where(eq(t.inviteLink.id, o.linkId));
    const content = confirmMessage(ev.name, o, v.amount ?? o.amount, seatText, ev.showAt, lk && (base || process.env.PUBLIC_BASE_URL) ? linkUrl(lk.code, base) : undefined);
    await tx.insert(t.notification).values([
      { orderId: id, linkId: o.linkId, channel: 'sms', template: 'order_confirmed', recipient: o.buyerPhone ?? '', content },
      { orderId: id, linkId: o.linkId, channel: 'email', template: 'order_confirmed', recipient: o.buyerEmail ?? '', content },
      { orderId: id, linkId: o.linkId, channel: 'push', template: 'order_confirmed', recipient: '訂購人手機', content },
    ]);
    await tx.insert(t.auditLog).values({ actor, action: 'confirm_payment', target: `order:${id}`, detail: JSON.stringify(v) });
    return { content };
  });
}

/** 取消訂單（暫存中或待確認到帳）：釋放座位，待確認的訂單會通知消費者 */
export async function cancelOrder(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    if (o.status !== 'held' && o.status !== 'pending') throw new BookingError('INVALID', '只有暫存中或待確認到帳的訂單可以取消。');
    await tx.update(t.orders).set({ status: 'cancelled', closedReason: 'admin_cancel', holdUntil: null }).where(eq(t.orders.id, id));
    await freeSeatsOf(tx, [id]);
    if (o.status === 'pending') {
      const content = `【${ev.name}】劃位 ${o.orderNo} 已由主辦方取消，座位已釋放，可用原連結重新劃位。如有疑問請聯繫主辦方。`;
      await tx.insert(t.notification).values([
        { orderId: id, linkId: o.linkId, channel: 'sms', template: 'order_cancelled', recipient: o.buyerPhone ?? '', content },
        { orderId: id, linkId: o.linkId, channel: 'email', template: 'order_cancelled', recipient: o.buyerEmail ?? '', content },
        { orderId: id, linkId: o.linkId, channel: 'push', template: 'order_cancelled', recipient: '訂購人手機', content },
      ]);
    }
    await tx.insert(t.auditLog).values({ actor, action: 'cancel_order', target: `order:${id}` });
  });
}

/** 刪除訂單（測試資料清理用）：座位釋放，訂單內容完整記入操作紀錄 */
export async function deleteOrder(db: Db, actor: string, id: number) {
  const ev = await currentEvent(db);
  await db.transaction(async (tx) => {
    const [o] = await tx.select().from(t.orders).where(and(eq(t.orders.id, id), eq(t.orders.eventId, ev.id))).for('update');
    if (!o) throw new BookingError('NOT_FOUND', '找不到此訂單');
    const seats = await tx.select().from(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    await freeSeatsOf(tx, [id]);
    await tx.update(t.notification).set({ orderId: null }).where(eq(t.notification.orderId, id));
    await tx.delete(t.payment).where(eq(t.payment.orderId, id));
    await tx.delete(t.orderSeat).where(eq(t.orderSeat.orderId, id));
    await tx.delete(t.orders).where(eq(t.orders.id, id));
    await tx.insert(t.auditLog).values({ actor, action: 'delete_order', target: `order:${id}`, detail: JSON.stringify({ order: o, seats }) });
  });
}

/* ---------- 入場券 ---------- */

export async function ticketData(db: Db, orderIds: number[]) {
  const ev = await currentEvent(db);
  if (!orderIds.length) return { event: ev, tickets: [] };
  const rows = await db.select({
    orderId: t.orders.id, orderNo: t.orders.orderNo, status: t.orders.status, comboId: t.orders.comboId,
    seatId: t.orderSeat.seatId, holderName: t.orderSeat.holderName, holderId4: t.orderSeat.holderId4,
    rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, code: t.venueSeat.code, entrance: t.venueSeat.entrance,
    zoneName: t.priceZone.name,
  }).from(t.orders)
    .innerJoin(t.orderSeat, eq(t.orderSeat.orderId, t.orders.id))
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId))
    .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, t.orders.eventId)))
    .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
    .where(and(eq(t.orders.eventId, ev.id), inArray(t.orders.id, orderIds), eq(t.orders.status, 'paid')))
    .orderBy(asc(t.orders.id), asc(t.venueSeat.y), asc(t.venueSeat.x));
  const combos = await loadCombos(db, ev.id);
  const n = new Map<number, number>();
  return {
    event: ev,
    tickets: rows.map((r) => {
      const k = (n.get(r.orderId) ?? 0) + 1;
      n.set(r.orderId, k);
      return {
        serial: `${r.orderNo}-${String(k).padStart(2, '0')}`, orderNo: r.orderNo, orderId: r.orderId, seatId: r.seatId, label: seatLabel(r), code: r.code,
        zoneName: r.zoneName, comboName: combos.find((c) => c.id === r.comboId)?.name ?? '',
        holderName: r.holderName ?? '', holderId4: r.holderId4 ?? '', entrance: r.entrance,
      };
    }),
  };
}

export { ACTIVE_ORDER };
