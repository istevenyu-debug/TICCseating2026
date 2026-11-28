import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** 驗票管理「加入主畫面」：打開時直接回到這位負責人的管理頁（全螢幕、有圖示） */
export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const start = `/crew/m/${encodeURIComponent(params.token)}`;
  return NextResponse.json({
    name: 'TICC 驗票管理', short_name: '驗票管理', start_url: start, scope: start, display: 'standalone',
    background_color: '#f6f3ec', theme_color: '#1f2a44', lang: 'zh-TW',
    icons: [
      { src: '/crew-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/crew-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
}
