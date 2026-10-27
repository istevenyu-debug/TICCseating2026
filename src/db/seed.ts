import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import * as t from './schema';
import { buildSeats, defaultZoneCode } from '@/lib/layout';

/** 寫入場館座位模板（已存在則略過） */
export async function seedVenue(db: Db) {
  const rows = buildSeats().map((s) => ({
    id: s.id, section: s.section, rowNo: s.rowNo, seatNo: s.seatNo, seatType: s.seatType,
    block: s.block, code: s.code, x: s.x, y: s.y,
  }));
  await db.insert(t.venueSeat).values(rows).onConflictDoNothing();
}

export interface CreateEventInput {
  name: string;
  showAt: Date;
  vipInstalled?: boolean;
  saleOpen?: boolean;
  maxPerOrder?: number;
  holdMinutes?: number;
  payHours?: number;
  bankName?: string;
  bankAccount?: string;
  accountName?: string;
}

/**
 * 建立場次，並依預設值建立票種、用途、購票方式與整份座位庫存，最後發布一次。
 * 預設內容只是起點，主辦方可在後台修改。
 */
export async function createEvent(db: Db, input: CreateEventInput) {
  return db.transaction(async (tx) => {
    const [ev] = await tx.insert(t.event).values({
      name: input.name,
      showAt: input.showAt,
      vipInstalled: input.vipInstalled ?? true,
      saleOpen: input.saleOpen ?? true,
      maxPerOrder: input.maxPerOrder ?? 21,
      holdMinutes: input.holdMinutes ?? 20,
      payHours: input.payHours ?? 48,
      bankName: input.bankName ?? '',
      bankAccount: input.bankAccount ?? '',
      accountName: input.accountName ?? '',
    }).returning();

    const defs = [
      { key: 'A', name: 'A區', color: '#b8ccf3', price: 3200 },
      { key: 'B', name: 'B區', color: '#c4e5cf', price: 2600 },
      { key: 'C', name: 'C區（側區）', color: '#f0dbb1', price: 1800 },
      { key: 'V', name: 'VIP', color: '#e6c3e5', price: 5000 },
      { key: 'W', name: '輪椅席', color: '#bde2ea', price: 1800 },
    ] as const;
    const zones = await tx.insert(t.priceZone)
      .values(defs.map((d, i) => ({ eventId: ev.id, name: d.name, color: d.color, price: d.price, sort: i })))
      .returning();
    const zoneId: Record<string, number> = Object.fromEntries(defs.map((d, i) => [d.key, zones[i].id]));

    const usages = await tx.insert(t.seatUsage).values([
      { eventId: ev.id, code: 'sale', name: '可售', sellable: true },
      { eventId: ev.id, code: 'hold-pr', name: '保留：公關', sellable: false },
      { eventId: ev.id, code: 'hold-sponsor', name: '保留：贊助商', sellable: false },
      { eventId: ev.id, code: 'closed', name: '不開放（設備/視線）', sellable: false },
    ]).returning();

    const combos = await tx.insert(t.combo).values([
      { eventId: ev.id, name: '單張購票', isSingle: true, sort: 0 },
      { eventId: ev.id, name: '雙人套票', price: 6080, limitSets: 40, sort: 1 },
      { eventId: ev.id, name: '買一A送二B', price: 3200, limitSets: 20, sort: 2 },
      { eventId: ev.id, name: '親子四人套票', price: 11520, limitSets: 20, sort: 3 },
    ]).returning();
    await tx.insert(t.comboItem).values([
      { comboId: combos[1].id, zoneId: zoneId.A, qty: 2 },
      { comboId: combos[2].id, zoneId: zoneId.A, qty: 1 },
      { comboId: combos[2].id, zoneId: zoneId.B, qty: 2 },
      { comboId: combos[3].id, zoneId: zoneId.A, qty: 4 },
    ]);

    const saleId = usages.find((u) => u.code === 'sale')!.id;
    await tx.insert(t.eventSeat).values(buildSeats().map((s) => ({
      eventId: ev.id, seatId: s.id, zoneId: zoneId[defaultZoneCode(s)], usageId: saleId,
    })));

    const published: t.Published = {
      open: ev.saleOpen, zoneIds: zones.map((z) => z.id), comboIds: combos.map((c) => c.id), at: new Date().toISOString(),
    };
    const [done] = await tx.update(t.event).set({ published }).where(eq(t.event.id, ev.id)).returning();
    return done;
  });
}

export async function createLink(db: Db, v: {
  eventId: number; code: string; name: string; phone: string; quota: number; expiresAt: Date;
}) {
  const [row] = await db.insert(t.inviteLink).values(v).returning();
  return row;
}

/** 設定某些座位的用途（例如保留席）；已有訂單的座位不變 */
export async function setUsage(db: Db, eventId: number, usageCode: string, seatIds: string[]) {
  const [u] = await db.select().from(t.seatUsage)
    .where(and(eq(t.seatUsage.eventId, eventId), eq(t.seatUsage.code, usageCode)));
  if (!u) throw new Error(`找不到用途 ${usageCode}`);
  await db.update(t.eventSeat).set({ usageId: u.id }).where(and(
    eq(t.eventSeat.eventId, eventId), inArray(t.eventSeat.seatId, seatIds), eq(t.eventSeat.status, 'free'),
  ));
}

/* ---------- 移除舊版自動建立的示範資料 ---------- */

/** 舊版第一次啟動時自動建立的示範連結（代碼、對象、手機三者都相符才算） */
const DEMO_LINKS = [
  { code: 'DEMO26', name: '測試購票人', phone: '0900000000' },
  { code: 'DEMO27', name: '第二位測試者', phone: '0900000001' },
];
const DEMO_EVENT_NAME = '2026 冬季音樂會（示範）';
const DEMO_BANK = { bankName: '範例銀行（代碼 000）', bankAccount: '000-00-0000000', accountName: '範例主辦單位' };
export const PLACEHOLDER_EVENT_NAME = '請在後台填寫演出名稱';

/**
 * 只刪除示範連結 DEMO26、DEMO27 與在這兩條連結下的訂單、通知；
 * 場次名稱與匯款帳戶「仍是示範文字」時才清掉。其他連結、訂單、票種、價格、座位設定都不動。
 * 每次啟動都會執行，沒有示範資料時什麼都不做。
 */
export async function removeDemoData(db: Db) {
  const found: { links: string[]; orders: number; renamed: boolean; bankCleared: boolean } = { links: [], orders: 0, renamed: false, bankCleared: false };
  await db.transaction(async (tx) => {
    for (const d of DEMO_LINKS) {
      const [l] = await tx.select().from(t.inviteLink)
        .where(and(eq(t.inviteLink.code, d.code), eq(t.inviteLink.name, d.name), eq(t.inviteLink.phone, d.phone), eq(t.inviteLink.kind, 'personal')));
      if (!l) continue;
      const os = await tx.select({ id: t.orders.id }).from(t.orders).where(eq(t.orders.linkId, l.id));
      const ids = os.map((o) => o.id);
      if (ids.length) {
        await tx.update(t.eventSeat).set({ status: 'free', orderId: null, holdUntil: null, version: sql`${t.eventSeat.version} + 1` }).where(inArray(t.eventSeat.orderId, ids));
        await tx.delete(t.notification).where(inArray(t.notification.orderId, ids));
        await tx.delete(t.payment).where(inArray(t.payment.orderId, ids));
        await tx.delete(t.orderSeat).where(inArray(t.orderSeat.orderId, ids));
        await tx.delete(t.orders).where(inArray(t.orders.id, ids));
      }
      await tx.delete(t.notification).where(eq(t.notification.linkId, l.id));
      await tx.delete(t.pushSub).where(eq(t.pushSub.linkId, l.id));
      await tx.delete(t.inviteLink).where(eq(t.inviteLink.id, l.id));
      found.links.push(d.code); found.orders += ids.length;
    }
    const r1 = await tx.update(t.event).set({ name: PLACEHOLDER_EVENT_NAME }).where(eq(t.event.name, DEMO_EVENT_NAME)).returning({ id: t.event.id });
    found.renamed = r1.length > 0;
    const r2 = await tx.update(t.event).set({ bankName: '', bankAccount: '', accountName: '' })
      .where(and(eq(t.event.bankName, DEMO_BANK.bankName), eq(t.event.bankAccount, DEMO_BANK.bankAccount), eq(t.event.accountName, DEMO_BANK.accountName)))
      .returning({ id: t.event.id });
    found.bankCleared = r2.length > 0;
    if (found.links.length || found.renamed || found.bankCleared) {
      await tx.insert(t.auditLog).values({ actor: 'system', action: 'remove_demo', target: 'demo', detail: JSON.stringify(found) });
    }
  });
  return found;
}
