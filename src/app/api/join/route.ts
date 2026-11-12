import { getDb } from '@/db/client';
import { clientIp, handle, originOf, readJson } from '@/lib/api';
import { groupMenu, groupSubmit } from '@/lib/joinGroup';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const base = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 揪團回報（共用連結）：開關、群清單（只有群名與遮蔽的負責人姓名） */
export async function GET() {
  return handle(async () => groupMenu(await getDb()));
}

/** 建群（只建群）或回報到某一群 */
export async function POST(req: Request) {
  return handle(async () => {
    const db = await getDb();
    const r = await groupSubmit(db, await readJson(req), clientIp(req), new Date(), base(req));
    if ('created' in r && r.created) dispatchQueued(db).catch(() => undefined); // 建群確認信
    return r;
  });
}
