/** 讓購票頁可「加入主畫面」（iPhone 需要加入主畫面後才能收手機推播） */
export const dynamic = 'force-dynamic';

export function GET(_req: Request, { params }: { params: { code: string } }) {
  const code = encodeURIComponent(params.code);
  return Response.json({
    name: '大會堂劃位', short_name: '劃位', lang: 'zh-Hant-TW',
    start_url: `/t/${code}`, scope: '/', id: `/t/${code}`, display: 'standalone',
    background_color: '#eef1f6', theme_color: '#1d3f8f',
    icons: [{ src: '/app-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
  }, { headers: { 'content-type': 'application/manifest+json' } });
}
