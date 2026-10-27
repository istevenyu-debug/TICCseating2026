import { z } from 'zod';
import { handle, readJson } from '@/lib/api';
import { requireAdmin } from '@/lib/adminApi';
import { BookingError } from '@/lib/booking';
import * as A from '@/lib/admin';
import { normalizePhone } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const id = z.number().int().positive();
const money = z.number().int().min(0).max(10_000_000);
const date = z.string().nullable().transform((s) => (s ? new Date(s) : null))
  .refine((d) => d === null || !Number.isNaN(d.getTime()), '日期格式不正確');

const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('event.update'), values: z.object({
    name: z.string().trim().min(1).max(80), saleOpen: z.boolean(), saleStart: date, saleEnd: date,
    maxPerOrder: z.number().int().min(1).max(200), holdMinutes: z.number().int().min(5).max(120), payHours: z.number().int().min(1).max(720),
    bankName: z.string().max(80), bankAccount: z.string().max(40), accountName: z.string().max(80), vipInstalled: z.boolean(),
    publicSaleStart: date, publicPerPhone: z.number().int().min(0).max(200),
  }).partial() }),
  z.object({ action: z.literal('link.createPublic') }),
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
    name: z.string().trim().max(40), price: money, limitSets: z.number().int().min(0).max(10000), active: z.boolean(),
    items: z.array(z.object({ zoneId: id, qty: z.number().int().min(1).max(20) })).max(10),
  }).partial() }),
  z.object({ action: z.literal('combo.delete'), id }),
  z.object({ action: z.literal('link.create'), name: z.string().trim().min(1).max(40),
    phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機格式應為 09xxxxxxxx')),
    quota: z.number().int().min(0).max(200), expiresAt: z.string() }),
  z.object({ action: z.literal('link.update'), id, values: z.object({
    quota: z.number().int().min(0).max(200), expiresAt: z.string(), status: z.enum(['active', 'disabled']),
  }).partial() }),
  z.object({ action: z.literal('order.seen'), id }),
  z.object({ action: z.literal('order.confirm'), id, date: z.string().min(1), amount: money, note: z.string().max(200).optional() }),
  z.object({ action: z.literal('order.cancel'), id }),
  z.object({ action: z.literal('order.delete'), id }),
]);

const endOfDay = (s: string) => {
  const d = new Date(/T/.test(s) ? s : `${s}T23:59:59+08:00`);
  if (Number.isNaN(d.getTime())) throw new BookingError('INVALID', '日期格式不正確');
  return d;
};

export async function POST(req: Request) {
  return handle(async () => {
    const { db, user } = await requireAdmin();
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
      case 'link.createPublic': return A.createPublicLink(db, who);
      case 'link.create': return A.createInviteLink(db, who, { name: a.name, phone: a.phone, quota: a.quota, expiresAt: endOfDay(a.expiresAt) });
      case 'link.update': {
        const { expiresAt, ...rest } = a.values;
        return A.updateInviteLink(db, who, a.id, { ...rest, ...(expiresAt ? { expiresAt: endOfDay(expiresAt) } : {}) });
      }
      case 'order.seen': return A.markOrderSeen(db, a.id);
      case 'order.confirm': return A.confirmPayment(db, who, a.id, { date: a.date, amount: a.amount, note: a.note });
      case 'order.cancel': return A.cancelOrder(db, who, a.id);
      case 'order.delete': return A.deleteOrder(db, who, a.id);
    }
  });
}
