import { getDb } from '@/db/client';
import { getFlowImage } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/**
 * 認購頁的流程說明圖：/buy/flow/<版本>.jpg。
 * 網址含版本（換圖就換網址），可放心長期快取；副檔名讓 Cloudflare 自動在各地快取，家裡電腦只需送出一次。
 */
export async function GET(_req: Request, { params }: { params: { file: string } }) {
  const img = await getFlowImage(await getDb());
  if (!img) return new Response('not found', { status: 404 });
  const ver = params.file.replace(/\.(jpg|png|webp)$/, '');
  if (ver !== img.ver) return new Response(null, { status: 302, headers: { location: `/buy/flow/${img.ver}.${img.type === 'image/png' ? 'png' : img.type === 'image/webp' ? 'webp' : 'jpg'}`, 'cache-control': 'no-store' } });
  return new Response(new Uint8Array(img.data), { headers: { 'content-type': img.type, 'cache-control': 'public, max-age=31536000, immutable' } });
}
