import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { boardByToken } from '@/lib/checkinBoard';

export const dynamic = 'force-dynamic';

/** 驗票即時看板（獨立連結，不用登入；只有數字） */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  return handle(async () => boardByToken(await getDb(), params.token));
}
