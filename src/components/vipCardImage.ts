'use client';

/**
 * 把 VIP 票卡畫成一張 PNG（桌機「複製圖片」貼到電腦版 LINE、「下載圖片」用）。
 * 跟畫面上的票卡同樣內容：VIP 貴賓席、座位、姓名職稱、單位、QR、序號、活動名稱、日期地點。
 */
export type CardImg = { seat: string; name: string; org: string; serial: string; value: string; eventName: string; showAt: string };

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Heiti TC", sans-serif';
const GOLD = '#8a6a2a';

function fitText(ctx: CanvasRenderingContext2D, text: string, size: number, weight: number, max: number) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (ctx.measureText(text).width > max && s > 14);
}

export async function cardBlob(c: CardImg): Promise<Blob> {
  const QR = (await import('qrcode')).default;
  const W = 680, H = 1040, R = 36;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // 底與金框
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(0, 0, W, H, R); ctx.fill();
  ctx.lineWidth = 10; ctx.strokeStyle = GOLD;
  ctx.beginPath(); ctx.roundRect(5, 5, W - 10, H - 10, R - 4); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // 「VIP 貴賓席」膠囊
  ctx.fillStyle = GOLD;
  ctx.beginPath(); ctx.roundRect(W / 2 - 120, 44, 240, 56, 28); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `700 30px ${FONT}`; ctx.fillText('VIP 貴賓席', W / 2, 73);
  // 座位、姓名、單位
  ctx.fillStyle = '#1f2a44';
  fitText(ctx, c.seat, 64, 800, W - 80); ctx.fillText(c.seat, W / 2, 160);
  fitText(ctx, c.name, 46, 700, W - 80); ctx.fillText(c.name, W / 2, 234);
  if (c.org) { ctx.fillStyle = '#6b7488'; fitText(ctx, c.org, 30, 400, W - 80); ctx.fillText(c.org, W / 2, 284); }
  // QR
  const qr = document.createElement('canvas');
  await QR.toCanvas(qr, c.value, { margin: 1, width: 440 });
  ctx.drawImage(qr, (W - 440) / 2, 316, 440, 440);
  ctx.fillStyle = '#6b7488'; ctx.font = `400 24px ui-monospace, Menlo, Consolas, monospace`; ctx.fillText(`序號 ${c.serial}`, W / 2, 784);
  // 虛線與活動資訊
  ctx.strokeStyle = '#c9b27a'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(60, 820); ctx.lineTo(W - 60, 820); ctx.stroke(); ctx.setLineDash([]);
  const when = new Date(c.showAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  ctx.fillStyle = '#1f2a44'; fitText(ctx, c.eventName, 28, 700, W - 80); ctx.fillText(c.eventName, W / 2, 862);
  ctx.font = `400 26px ${FONT}`; ctx.fillText(`${when}・台北國際會議中心 大會堂`, W / 2, 908);
  ctx.fillStyle = '#6b7488'; ctx.font = `400 22px ${FONT}`; ctx.fillText('入場出示此 QR・每個 QR 限用一次', W / 2, 952);
  return new Promise((ok, bad) => cv.toBlob((b) => (b ? ok(b) : bad(new Error('圖片產生失敗'))), 'image/png'));
}

/** 複製圖片到剪貼簿（貼到電腦版 LINE：Ctrl+V） */
export async function copyCard(c: CardImg) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('這個瀏覽器不支援複製圖片，請改用「下載圖片」');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(c) })]);
}

/** 下載圖片 */
export async function downloadCard(c: CardImg) {
  const b = await cardBlob(c);
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  // 檔名用英數（部分瀏覽器遇到中文檔名會變成 download）：VIP_座位數字_序號.png，例 VIP_23_T1-00003-01.png
  a.download = `VIP_${c.seat.replace(/\D+/g, '-').replace(/^-|-$/g, '')}_${c.serial}.png`;
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30_000);
}
