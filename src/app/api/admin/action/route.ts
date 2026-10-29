import { z } from 'zod';
import { handle, originOf, readJson } from '@/lib/api';
import { requireAdmin } from '@/lib/adminApi';
import { BookingError } from '@/lib/booking';
import * as A from '@/lib/admin';
import { normalizePhone } from '@/lib/validation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { Db } from '@/db/client';
import { dispatchQueued, resendNotification, saveNotifyConfig, sendTest } from '@/lib/notify';
import { rememberOrigin } from '@/lib/push';
import { cancelPreorder, confirmPreorder, markPreorderSeen } from '@/lib/preorder';
import { createGates, undoCheckin, updateGate } from '@/lib/ticket';
import { resetPreview, resetSales } from '@/lib/reset';

export const dynamic = 'force-dynamic';

const id = z.number().int().positive();
const money = z.number().int().min(0).max(10_000_000);
const date = z.string().nullable().transform((s) => (s ? new Date(s) : null))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), '日期格式不正確');

const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('event.update'), values: z.object({
    name: z.string().trim().min(1, '請填寫演出名稱').max(80),
    showAt: z.string().min(1, '請填寫演出時間').transform((s) => new Date(s)).refine((d) => !Number.isNaN(d.getTime()), '演出時間格式不正確'),
    saleOpen: z.boolean(), saleStart: date, saleEnd: date,
    maxPerOrder: z.number().int().min(1).max(200), holdMinutes: z.number().int().min(5).max(120), payHours: z.number().int().min(1).max(720),
    bankName: z.string().max(80), bankAccount: z.string().max(40), accountName: z.string().max(80), vipInstalled: z.boolean(), preorderOpen: z.boolean(),
  }).partial() }),
  z.object({ action: z.literal('publish') }),
  z.object({ action: z.literal('zone.create') }),
  z.object({ action: z.literal('zone.update'), id, values: z.object({
    name: z.string().trim().max(30), price: money, color: z.string(), open: z.boolean(),
  }).partial() }),
  z.object({ action: z.literal('zone.delete'), id }),
  z.object({ action: z.literal('zone.assignRule'), zoneId: id, rows: z.array(z.number().int().min(-1).max(12)).min(1), blocks: z.array(z.enum(['L2', 'L1', 'C0', 'R1', 'R2'])) }),
  z.object({ action: z.literal('zone.assignSeats'), zoneId: id, seatIds: z.array(z.string().max(16)).min(1).max(600) }),
  z.object({ action: z.literal('usage.assignSeats'), usageId: id, seatIds: z.array(z.string().max(16)).min(1).max(600) }),
  z.object({ action: z.literal('combo.create') }),
  z.object({ action: z.literal('combo.update'), id, values: z.object({
    name: z.string().trim().max(40), price: money, limitSets: z.number().int().min(0).max(10000), active: z.boolean(), autoHolders: z.boolean(),
    items: z.array(z.object({ zoneId: id, qty: z.number().int().min(1).max(20) })).max(10),
  }).partial() }),
  z.object({ action: z.literal('combo.delete'), id }),
  z.object({ action: z.literal('link.create'), name: z.string().trim().min(1, '請填寫姓名').max(40),
    phone: z.string().optional().default('').transform(normalizePhone).pipe(z.string().regex(/^(09\d{8})?$/, '手機應為 09 開頭的 10 位數字，例如 0912-345-678（不寄簡訊可留空）')),
    quota: z.number().int().min(0).max(200), expiresAt: z.string(), note: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('link.update'), id, values: z.object({
    quota: z.number().int().min(0).max(200), expiresAt: z.string(), status: z.enum(['active', 'disabled']),
  }).partial() }),
  z.object({ action: z.literal('order.seen'), id }),
  z.object({ action: z.literal('order.confirm'), id }),
  z.object({ action: z.literal('order.cancel'), id }),
  z.object({ action: z.literal('order.delete'), id }),
  z.object({ action: z.literal('notify.save'), values: z.object({
    'email.host': z.string().max(200), 'email.port': z.string().max(6), 'email.user': z.string().max(200), 'email.pass': z.string().max(200),
    'email.fromName': z.string().max(60), 'sms.url': z.string().max(300), 'sms.user': z.string().max(100), 'sms.pass': z.string().max(200),
  }).partial() }),
  z.object({ action: z.literal('notify.test'), channel: z.enum(['sms', 'email']), to: z.string().max(200) }),
  z.object({ action: z.literal('notify.resend'), id }),
  z.object({ action: z.literal('preorder.confirm'), id }),
  z.object({ action: z.literal('preorder.cancel'), id, reason: z.string().trim().max(100).optional() }),
  z.object({ action: z.literal('preorder.seen'), id }),
  z.object({ action: z.literal('gate.create'), names: z.array(z.string().trim().min(1).max(20)).min(1).max(20) }),
  z.object({ action: z.literal('gate.update'), id, values: z.object({ active: z.boolean(), renewToken: z.boolean(), name: z.string().trim().min(1).max(20) }).partial() }),
  z.object({ action: z.literal('checkin.undo'), id }),
  z.object({ action: z.literal('reset.preview') }),
  z.object({ action: z.literal('reset.run'), confirm: z.literal('清除', { errorMap: () => ({ message: '請輸入「清除」兩個字確認' }) }),
    keepLinkIds: z.array(id).max(500), close: z.boolean() }),
  z.object({ action: z.literal('bundle.create'), rows: z.array(z.number().int()).max(20), blocks: z.array(z.string()).max(5), size: z.number().int() }),
  z.object({ action: z.literal('bundle.auto'), rows: z.array(z.number().int()).max(20), blocks: z.array(z.string()).max(5), size: z.number().int(),
    shape: z.enum(['row', 'band2', 'band3']), crossAisle: z.boolean(), skip: z.array(z.string()).max(600) }),
  z.object({ action: z.literal('bundle.manual'), seatIds: z.array(z.string()).max(40) }),
  z.object({ action: z.literal('bundle.presets.save'), presets: z.array(z.object({
    name: z.string().trim().min(1, '請填寫預設名稱').max(40), rows: z.array(z.number().int()).min(1, '每條預設都要選排數').max(20),
    blocks: z.array(z.string()).max(5), size: z.number().int().min(2, '每組至少 2 位').max(40),
    shape: z.enum(['row', 'band2', 'band3']), crossAisle: z.boolean(), skip: z.array(z.string()).max(600),
  })).max(20).nullable() }),
  z.object({ action: z.literal('bundle.snapshot.save') }),
  z.object({ action: z.literal('bundle.snapshot.restore'), which: z.enum(['saved', 'undo']) }),
  z.object({ action: z.literal('bundle.presets.apply'), index: z.number().int().min(0).optional() }),
  z.object({ action: z.literal('bundle.remove'), seatIds: z.array(z.string()).max(600) }),
  z.object({ action: z.literal('bundle.clear'), rows: z.array(z.number().int()).max(20), blocks: z.array(z.string()).max(5) }),
]);

/** 寄出待寄通知，並回報這筆訂單或連結剛產生的通知結果 */
async function deliver(db: Db, by: { orderId?: number; linkId?: number; templates?: string[] }) {
  await dispatchQueued(db);
  const rows = await db.select({ channel: t.notification.channel, status: t.notification.status, error: t.notification.error })
    .from(t.notification)
    .where(by.orderId ? eq(t.notification.orderId, by.orderId)
      : and(eq(t.notification.linkId, by.linkId!), inArray(t.notification.template, by.templates ?? ['invite'])))
    .orderBy(desc(t.notification.id)).limit(3);
  return rows;
}

const endOfDay = (s: string) => {
  const d = new Date(/T/.test(s) ? s : `${s}T23:59:59+08:00`);
  if (Number.isNaN(d.getTime())) throw new BookingError('INVALID', '日期格式不正確');
  return d;
};

export async function POST(req: Request) {
  return handle(async () => {
    const { db, user } = await requireAdmin();
    await rememberOrigin(db, originOf(req));
    const p = action.safeParse(await readJson(req));
    if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料格式不正確');
    const a = p.data;
    const who = user.username;
    switch (a.action) {
      case 'event.update': return A.updateEventSettings(db, who, a.values);
      case 'publish': return A.publish(db, who);
      case 'zone.create': return A.createZone(db, who);
      case 'zone.update': return A.updateZone(db, who, a.id, a.values);
      case 'zone.delete': return A.deleteZone(db, who, a.id);
      case 'zone.assignRule': return A.assignZoneByRule(db, who, a.zoneId, a.rows, a.blocks);
      case 'zone.assignSeats': return A.assignZoneSeats(db, who, a.zoneId, a.seatIds);
      case 'usage.assignSeats': return A.setSeatUsage(db, who, a.usageId, a.seatIds);
      case 'combo.create': return A.createCombo(db, who);
      case 'combo.update': return A.updateCombo(db, who, a.id, a.values);
      case 'combo.delete': return A.deleteCombo(db, who, a.id);
      case 'link.create': { const l = await A.createInviteLink(db, who, { name: a.name, phone: a.phone, quota: a.quota, expiresAt: endOfDay(a.expiresAt), note: a.note }, originOf(req)); return { ...l, delivery: await deliver(db, { linkId: l.id }) }; }
      case 'link.update': {
        const { expiresAt, ...rest } = a.values;
        return A.updateInviteLink(db, who, a.id, { ...rest, ...(expiresAt ? { expiresAt: endOfDay(expiresAt) } : {}) });
      }
      case 'order.seen': return A.markOrderSeen(db, a.id);
      case 'order.confirm': { const r = await A.confirmPayment(db, who, a.id, {}, new Date(), originOf(req)); return { ...r, delivery: await deliver(db, { orderId: a.id }) }; }
      case 'order.cancel': { await A.cancelOrder(db, who, a.id); return { delivery: await deliver(db, { orderId: a.id }) }; }
      case 'order.delete': return A.deleteOrder(db, who, a.id);
      case 'notify.save': return saveNotifyConfig(db, who, a.values);
      case 'notify.test': return sendTest(db, a.channel, a.to);
      case 'notify.resend': return resendNotification(db, who, a.id);
      case 'preorder.confirm': {
        const r = await confirmPreorder(db, who, a.id, originOf(req));
        return { ...r, delivery: await deliver(db, { linkId: r.linkId, templates: ['invite', 'preorder_link'] }) };
      }
      case 'preorder.cancel': await cancelPreorder(db, who, a.id, a.reason); dispatchQueued(db).catch(() => undefined); return true;
      case 'preorder.seen': return markPreorderSeen(db, a.id);
      case 'gate.create': return createGates(db, who, a.names);
      case 'gate.update': return updateGate(db, who, a.id, a.values);
      case 'checkin.undo': return undoCheckin(db, who, a.id);
      case 'reset.preview': return resetPreview(db);
      case 'reset.run': return resetSales(db, who, { keepLinkIds: a.keepLinkIds, close: a.close });
      case 'bundle.create': return A.bundleByRule(db, who, a.rows, a.blocks, a.size);
      case 'bundle.clear': return A.unbundleByRule(db, who, a.rows, a.blocks);
      case 'bundle.auto': return A.bundleAuto(db, who, { rows: a.rows, blocks: a.blocks, size: a.size, shape: a.shape, crossAisle: a.crossAisle, skip: a.skip });
      case 'bundle.manual': return A.bundleManual(db, who, a.seatIds);
      case 'bundle.presets.save': return A.saveBundlePresets(db, who, a.presets);
      case 'bundle.presets.apply': return A.applyBundlePresets(db, who, a.index);
      case 'bundle.snapshot.save': return A.saveBundleSnapshot(db, who);
      case 'bundle.snapshot.restore': return A.restoreBundleSnapshot(db, who, a.which);
      case 'bundle.remove': return A.bundleRemove(db, who, a.seatIds);
    }
  });
}
