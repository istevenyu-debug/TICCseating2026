import { handle, originOf } from '@/lib/api';
import { rememberOrigin } from '@/lib/push';
import { requireAdmin } from '@/lib/adminApi';
import { getAdminState } from '@/lib/admin';
import { listNotifications, publicNotifyConfig } from '@/lib/notify';
import { listInvoices, publicEinvConfig } from '@/lib/einvoice';
import { listVips } from '@/lib/vip';
import { backupDir, listBackups } from '@/lib/backup';
import { getLineUrl, getPushLink, listPreorders, preorderMenu } from '@/lib/preorder';
import { getFormKey } from '@/lib/formIn';
import { checkinSummary, listGates } from '@/lib/ticket';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(async () => {
    const { db, user } = await requireAdmin();
    await rememberOrigin(db, originOf(req));
    return { user, ...(await getAdminState(db)), notify: await publicNotifyConfig(db), einvoice: await publicEinvConfig(db), invoices: await listInvoices(db), vips: await listVips(db), backups: { dir: backupDir(), list: listBackups().slice(0, 3), count: listBackups().length }, notifications: await listNotifications(db), preorders: await listPreorders(db), preMenu: (await preorderMenu(db)).items, form: { key: await getFormKey(db), base: (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '') }, pushLink: await getPushLink(db), lineUrl: await getLineUrl(db), gates: await listGates(db), checkins: await checkinSummary(db) };
  });
}
