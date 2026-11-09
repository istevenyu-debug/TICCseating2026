import { getDb } from '@/db/client';
import { clientIp, handle, readJson } from '@/lib/api';
import { joinMenu, submitJoin } from '@/lib/join';

export const dynamic = 'force-dynamic';

/** 揪團登記頁：開關、團練場清單（不含個資） */
export async function GET() {
  return handle(async () => joinMenu(await getDb()));
}

/** 送出揪團登記 */
export async function POST(req: Request) {
  return handle(async () => submitJoin(await getDb(), await readJson(req), clientIp(req)));
}
