/**
 * 全場銷售總覽：2M（本系統，即時）＋年代售出明細（2–5 樓，依最後上傳的名單）。
 * 年代各樓層的總席數由後台自己填（sales.caps），填了才算「尚可售」。
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { eraSales } from './joinQueue';

const CAPS_KEY = 'sales.caps';
/** TICC 大會堂座位示意圖（109/11/13）各區總席數；後台可改（sales.caps 同名鍵優先） */
export const HALL_CAPS: Record<string, number> = { '3F': 510, '4F': 748, '5F': 686, '包廂': 480 };
/** 年代明細的樓層／排 → 全場分區：B 開頭的排或寫「包廂」＝包廂；6 樓只有包廂；其餘照樓層數字 */
export function hallKey(floor: string, row: string) {
  const f = (floor || '').trim(), r = (row || '').trim();
  if (/包廂/.test(f) || /^B\d/i.test(r)) return '包廂';
  const m = f.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).match(/\d+/) ?? (/三/.test(f) ? ['3'] : /四/.test(f) ? ['4'] : /五/.test(f) ? ['5'] : /六/.test(f) ? ['6'] : null);
  if (!m) return f || '（未標樓層）';
  const n = Number(m[0]);
  if (n === 6) return '包廂';
  return n === 2 ? '2M' : `${n}F`;
}
/** 台北日期 M/D */
const md = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
};
/** 樓層排序：2M、2樓、3樓…；看不出數字的放最後 */
const floorKey = (f: string) => { const m = f.match(/\d+/); return m ? Number(m[0]) + (/M/i.test(f) ? 0.5 : 0) : 99; };

export async function getCaps(db: Db): Promise<Record<string, number>> {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, CAPS_KEY));
  try { const v = JSON.parse(r?.value ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export async function setCaps(db: Db, actor: string, raw: unknown) {
  const p = z.record(z.string().max(40), z.number().int().min(0).max(10000)).safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', '總席數格式不正確');
  const caps = Object.fromEntries(Object.entries(p.data).filter(([k, v]) => k.trim() && v > 0).map(([k, v]) => [k.trim(), v]));
  const value = JSON.stringify(caps);
  await db.insert(t.appSetting).values({ key: CAPS_KEY, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
  await db.insert(t.auditLog).values({ actor, action: 'sales_caps', target: 'app_setting', detail: value });
  return caps;
}

export async function salesOverview(db: Db, now = new Date()) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return null;

  /* 2M：本系統座位，依票種 */
  const seats = await db.select({
    status: t.eventSeat.status, seatType: t.venueSeat.seatType, zone: t.priceZone.name, price: t.priceZone.price, sort: t.priceZone.sort, zoneId: t.priceZone.id,
    sellable: t.seatUsage.sellable, orderId: t.eventSeat.orderId,
  }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId))
    .innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
    .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '2M')));
  const inst = seats.filter((s) => s.seatType !== 'vip' || ev.vipInstalled);
  const zmap = new Map<number, { name: string; price: number; sort: number; total: number; sold: number; pending: number; reserved: number; free: number }>();
  for (const s of inst) {
    let z = zmap.get(s.zoneId);
    if (!z) { z = { name: s.zone || '票區', price: s.price, sort: s.sort, total: 0, sold: 0, pending: 0, reserved: 0, free: 0 }; zmap.set(s.zoneId, z); }
    z.total++;
    if (s.status === 'sold') z.sold++;
    else if (s.status === 'pending' || s.status === 'held') z.pending++;
    else if (!s.sellable) z.reserved++;
    else z.free++;
  }
  const zones = [...zmap.values()].sort((a, b) => a.sort - b.sort || b.price - a.price);
  const sum = <K extends 'total' | 'sold' | 'pending' | 'reserved' | 'free'>(k: K) => zones.reduce((a, z) => a + z[k], 0);
  const twoM = { zones, total: sum('total'), sold: sum('sold'), pending: sum('pending'), reserved: sum('reserved'), free: sum('free') };

  /* 年代：逐張票，依樓層、票價 */
  const tkAll = await db.select({ floor: t.joinEraTicket.floor, row: t.joinEraTicket.rowNo, price: t.joinEraTicket.price, status: t.joinEraTicket.status, soldAt: t.joinEraTicket.soldAt, at: t.joinEraTicket.updatedAt })
    .from(t.joinEraTicket).where(eq(t.joinEraTicket.eventId, ev.id));
  const tk = tkAll;
  const caps = await getCaps(db);
  const fmap = new Map<string, Map<number, { sold: number; refunded: number }>>();
  let eraAt: Date | null = null;
  for (const x of tk) {
    const f = x.floor || '（未標樓層）';
    if (!fmap.has(f)) fmap.set(f, new Map());
    const pm = fmap.get(f)!;
    const p = pm.get(x.price) ?? { sold: 0, refunded: 0 };
    if (x.status === 'sold') p.sold++; else p.refunded++;
    pm.set(x.price, p);
    if (!eraAt || x.at > eraAt) eraAt = x.at;
  }
  const floors = [...new Set([...fmap.keys(), ...Object.keys(caps)])].sort((a, b) => floorKey(a) - floorKey(b) || a.localeCompare(b)).map((floor) => {
    const pm = fmap.get(floor) ?? new Map();
    const prices = [...pm.entries()].sort((a, b) => b[0] - a[0]).map(([price, v]) => ({ price, ...v }));
    const sold = prices.reduce((a, x) => a + x.sold, 0), refunded = prices.reduce((a, x) => a + x.refunded, 0);
    const cap = caps[floor] ?? null;
    return { floor, prices, sold, refunded, cap, left: cap === null ? null : Math.max(0, cap - sold) };
  });
  const era = { at: eraAt ? new Date(eraAt).toISOString() : null, floors, sold: floors.reduce((a, f) => a + f.sold, 0), refunded: floors.reduce((a, f) => a + f.refunded, 0), tickets: tk.length };

  /* 每天售出：2M（訂單建立日，已售＋待確認的座位）＋年代（售出時間） */
  const day = new Map<string, { twoM: number; era: number }>();
  const add = (d: Date | null, k: 'twoM' | 'era') => { if (!d) return; const key = md(d); const v = day.get(key) ?? { twoM: 0, era: 0 }; v[k]++; day.set(key, v); };
  const oids = [...new Set(inst.filter((s) => s.orderId && (s.status === 'sold' || s.status === 'pending')).map((s) => s.orderId!))];
  const odate = new Map<number, Date>();
  for (let i = 0; i < oids.length; i += 1000) {
    for (const o of await db.select({ id: t.orders.id, at: t.orders.createdAt }).from(t.orders).where(inArray(t.orders.id, oids.slice(i, i + 1000)))) odate.set(o.id, o.at);
  }
  for (const s of inst) if (s.orderId && (s.status === 'sold' || s.status === 'pending')) add(odate.get(s.orderId) ?? null, 'twoM');
  for (const x of tk) if (x.status === 'sold') add(x.soldAt, 'era');
  const daily = [...day.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([d, v]) => ({ day: `${+d.slice(5, 7)}/${+d.slice(8, 10)}`, ...v }));

  const silver = await eraSales(db, ev.id);

  /* 全場（依 TICC 大會堂座位示意圖 109/11/13）：2M、3F 中間（年代）、3F 兩側（我們）、4F、5F、包廂 */
  const side = await db.select({ status: t.eventSeat.status, code: t.seatUsage.code, block: t.venueSeat.block }).from(t.eventSeat)
    .innerJoin(t.venueSeat, eq(t.venueSeat.id, t.eventSeat.seatId)).innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId))
    .where(and(eq(t.eventSeat.eventId, ev.id), eq(t.venueSeat.floor, '3F')));
  const sideSeats = side.filter((x) => x.block === 'L2' || x.block === 'R2'); // 兩側斜區 214 席（座位圖固定，不看塗色）
  const giftPicked = sideSeats.filter((x) => x.code === 'join-gift' && x.status !== 'free').length;
  const giftFree = sideSeats.filter((x) => x.code === 'join-gift' && x.status === 'free').length;
  const vol = sideSeats.filter((x) => x.code === 'join-vol').length;
  const other = sideSeats.length - giftPicked - giftFree - vol;
  const byKey = new Map<string, { sold: number; refunded: number; prices: Map<number, number> }>();
  for (const x of tkAll) {
    const k = hallKey(x.floor, x.row);
    const v = byKey.get(k) ?? { sold: 0, refunded: 0, prices: new Map() };
    if (x.status === 'sold') { v.sold++; v.prices.set(x.price, (v.prices.get(x.price) ?? 0) + 1); } else v.refunded++;
    byKey.set(k, v);
  }
  const eraRow = (key: string, label: string) => {
    const v = byKey.get(key);
    const total = caps[key] ?? HALL_CAPS[key] ?? null;
    const sold = v?.sold ?? 0;
    return { key, label, by: '年代', total, sold, left: total === null ? null : Math.max(0, total - sold), refunded: v?.refunded ?? 0,
      prices: [...(v?.prices ?? new Map()).entries()].sort((a, b) => b[0] - a[0]).map(([price, n]) => ({ price, n })) };
  };
  const mid = { key: '3F', label: '3F 中間（13–27 排）', by: '年代', total: silver.cap || HALL_CAPS['3F'], sold: silver.sold, left: Math.max(0, (silver.cap || HALL_CAPS['3F']) - silver.sold), refunded: byKey.get('3F')?.refunded ?? 0,
    prices: [...(byKey.get('3F')?.prices ?? new Map()).entries()].sort((a, b) => b[0] - a[0]).map(([price, n]) => ({ price, n })) };
  const hall = [
    { key: '2M', label: '2M（1–12 排）', by: '本系統', total: twoM.total, sold: twoM.sold, left: twoM.free, refunded: 0, prices: [] as { price: number; n: number }[], note: `${twoM.pending ? `待確認 ${twoM.pending}・` : ''}${twoM.reserved ? `保留 ${twoM.reserved}` : ''}` },
    { ...mid, note: '' },
    { key: '3F側', label: '3F 兩側（左2／右2）', by: '我們', total: sideSeats.length, sold: sideSeats.length - giftFree, left: giftFree, refunded: 0, prices: [] as { price: number; n: number }[],
      note: `贈席已劃 ${giftPicked}・志工 ${vol}${other ? `・招待／保留 ${other}` : ''}` },
    { ...eraRow('4F', '4F（28–41 排）'), note: '' },
    { ...eraRow('5F', '5F（42–55 排）'), note: '' },
    ...(byKey.has('包廂') ? [{ ...eraRow('包廂', '包廂（B1–B35）'), note: '' }] : []), // 包廂不賣：名單裡有包廂票才顯示
    ...[...byKey.keys()].filter((k) => !['3F', '4F', '5F', '包廂'].includes(k)).map((k) => ({ ...eraRow(k, `${k}（年代）`), note: '樓層看不出來' })),
  ];
  const known = hall.filter((h) => h.total !== null);
  const hallSum = { total: known.reduce((a, h) => a + (h.total ?? 0), 0), sold: hall.reduce((a, h) => a + h.sold, 0), left: known.reduce((a, h) => a + (h.left ?? 0), 0) };

  return { now: now.toISOString(), twoM, era, silver, daily, caps, hall, hallSum };
}
export type SalesOverview = NonNullable<Awaited<ReturnType<typeof salesOverview>>>;
