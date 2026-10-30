import { requireAdmin } from '@/lib/adminApi';
import { exportAll, listBackups, toGz } from '@/lib/backup';

export const dynamic = 'force-dynamic';

/** 立即備份並下載（主管／網管） */
export async function GET() {
  try {
    const { db, user } = await requireAdmin();
    if (user.role !== 'admin') return new Response('這項操作需要主管或網管帳號', { status: 403 });
    const gz = toGz(await exportAll(db));
    const name = `ticc-${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/[-: ]/g, '').slice(0, 12)}.json.gz`;
    return new Response(gz, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(String((e as Error).message ?? e), { status: 401 });
  }
}

/** 備份清單（首頁顯示最近一次） */
export async function POST() {
  try {
    await requireAdmin();
    return Response.json({ ok: true, data: listBackups().slice(0, 5) });
  } catch (e) {
    return Response.json({ ok: false, message: String((e as Error).message ?? e) }, { status: 401 });
  }
}
