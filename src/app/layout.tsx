import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '大會堂劃位',
  description: '台北國際會議中心大會堂第 1–12 排線上劃位',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&family=IBM+Plex+Mono:wght@500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
