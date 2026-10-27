/**
 * 大會堂第 1–12 排座位模板。
 * 依台北國際會議中心〈大會堂座位示意圖〉（修訂 109.11.13）建置。
 *
 * 座標系（x = 欄、y = 列）供座位圖繪製與相鄰判斷使用：
 *   x 1–7 左側區 | 8 排號 | 9–20 左區 | 21 走道 | 22–31 中區 | 32 走道 | 33–44 右區 | 45 排號 | 46–52 右側區
 *   y 1 = VIP 排，y = 排號 + 1
 *
 * 注意：側區每排座位數與輪椅席位置為示意圖判讀結果，上線前須與場館正式座位清冊核對。
 */

export type SeatType = 'normal' | 'vip' | 'wheelchair';

export interface SeatDef {
  id: string;
  section: 'WL' | 'L' | 'C' | 'R' | 'WR' | 'VL' | 'VC' | 'VR' | 'W';
  rowNo: number | null;
  seatNo: string;
  seatType: SeatType;
  x: number;
  y: number;
}

export const GRID = { cols: 52, rows: 13, rowLabelCols: [8, 45] } as const;

/** 側區（第 4–11 排）每排座位數 */
const WING_COUNT: Record<number, number> = { 4: 4, 5: 4, 6: 4, 7: 4, 8: 4, 9: 5, 10: 6, 11: 7 };
const CENTER = [9, 7, 5, 3, 1, 2, 4, 6, 8, 10];

/** 輪椅席：[座號, x, y] */
const WHEELCHAIR: [string, number, number][] = [
  ['H15', 13, 1], ['H16', 40, 1],
  ['H13', 6, 4], ['H11', 7, 4], ['H12', 46, 4], ['H14', 47, 4],
  ['H9', 3, 13], ['H7', 4, 13], ['H5', 5, 13], ['H3', 6, 13], ['H1', 7, 13],
  ['H2', 46, 13], ['H4', 47, 13], ['H6', 48, 13], ['H8', 49, 13], ['H10', 50, 13],
];

export function buildSeats(): SeatDef[] {
  const out: SeatDef[] = [];
  const n = (rowNo: number, seat: number, section: SeatDef['section'], x: number) =>
    out.push({ id: `${rowNo}-${seat}`, section, rowNo, seatNo: String(seat), seatType: 'normal', x, y: rowNo + 1 });

  for (let r = 1; r <= 12; r++) {
    for (let i = 0; i < 12; i++) n(r, 33 - 2 * i, 'L', 9 + i); // 左區 33→11
    CENTER.forEach((s, i) => n(r, s, 'C', 22 + i)); // 中區
    for (let i = 0; i < 12; i++) n(r, 12 + 2 * i, 'R', 33 + i); // 右區 12→34
    const k = WING_COUNT[r];
    if (k) {
      for (let j = 0; j < k; j++) n(r, 35 + 2 * j, 'WL', 7 - j); // 左側區：35 靠走道
      for (let j = 0; j < k; j++) n(r, 36 + 2 * j, 'WR', 46 + j); // 右側區：36 靠走道
    }
  }

  const v = (seat: number, section: SeatDef['section'], x: number) =>
    out.push({ id: `V-${seat}`, section, rowNo: 0, seatNo: String(seat), seatType: 'vip', x, y: 1 });
  [21, 19, 17, 15, 13, 11, 9].forEach((s, i) => v(s, 'VL', 14 + i));
  [7, 5, 3, 1, 2, 4, 6].forEach((s, i) => v(s, 'VC', 23 + i));
  [8, 10, 12, 14, 16, 18, 20].forEach((s, i) => v(s, 'VR', 33 + i));

  for (const [h, x, y] of WHEELCHAIR) {
    out.push({ id: `W-${h}`, section: 'W', rowNo: null, seatNo: h, seatType: 'wheelchair', x, y });
  }
  return out;
}

export function seatLabel(s: { rowNo: number | null; seatNo: string; seatType: string }): string {
  if (s.seatType === 'wheelchair') return `輪椅席 ${s.seatNo}`;
  if (s.rowNo === 0) return `VIP排 ${s.seatNo}號`;
  return `第${s.rowNo}排 ${s.seatNo}號`;
}

/** 預設票區：中區全部與左右區 1–6 排為 A，左右區 7–12 排為 B，側區為 C */
export function defaultZoneCode(s: SeatDef): string {
  if (s.seatType === 'wheelchair') return 'W';
  if (s.seatType === 'vip') return 'V';
  if (s.section === 'WL' || s.section === 'WR') return 'C';
  if (s.section === 'C') return 'A';
  return (s.rowNo ?? 0) <= 6 ? 'A' : 'B';
}
