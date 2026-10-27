import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/adminApi';
import { getAdminState } from '@/lib/admin';
import { listNotifications, publicNotifyConfig } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handle(async () => {
    const { db, user } = await requireAdmin();
    return { user, ...(await getAdminState(db)), notify: await publicNotifyConfig(db), notifications: await listNotifications(db) };
  });
}
