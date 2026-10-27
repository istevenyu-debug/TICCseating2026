'use client';

import { useEffect, useState } from 'react';

/** 入場憑證 QR code（內容與紙本入場券相同：TICC|序號） */
export default function TicketQR({ serial, size = 120 }: { serial: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    import('qrcode').then((Q) => Q.toString(`TICC|${serial}`, { type: 'svg', margin: 1, width: size }))
      .then((s) => { if (alive) setSvg(s); }).catch(() => setSvg(''));
    return () => { alive = false; };
  }, [serial, size]);
  return <div className="qrbox" style={{ width: size, height: size }} aria-label={`入場 QR code ${serial}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
