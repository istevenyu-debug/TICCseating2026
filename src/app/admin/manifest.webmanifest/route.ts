/** 後台「加入主畫面」：桌面圖示直接開後台。用瀏覽器模式開啟（下載 Excel、分享圖片較穩定） */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    name: '劃位後台', short_name: '劃位後台', lang: 'zh-Hant-TW',
    start_url: '/admin', scope: '/admin', id: '/admin', display: 'browser',
    background_color: '#eef1f6', theme_color: '#6e141c',
    icons: [{ src: '/admin-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
  }, { headers: { 'content-type': 'application/manifest+json' } });
}
