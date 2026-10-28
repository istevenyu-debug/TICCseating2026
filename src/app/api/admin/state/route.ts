import { handle, originOf } from '@/lib/api';
import { rememberOrigin } from '@/lib/push';
import { requireAdmin } from '@/lib/adminApi';
import { getAdminState } from '@/lib/admin';
import { listNotifications, publicNotifyConfig } from '@/lib/notify';
import { listPreorders } from '@/lib/preorder';
import { checkinSummary, listGates } from '@/lib/ticket';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return handle(async () => {
    const { db, user } = await requireAdmin();
    await rememberOrigin(db, originOf(req));
    return { user, ...(await getAdminState(db)), notify: await publicNotifyConfig(db), notifications: await listNotifications(db), preorders: await listPreorders(db), gates: await listGates(db), checkins: await checkinSummary(db) };
  });
}
