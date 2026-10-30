import { requireAdmin } from '@/lib/adminApi';
import { fromGz, importAll } from '@/lib/backup';

export const dynamic = 'force-dynamic';

/** 從備份檔還原（主管／網管）：上傳 .json.gz，網址帶 ?confirm=還原。搬到雲端時用來把家裡的資料搬上來 */
export async function POST(req: Request) {
  try {
    const { db, user } = await requireAdmin();
    if (user.role !== 'admin') return Response.json({ ok: false, message: '這項操作需要主管或網管帳號' }, { status: 403 });
    if (new URL(req.url).searchParams.get('confirm') !== '還原') return Response.json({ ok: false, message: '請輸入「還原」確認' }, { status: 400 });
    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return Response.json({ ok: false, message: '請選擇備份檔' }, { status: 400 });
    const b = fromGz(buf);
    const r = await importAll(db, b);
    return Response.json({ ok: true, data: { at: b.at, preorders: r.preorder, orders: r.orders, links: r.invite_link } });
  } catch (e) {
    return Response.json({ ok: false, message: `還原失敗，資料沒有變動：${String((e as Error).message ?? e).slice(0, 200)}` }, { status: 400 });
  }
}
