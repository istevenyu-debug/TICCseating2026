import { ImageResponse } from 'next/og';

/** App 圖示：三排座位 */
export function GET() {
  const seat = (on: boolean) => <div style={{ width: 70, height: 70, borderRadius: 14, background: on ? '#ffffff' : 'rgba(255,255,255,.45)' }} />;
  const row = (on: number) => <div style={{ display: 'flex', gap: 22 }}>{[0, 1, 2, 3].map((i) => seat(i === on))}</div>;
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, background: '#1d3f8f' }}>
      <div style={{ width: 300, height: 26, borderRadius: 13, background: '#f0c35a', marginBottom: 26 }} />
      {row(-1)}{row(1)}{row(-1)}
    </div>,
    { width: 512, height: 512 },
  );
}
