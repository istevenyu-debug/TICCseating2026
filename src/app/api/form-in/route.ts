import { getDb } from '@/db/client';
import { handle, readJson } from '@/lib/api';
import { getFormKey, ingestForm } from '@/lib/formIn';

export const dynamic = 'force-dynamic';

/** Google 表單（Apps Script）送來的回覆。網址帶 ?key=（後台「四、表單／收款」顯示） */
export async function POST(req: Request) {
  const db = await getDb();
  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!key || key !== (await getFormKey(db))) return new Response('forbidden', { status: 403 });
  return handle(async () => ingestForm(db, await readJson(req)));
}
