import { adminQuery, refundCardOrder, saveCardKeys, saveCardSettings } from '@/lib/card';
import { frameComboGroup, unframeComboGroup } from '@/lib/floor';
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
import { requestUpdate } from '@/lib/updater';
import { importBank, ignoreBank, clearBank, checkPaidMany } from '@/lib/bank';
import { restorePreorder, setPreorderRemits, cancelPreorder, confirmPreorder, markPreorderSeen, setPushLink, setLineCfg, checkPreorder, setPreorderItems, releasePreorder, updatePreorderEmail, resendReceived, clearMenuCache, setPreorderSettings, promoteWaitlist, setFlowImage } from '@/lib/preorder';
import { createGates, undoCheckin, updateGate } from '@/lib/ticket';
import { resetPreview, resetSales } from '@/lib/reset';
import { addVenues, decideReg, deleteReg, deleteVenue, editReg, mergeVenue, paintFloor3, presetFloor3, renewPickCode, sendLinks, sendPickLinks, setJoinSettings, setRegVenue, updateVenue } from '@/lib/join';
import { mergeGroups, moveReport, renameGroup } from '@/lib/joinGroup';
import { setCaps } from '@/lib/sales';
import { changeSlotSeat, clearJoinTest, deleteReport, extendTurn, lockSlots, markSent, nextRound, unlockSlots, restoreSlot, setSlotRep, skipTurn, tickQueue, uploadEra, voidSlot } from '@/lib/joinQueue';
import { cancelVip, createVip, setVipDays, setVipMode, updateVipSeats, updateVip } from '@/lib/vip';
import { invoiceLookup, invoicePrintUrl, backfillInvoices, createForPreorder, editInvoiceBuyer, issueBatch, recheckInvoice, saveEinvConfig, voidInvoice } from '@/lib/einvoice';

const joinBase = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

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
    maxPerOrder: z.number().int().min(1).max(200), holdMinutes: z.number().int().min(5).max(10080), payHours: z.number().int().min(1).max(720),
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
    name: z.string().trim().max(40), price: money, limitSets: z.number().int().min(0).max(10000), active: z.boolean(), autoHolders: z.boolean(), hidden: z.boolean(), description: z.string().trim().max(200),
    items: z.array(z.object({ zoneId: id, qty: z.number().int().min(1).max(20) })).max(10),
    gifts: z.array(z.object({ giftId: id, qty: z.number().int().min(0).max(999) })).max(20),
  }).partial() }),
  z.object({ action: z.literal('gift.create') }),
  z.object({ action: z.literal('gift.update'), id, values: z.object({ name: z.string().trim().max(30), unit: z.string().trim().min(1, '請填單位').max(6) }).partial() }),
  z.object({ action: z.literal('gift.delete'), id }),
  z.object({ action: z.literal('gift.show'), values: z.object({ buy: z.boolean(), invoice: z.boolean() }).partial() }),
  z.object({ action: z.literal('combo.delete'), id }),
  z.object({ action: z.literal('link.create'), name: z.string().trim().min(1, '請填寫姓名').max(40),
    phone: z.string().optional().default('').transform(normalizePhone).pipe(z.string().regex(/^(09\d{8})?$/, '手機應為 09 開頭的 10 位數字，例如 0912-345-678（不寄簡訊可留空）')),
    quota: z.number().int().min(0).max(200), expiresAt: z.string(), note: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('link.update'), id, values: z.object({
    quota: z.number().int().min(0).max(200), expiresAt: z.string(), status: z.enum(['active', 'disabled']),
  }).partial() }),
  z.object({ action: z.literal('order.seen'), id }),
  z.object({ action: z.literal('order.confirm'), id }),
  z.object({ action: z.literal('order.cancel'), id, reason: z.string({ required_error: '請填寫取消原因' }).trim().min(2, '請填寫取消原因').max(100) }),
  z.object({ action: z.literal('order.delete'), id }),
  z.object({ action: z.literal('notify.save'), values: z.object({
    'email.host': z.string().max(200), 'email.port': z.string().max(6), 'email.user': z.string().max(200), 'email.pass': z.string().max(200),
    'email.fromName': z.string().max(60), 'sms.url': z.string().max(300), 'sms.user': z.string().max(100), 'sms.pass': z.string().max(200),
  }).partial() }),
  z.object({ action: z.literal('notify.test'), channel: z.enum(['sms', 'email']), to: z.string().max(200) }),
  z.object({ action: z.literal('notify.resend'), id }),
  z.object({ action: z.literal('preorder.confirm'), id, items: z.array(z.object({ kind: z.enum(['combo', 'zone']), id: z.number().int().positive(), qty: z.number().int().min(0).max(200) })).max(30).optional() }),
  z.object({ action: z.literal('vip.create'), name: z.string().trim().min(1, '請填寫姓名').max(40), phone: z.string().max(20), email: z.string().trim().max(120),
    seatIds: z.array(z.string()).min(1, '請在座位圖上選取座位').max(60), mode: z.enum(['scheduled', 'now', 'none']), note: z.string().max(200).optional(),
    referrer: z.string({ required_error: '請選推薦人；沒有請點「無」' }).trim().min(1, '請選推薦人；沒有請點「無」').max(40) }),
  z.object({ action: z.literal('vip.update'), id, name: z.string().trim().min(1, '請填寫姓名').max(40), phone: z.string().max(20), email: z.string().trim().max(120),
    referrer: z.string({ required_error: '請選推薦人；沒有請點「無」' }).trim().min(1, '請選推薦人；沒有請點「無」').max(40), note: z.string().max(200) }),
  z.object({ action: z.literal('vip.seats'), id, seatIds: z.array(z.string()).min(1, '請在座位圖上選取座位').max(60) }),
  z.object({ action: z.literal('vip.mode'), id, mode: z.enum(['scheduled', 'now', 'none']) }),
  z.object({ action: z.literal('vip.cancel'), id }),
  z.object({ action: z.literal('vip.days'), days: z.number().int().min(0).max(60) }),
  z.object({ action: z.literal('join.settings'), values: z.record(z.unknown()) }),
  z.object({ action: z.literal('join.links.send'), ids: z.array(id).max(500).optional() }),
  z.object({ action: z.literal('join.reg.renew'), id }),
  z.object({ action: z.literal('join.pick.send'), ids: z.array(id).max(500).optional() }),
  z.object({ action: z.literal('join.lock') }),
  z.object({ action: z.literal('join.unlock') }),
  z.object({ action: z.literal('join.clear'), withRegs: z.boolean().optional() }),
  z.object({ action: z.literal('join.paint'), kind: z.enum(['gift', 'era', 'vol', 'sale']), seatIds: z.array(z.string().max(16)).min(1).max(800) }),
  z.object({ action: z.literal('join.preset'), which: z.enum(['side', 'middle']) }),
  z.object({ action: z.literal('join.nextRound') }),
  z.object({ action: z.literal('join.extend'), minutes: z.number().int().min(1).max(30).optional() }),
  z.object({ action: z.literal('join.era.upload'), rows: z.array(z.unknown()).min(1).max(50000), tickets: z.array(z.unknown()).max(50000).optional() }),
  z.object({ action: z.literal('sales.caps'), caps: z.record(z.string().max(40), z.number().int().min(0).max(10000)) }),
  z.object({ action: z.literal('join.report.delete'), id }),
  z.object({ action: z.literal('join.group.rename'), id, name: z.string().max(60) }),
  z.object({ action: z.literal('join.group.merge'), id, into: id }),
  z.object({ action: z.literal('join.report.move'), id, to: id }),
  z.object({ action: z.literal('join.queue.skip') }),
  z.object({ action: z.literal('join.slot.restore'), id }),
  z.object({ action: z.literal('join.slot.void'), id, reason: z.string().max(100) }),
  z.object({ action: z.literal('join.slot.seat'), id, seatId: z.string().max(16) }),
  z.object({ action: z.literal('join.slot.rep'), id, repName: z.string().max(60), repPhone: z.string().max(30) }),
  z.object({ action: z.literal('join.sent'), sent: z.boolean(), ids: z.array(id).max(1000).optional() }),
  z.object({ action: z.literal('join.venue.add'), names: z.array(z.string().max(60)).min(1).max(500) }),
  z.object({ action: z.literal('join.venue.update'), id, values: z.object({ name: z.string().max(60), active: z.boolean() }).partial() }),
  z.object({ action: z.literal('join.venue.merge'), id, into: id }),
  z.object({ action: z.literal('join.venue.delete'), id }),
  z.object({ action: z.literal('join.reg.venue'), id, venueId: id.optional(), newName: z.string().max(60).optional() }),
  z.object({ action: z.literal('join.reg.decide'), id, status: z.enum(['approved', 'rejected', 'pending']), reason: z.string().max(100).optional() }),
  z.object({ action: z.literal('join.reg.edit'), id, values: z.record(z.unknown()) }),
  z.object({ action: z.literal('join.reg.delete'), id }),
  z.object({ action: z.literal('invoice.issue'), ids: z.array(id).min(1).max(500), force: z.boolean().optional() }),
  z.object({ action: z.literal('invoice.edit'), id, invType: z.enum(['member', 'mobile', 'cert', 'donate', 'company']), invCode: z.string().max(20), invTitle: z.string().max(60) }),
  z.object({ action: z.literal('invoice.recheck'), id }),
  z.object({ action: z.literal('invoice.backfill') }),
  z.object({ action: z.literal('invoice.void'), id, reason: z.string().trim().min(1, '請填寫作廢原因').max(20), reopen: z.boolean().optional() }),
  z.object({ action: z.literal('einvoice.save'), reason: z.string().trim().max(100).optional(), values: z.object({
    enabled: z.enum(['0', '1']), mode: z.enum(['mock', 'test', 'prod']), timing: z.enum(['auto', 'review']), taxType: z.enum(['1', '3']),
    merchantId: z.string().trim().max(10), hashKey: z.string().max(64), hashIV: z.string().max(64), itemName: z.string().trim().max(40),
  }).partial() }),
  z.object({ action: z.literal('preorder.cancel'), id, reason: z.string({ required_error: '請填寫取消原因' }).trim().min(2, '請填寫取消原因').max(100) }),
  z.object({ action: z.literal('preorder.seen'), id }),
  z.object({ action: z.literal('preorder.pushLink'), on: z.boolean() }),
  z.object({ action: z.literal('preorder.email'), id, email: z.string().max(120), resend: z.boolean().optional() }),
  z.object({ action: z.literal('preorder.settings'), rateLimit: z.number().int().min(1).max(10000).optional(), waitlistCap: z.number().int().min(0).max(1000).optional(), intro: z.string().max(5000).optional() }),
  z.object({ action: z.literal('preorder.promote'), id }),
  z.object({ action: z.literal('preorder.flowImage'), dataUrl: z.string().max(4_000_000).nullable() }),
  z.object({ action: z.literal('preorder.resendReceived'), id }),
  z.object({ action: z.literal('app.update') }),
  z.object({ action: z.literal('preorder.check'), id, paid: z.boolean().optional(), line: z.array(z.string().max(20)).max(10).optional() }),
  z.object({ action: z.literal('invoice.print'), id }),
  z.object({ action: z.literal('invoice.lookup'), id }),
  z.object({ action: z.literal('preorder.restore'), id, notify: z.boolean() }),
  z.object({ action: z.literal('preorder.remits'), id, remits: z.array(z.unknown()).max(5) }),
  z.object({ action: z.literal('preorder.checkMany'), ids: z.array(z.number().int().positive()).max(2000), paid: z.boolean() }),
  z.object({ action: z.literal('bank.import'), grid: z.array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(40)).max(5000) }),
  z.object({ action: z.literal('bank.ignore'), id, on: z.boolean() }),
  z.object({ action: z.literal('bank.clear') }),
  z.object({ action: z.literal('preorder.items'), id, items: z.array(z.object({ kind: z.enum(['combo', 'zone']), id: z.number().int().positive(), qty: z.number().int().min(0).max(200) })).max(30) }),
  z.object({ action: z.literal('preorder.release'), id, keys: z.array(z.string().regex(/^(combo|zone):\d+$/)).min(1).max(30) }),
  z.object({ action: z.literal('preorder.line'), groups: z.array(z.object({ name: z.string(), url: z.string() })).max(8), map: z.record(z.string(), z.number()) }),
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
  z.object({ action: z.literal('floor3.frame'), seatIds: z.array(z.string().max(16)).min(1).max(40) }),
  z.object({ action: z.literal('floor3.unframe'), seatId: z.string().max(16) }),
  z.object({ action: z.literal('floor3.settings'), values: z.object({
    open: z.boolean(), saleStart: z.string().nullable(), saleEnd: z.string().nullable(), credit: z.boolean(),
    refundOn: z.boolean(), refundDays: z.number().int().min(0).max(60), refundFeePct: z.number().min(0).max(10),
  }).partial() }),
  z.object({ action: z.literal('floor3.keys'), values: z.object({
    mode: z.enum(['test', 'prod']), merchantId: z.string().trim().max(10), hashKey: z.string().max(64), hashIV: z.string().max(64), checkCode: z.string().max(20),
  }).partial() }),
  z.object({ action: z.literal('floor3.query'), id }),
  z.object({ action: z.literal('floor3.refund'), id, fee: z.number().int().min(0).optional(), late: z.boolean().optional() }),
]);

/** 寄出待寄通知，並回報這筆訂單或連結剛產生的通知結果 */
async function deliver(db: Db, by: { orderId?: number; linkId?: number; templates?: string[] }) {
  await dispatchQueued(db);
  await dispatchQueued(db); // 若剛好碰上背景寄信，第一次只是等它跑完；再跑一次才會寄到剛產生的這封
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
    clearMenuCache(); // 後台改了設定：認購頁下一次就拿最新的
    // 主管／網管才能做的：電子發票、招待
    const mustBeAdmin = () => { if (user.role !== 'admin') throw new BookingError('FORBIDDEN', '這項操作需要主管或網管帳號'); };
    switch (a.action) {
      case 'event.update': return A.updateEventSettings(db, who, a.values);
      case 'publish': return A.publish(db, who);
      case 'floor3.frame': mustBeAdmin(); return frameComboGroup(db, who, a.seatIds);
      case 'floor3.unframe': mustBeAdmin(); return unframeComboGroup(db, who, a.seatId);
      case 'floor3.settings': mustBeAdmin(); return saveCardSettings(db, who, a.values);
      case 'floor3.keys': mustBeAdmin(); return saveCardKeys(db, who, a.values);
      case 'floor3.query': mustBeAdmin(); return adminQuery(db, who, a.id);
      case 'floor3.refund': {
        mustBeAdmin();
        const r = await refundCardOrder(db, who, a.id, { fee: a.fee, late: a.late });
        dispatchQueued(db).catch((e) => console.error('通知寄送失敗', e));
        return r;
      }
      case 'zone.create': return A.createZone(db, who);
      case 'zone.update': return A.updateZone(db, who, a.id, a.values);
      case 'zone.delete': return A.deleteZone(db, who, a.id);
      case 'zone.assignRule': return A.assignZoneByRule(db, who, a.zoneId, a.rows, a.blocks);
      case 'zone.assignSeats': return A.assignZoneSeats(db, who, a.zoneId, a.seatIds);
      case 'usage.assignSeats': return A.setSeatUsage(db, who, a.usageId, a.seatIds);
      case 'combo.create': return A.createCombo(db, who);
      case 'combo.update': return A.updateCombo(db, who, a.id, a.values);
      case 'combo.delete': return A.deleteCombo(db, who, a.id);
      case 'gift.create': return A.createGift(db, who);
      case 'gift.update': return A.updateGift(db, who, a.id, a.values);
      case 'gift.delete': return A.deleteGift(db, who, a.id);
      case 'gift.show': return A.setGiftShow(db, who, a.values);
      case 'link.create': { const l = await A.createInviteLink(db, who, { name: a.name, phone: a.phone, quota: a.quota, expiresAt: endOfDay(a.expiresAt), note: a.note }, originOf(req)); return { ...l, delivery: await deliver(db, { linkId: l.id }) }; }
      case 'link.update': {
        const { expiresAt, ...rest } = a.values;
        return A.updateInviteLink(db, who, a.id, { ...rest, ...(expiresAt ? { expiresAt: endOfDay(expiresAt) } : {}) });
      }
      case 'order.seen': return A.markOrderSeen(db, a.id);
      case 'order.confirm': { const r = await A.confirmPayment(db, who, a.id, {}, new Date(), originOf(req)); return { ...r, delivery: await deliver(db, { orderId: a.id }) }; }
      case 'vip.create': {
        mustBeAdmin();
        const phone = a.phone.trim() ? normalizePhone(a.phone) : '';
        if (phone && !/^09\d{8}$/.test(phone)) throw new BookingError('INVALID', '手機應為 09 開頭的 10 位數字');
        if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new BookingError('INVALID', 'Email 格式不正確');
        const r = await createVip(db, who, { ...a, phone }, originOf(req));
        return { ...r, delivery: a.mode === 'now' ? await deliver(db, { orderId: r.orderId }) : undefined };
      }
      case 'vip.update': {
        mustBeAdmin();
        const phone = a.phone.trim() ? normalizePhone(a.phone) : '';
        if (phone && !/^09\d{8}$/.test(phone)) throw new BookingError('INVALID', '手機應為 09 開頭的 10 位數字');
        if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new BookingError('INVALID', 'Email 格式不正確');
        return updateVip(db, who, a.id, { ...a, phone }, originOf(req));
      }
      case 'vip.seats': mustBeAdmin(); return updateVipSeats(db, who, a.id, a.seatIds, originOf(req));
      case 'vip.mode': { mustBeAdmin(); const r = await setVipMode(db, who, a.id, a.mode, originOf(req)); return { ...r, delivery: a.mode === 'now' ? await deliver(db, { orderId: a.id }) : undefined }; }
      case 'vip.cancel': mustBeAdmin(); return cancelVip(db, who, a.id);
      case 'vip.days': mustBeAdmin(); return setVipDays(db, who, a.days);
      case 'join.settings': { mustBeAdmin(); const r = await setJoinSettings(db, who, a.values); if (await tickQueue(db, joinBase(req))) dispatchQueued(db).catch(() => undefined); return r; }
      case 'join.links.send': { const r = await sendLinks(db, who, joinBase(req), a.ids); dispatchQueued(db).catch(() => undefined); return r; }
      case 'join.reg.renew': return renewPickCode(db, who, a.id);
      case 'join.pick.send': { const r = await sendPickLinks(db, who, joinBase(req), a.ids); dispatchQueued(db).catch(() => undefined); return r; }
      case 'join.lock': mustBeAdmin(); return lockSlots(db, who);
      case 'join.unlock': mustBeAdmin(); return unlockSlots(db, who);
      case 'join.clear': mustBeAdmin(); return clearJoinTest(db, who, !!a.withRegs);
      case 'join.paint': return paintFloor3(db, who, a.kind, a.seatIds);
      case 'join.preset': return presetFloor3(db, who, a.which);
      case 'join.nextRound': mustBeAdmin(); return nextRound(db, who);
      case 'join.extend': return extendTurn(db, who, a.minutes ?? 5);
      case 'sales.caps': mustBeAdmin(); return setCaps(db, who, a.caps);
      case 'join.era.upload': { const r = await uploadEra(db, who, a.rows, new Date(), joinBase(req), a.tickets); dispatchQueued(db).catch(() => undefined); return r; }
      case 'join.report.delete': mustBeAdmin(); return deleteReport(db, who, a.id);
      case 'join.group.rename': return renameGroup(db, who, a.id, a.name);
      case 'join.group.merge': mustBeAdmin(); return mergeGroups(db, who, a.id, a.into);
      case 'join.report.move': return moveReport(db, who, a.id, a.to);
      case 'join.queue.skip': { const r = await skipTurn(db, who); if (await tickQueue(db, joinBase(req))) dispatchQueued(db).catch(() => undefined); return r; }
      case 'join.slot.restore': return restoreSlot(db, who, a.id);
      case 'join.slot.void': mustBeAdmin(); return voidSlot(db, who, a.id, a.reason);
      case 'join.slot.seat': return changeSlotSeat(db, who, a.id, a.seatId);
      case 'join.slot.rep': return setSlotRep(db, who, a.id, { repName: a.repName, repPhone: a.repPhone });
      case 'join.sent': return markSent(db, who, a.sent, a.ids);
      case 'join.venue.add': return addVenues(db, who, a.names);
      case 'join.venue.update': return updateVenue(db, who, a.id, a.values);
      case 'join.venue.merge': return mergeVenue(db, who, a.id, a.into);
      case 'join.venue.delete': return deleteVenue(db, who, a.id);
      case 'join.reg.venue': return setRegVenue(db, who, a.id, { venueId: a.venueId, newName: a.newName });
      case 'join.reg.decide': return decideReg(db, who, a.id, a.status, a.reason ?? '');
      case 'join.reg.edit': return editReg(db, who, a.id, a.values);
      case 'join.reg.delete': return deleteReg(db, who, a.id);
      case 'invoice.issue': mustBeAdmin(); return issueBatch(db, a.ids, who, !!a.force);
      case 'invoice.edit': mustBeAdmin(); return editInvoiceBuyer(db, a.id, who, a);
      case 'invoice.recheck': mustBeAdmin(); return recheckInvoice(db, a.id, who);
      case 'invoice.backfill': mustBeAdmin(); return backfillInvoices(db, who);
      case 'invoice.void': mustBeAdmin(); return voidInvoice(db, a.id, who, a.reason, !!a.reopen);
      case 'einvoice.save': mustBeAdmin(); return saveEinvConfig(db, who, a.values, a.reason ?? '');
      case 'order.cancel': { await A.cancelOrder(db, who, a.id, a.reason); return { delivery: await deliver(db, { orderId: a.id }) }; }
      case 'order.delete': return A.deleteOrder(db, who, a.id);
      case 'notify.save': return saveNotifyConfig(db, who, a.values);
      case 'notify.test': return sendTest(db, a.channel, a.to);
      case 'notify.resend': return resendNotification(db, who, a.id);
      case 'preorder.confirm': {
        const r = await confirmPreorder(db, who, a.id, originOf(req), new Date(), a.items);
        const delivery = await deliver(db, { linkId: r.linkId, templates: ['invite', 'preorder_link'] });
        if (r.fromForm) return { ...r, delivery, invoice: null }; // 表單來的：發票等賣完再處理
        // 收款開發票：建立待開發票並由電腦核對；「即開」且沒有異常就立刻開立
        const inv = await createForPreorder(db, a.id, who);
        return { ...r, delivery, invoice: inv && { status: inv.status, invoiceNo: inv.invoiceNo, checks: inv.checks, error: inv.error } };
      }
      case 'preorder.cancel': await cancelPreorder(db, who, a.id, a.reason); dispatchQueued(db).catch(() => undefined); return true;
      case 'preorder.seen': return markPreorderSeen(db, a.id);
      case 'preorder.pushLink': return setPushLink(db, who, a.on);
      case 'preorder.email': {
        const r = await updatePreorderEmail(db, who, a.id, a.email, !!a.resend, originOf(req));
        return { ...r, delivery: r.resent && r.linkId ? (await deliver(db, { linkId: r.linkId, templates: ['preorder_link'] })).slice(0, 1) : [] };
      }
      case 'preorder.settings': return setPreorderSettings(db, who, { rateLimit: a.rateLimit, waitlistCap: a.waitlistCap, intro: a.intro });
      case 'preorder.promote': return promoteWaitlist(db, who, a.id);
      case 'preorder.flowImage': return setFlowImage(db, who, a.dataUrl);
      case 'app.update': mustBeAdmin(); return requestUpdate(db, who);
      case 'preorder.resendReceived': {
        const r = await resendReceived(db, who, a.id);
        await dispatchQueued(db);
        const [n] = await db.select().from(t.notification).where(eq(t.notification.id, r.notificationId));
        return { email: r.email, status: n?.status, error: n?.error };
      }
      case 'preorder.check': return checkPreorder(db, who, a.id, { paid: a.paid, line: a.line });
      case 'invoice.print': return invoicePrintUrl(db, a.id);
      case 'invoice.lookup': return invoiceLookup(db, a.id);
      case 'preorder.restore': { const r = await restorePreorder(db, who, a.id, a.notify); if (a.notify) dispatchQueued(db).catch(() => undefined); return r; }
      case 'preorder.remits': return setPreorderRemits(db, who, a.id, a.remits);
      case 'preorder.checkMany': return checkPaidMany(db, who, a.ids, a.paid);
      case 'bank.import': return importBank(db, who, a.grid);
      case 'bank.ignore': return ignoreBank(db, who, a.id, a.on);
      case 'bank.clear': return clearBank(db, who);
      case 'preorder.items': return setPreorderItems(db, who, a.id, a.items);
      case 'preorder.release': {
        const r = await releasePreorder(db, who, a.id, a.keys, originOf(req));
        return { ...r, delivery: r.email ? (await deliver(db, { linkId: r.linkId, templates: ['preorder_link'] })).slice(0, 1) : [] };
      }
      case 'preorder.line': return setLineCfg(db, who, { groups: a.groups, map: a.map });
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
