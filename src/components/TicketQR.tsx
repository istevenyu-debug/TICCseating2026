'use client';

import { useEffect, useState } from 'react';

/** 入場憑證 QR code（內容由伺服器產生：TICC|序號|簽章，與紙本入場券、Email 相同） */
export default function TicketQR({ serial, value, size = 120 }: { serial: string; value: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    import('qrcode').then((Q) => Q.toString(value, { type: 'svg', margin: 1, width: size }))
      .then((s) => { if (alive) setSvg(s); }).catch(() => setSvg(''));
    return () => { alive = false; };
  }, [value, size]);
  return <div className="qrbox" style={{ width: size, height: size }} aria-label={`入場 QR code ${serial}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
