import { handle } from '@/lib/api';
import { requireAdmin } from '@/lib/adminApi';
import { getUpdateInfo } from '@/lib/updater';

export const dynamic = 'force-dynamic';

/** 後台首頁：版本與更新進度 */
export async function GET() {
  return handle(async () => { await requireAdmin(); return getUpdateInfo(); });
}
