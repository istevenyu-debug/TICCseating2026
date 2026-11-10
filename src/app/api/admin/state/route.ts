import { handle, originOf } from '@/lib/api';
import { rememberOrigin } from '@/lib/push';
import { requireAdmin } from '@/lib/adminApi';
import { getAdminState, recentAudit } from '@/lib/admin';
import { listNotifications, publicNotifyConfig } from '@/lib/notify';
import { listInvoices, publicEinvConfig } from '@/lib/einvoice';
import { listVips } from '@/lib/vip';
import { joinAdminState } from '@/lib/joinQueue';
import { backupDir, listBackups } from '@/lib/backup';
import { listBank } from '@/lib/bank';
import { floor3State } from '@/lib/card';
import { getFlowImage, getLineCfg, getPreorderSettings, getPushLink, listPreorders, preorderMenuFull } from '@/lib/preorder';
import { getFormKey } from '@/lib/formIn';
import { checkinSummary, listGates } from '@/lib/ticket';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(async () => {
    const { db, user } = await requireAdmin();
    await rememberOrigin(db, originOf(req));
    return { user, ...(await getAdminState(db)), notify: await publicNotifyConfig(db), einvoice: await publicEinvConfig(db), invoices: await listInvoices(db), vips: await listVips(db), backups: { dir: backupDir(), list: listBackups().slice(0, 3), count: listBackups().length }, notifications: await listNotifications(db), preorders: await listPreorders(db), bank: await listBank(db), preMenu: (await preorderMenuFull(db)).items, form: { key: await getFormKey(db), base: (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '') }, pushLink: await getPushLink(db), line: await getLineCfg(db), preorderSettings: await getPreorderSettings(db), flowImage: (await getFlowImage(db))?.ver ?? null, audit: await recentAudit(db), gates: await listGates(db), checkins: await checkinSummary(db), floor3: await floor3State(db), join: await joinAdminState(db, (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '')) };
  });
}
