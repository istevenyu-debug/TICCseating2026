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
  const tk = await db.select({ floor: t.joinEraTicket.floor, price: t.joinEraTicket.price, status: t.joinEraTicket.status, soldAt: t.joinEraTicket.soldAt, at: t.joinEraTicket.updatedAt })
    .from(t.joinEraTicket).where(eq(t.joinEraTicket.eventId, ev.id));
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

  return { now: now.toISOString(), twoM, era, silver: await eraSales(db, ev.id), daily, caps };
}
export type SalesOverview = NonNullable<Awaited<ReturnType<typeof salesOverview>>>;
