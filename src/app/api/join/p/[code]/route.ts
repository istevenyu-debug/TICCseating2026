import { getDb } from '@/db/client';
import { handle, originOf, readJson } from '@/lib/api';
import { BookingError } from '@/lib/booking';
import { pickPage, regByPick, rejoinQueue, saveDraft, submitPick } from '@/lib/joinQueue';
import { resendGiftQr, saveGiftSeats } from '@/lib/joinGift';
import { dispatchQueued } from '@/lib/notify';

export const dynamic = 'force-dynamic';
const base = (req: Request) => (process.env.PUBLIC_BASE_URL || originOf(req)).replace(/\/$/, '');

/** 負責人劃位頁：排隊看板、輪到時的座位 */
export async function GET(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const r = await pickPage(db, params.code, new Date(), base(req));
    dispatchQueued(db).catch(() => undefined);
    return r;
  });
}

/** 送出選位，或「我回來了」重新排隊 */
export async function POST(req: Request, { params }: { params: { code: string } }) {
  return handle(async () => {
    const db = await getDb();
    const body = await readJson(req) as { action?: string };
    if (body?.action === 'draft') return saveDraft(db, params.code, body);
    // 贈票取票方式：儲存每席方式、入座者；重寄某一席 QR 信
    if (body?.action === 'gift.save' || body?.action === 'gift.mail') {
      const me = await regByPick(db, params.code);
      const r = body.action === 'gift.save'
        ? await saveGiftSeats(db, `負責人:${me.headName}`, me.id, body, new Date(), base(req))
        : await resendGiftQr(db, `負責人:${me.headName}`, me.id, Number((body as { slotId?: unknown }).slotId), new Date(), base(req));
      dispatchQueued(db).catch(() => undefined);
      return r;
    }
    const r = body?.action === 'rejoin' ? await rejoinQueue(db, params.code)
      : body?.action === 'pick' ? await submitPick(db, params.code, body, new Date(), base(req))
        : (() => { throw new BookingError('INVALID', '不明的操作'); })();
    dispatchQueued(db).catch(() => undefined);
    return r;
  });
}
