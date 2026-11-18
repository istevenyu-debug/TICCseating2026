import { getDb } from '@/db/client';
import { handle } from '@/lib/api';
import { giftTicketPage } from '@/lib/joinGift';

export const dynamic = 'force-dynamic';

/** 揪團贈席電子票（入座者看的頁面） */
export async function GET(_req: Request, { params }: { params: { code: string } }) {
  return handle(async () => giftTicketPage(await getDb(), params.code));
}
