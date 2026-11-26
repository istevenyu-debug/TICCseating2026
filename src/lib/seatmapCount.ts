/**
 * 年代座位圖截圖 → 4F／5F 已售張數（在瀏覽器跑，不上傳原圖到伺服器計算）。
 * 圖的樣子（2026-11-26 使用者截圖）：每席一個小方格、格與格之間有白縫；
 * 綠色＝已售，其他有顏色的（藍、橘、黃…）＝可售底色，灰色＝包廂（不賣，不算）。
 * 做法：找出每個有顏色的方格 → 依高度分排 → 找「連續幾排加起來剛好 748 席、接著連續幾排剛好 686 席」
 * （總席數對得上才接受，對不上就不存，避免截圖切掉或縮放造成錯誤數字）。
 */
export type FloorCap = { key: string; total: number };
export type SeatmapResult =
  | { ok: true; floors: { key: string; total: number; sold: number }[]; cells: number; rows: number }
  | { ok: false; message: string; cells: number; rows: number };

function hsv(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

/** 有顏色的格子（不含白縫、灰色包廂、黑色文字） */
const colored = (s: number, v: number) => s >= 0.3 && v >= 0.25;
/** 依色相分類（同色才算同一格：不同顏色的格子緊貼時，邊緣的混色像素不會把兩格黏成一塊） */
const hueClass = (h: number) => (h >= 85 && h <= 165 ? 2 : h < 30 || h >= 330 ? 3 : h < 70 ? 4 : h < 85 ? 5 : h < 260 ? 7 : 8);

/** data：RGBA（canvas getImageData），w×h */
export function countSeatmap(data: Uint8ClampedArray | Uint8Array, w: number, h: number, caps: FloorCap[] = [{ key: '4F', total: 748 }, { key: '5F', total: 686 }]): SeatmapResult {
  const n = w * h;
  const kind = new Uint8Array(n); // 0 背景；2 綠（已售）；其他數字＝其他顏色
  for (let i = 0; i < n; i++) {
    const p = hsv(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    if (colored(p.s, p.v)) kind[i] = hueClass(p.h);
  }
  // 連通區塊（4 鄰），每塊＝一席
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const blobs: { area: number; green: number; cy: number; hgt: number; wid: number; y0: number }[] = [];
  for (let start = 0; start < n; start++) {
    if (!kind[start] || seen[start]) continue;
    let top = 0, area = 0, green = 0, sy = 0, y0 = h, y1 = 0, x0 = w, x1 = 0;
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const i = stack[--top];
      const y = (i / w) | 0, x = i - y * w;
      area++; sy += y; if (kind[i] === 2) green++;
      if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && kind[j] === kind[start] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
    }
    blobs.push({ area, green, cy: sy / area, hgt: y1 - y0 + 1, wid: x1 - x0 + 1, y0 });
  }
  if (blobs.length < 50) return { ok: false, message: '圖裡找不到座位格子，請上傳年代的座位圖截圖。', cells: blobs.length, rows: 0 };
  const areas = blobs.map((b) => b.area).sort((a, b) => a - b);
  const med = areas[areas.length >> 1];
  const single = blobs.filter((b) => b.area >= med * 0.45 && b.area <= med * 1.8); // 太小＝雜點或被切掉的格子
  const merged = blobs.filter((b) => b.area > med * 1.8);
  if (merged.length > single.length * 0.05) return { ok: false, message: '格子黏在一起，圖可能縮得太小。請用原尺寸截圖（不要縮小）。', cells: single.length, rows: 0 };
  const hs = single.map((b) => b.hgt).sort((a, b) => a - b);
  const cellH = hs[hs.length >> 1];
  const rowGap = Math.max(2, cellH * 0.5);
  // 格距（相鄰兩排中心的距離）：用來拆開黏在一起的格子（例如被選取的座位，縫也上了色）
  const ys = single.map((b) => b.cy).sort((a, b) => a - b);
  const steps: number[] = [];
  for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > rowGap) steps.push(ys[i] - ys[i - 1]);
  steps.sort((a, b) => a - b);
  const pitch = steps.length ? steps[steps.length >> 1] : cellH * 1.2;
  const cells: { cy: number; green: number; area: number }[] = single.map((b) => ({ cy: b.cy, green: b.green, area: b.area }));
  for (const b of merged) {
    const nx = Math.max(1, Math.round(b.wid / pitch)), ny = Math.max(1, Math.round(b.hgt / pitch));
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) cells.push({ cy: b.y0 + pitch * (r + 0.5), green: b.green, area: b.area });
  }
  // 分排
  cells.sort((a, b) => a.cy - b.cy);
  const rows: { total: number; sold: number }[] = [];
  let last = -1e9;
  for (const c of cells) {
    if (c.cy - last > rowGap) rows.push({ total: 0, sold: 0 });
    const r = rows[rows.length - 1];
    r.total++; if (c.green * 2 > c.area) r.sold++;
    last = c.cy;
  }
  // 找連續的排：第一層剛好 caps[0].total，緊接著第二層剛好 caps[1].total…
  for (let i = 0; i < rows.length; i++) {
    let at = i;
    const out: { key: string; total: number; sold: number }[] = [];
    for (const cap of caps) {
      let tot = 0, sold = 0, j = at;
      while (j < rows.length && tot < cap.total) { tot += rows[j].total; sold += rows[j].sold; j++; }
      if (tot !== cap.total) break;
      out.push({ key: cap.key, total: tot, sold });
      at = j;
    }
    if (out.length === caps.length) return { ok: true, floors: out, cells: cells.length, rows: rows.length };
  }
  return {
    ok: false, cells: cells.length, rows: rows.length,
    message: `座位數對不上（要 ${caps.map((c) => `${c.key} ${c.total}`).join('、')} 席；圖裡共找到 ${cells.length} 格、${rows.length} 排）。請確認 ${caps.map((c) => c.key).join('、')} 每一排都在截圖裡、沒有被切掉，也沒有縮小。`,
  };
}
