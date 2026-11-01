import { getDb } from '@/db/client';
import { getFlowImage } from '@/lib/preorder';

export const dynamic = 'force-dynamic';

/** 預購單的流程說明圖（後台上傳）。網址帶 ?v= 版本，換圖就換網址 */
export async function GET() {
  const img = await getFlowImage(await getDb());
  if (!img) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(img.data), { headers: { 'content-type': img.type, 'cache-control': 'public, max-age=300' } });
}
