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
  block: Block;
  code: string;
}

/** 區塊代碼：L2 左側區、L1 左區、C0 中區、R1 右區、R2 右側區 */
export type Block = 'L2' | 'L1' | 'C0' | 'R1' | 'R2';
export const BLOCKS: Block[] = ['L2', 'L1', 'C0', 'R1', 'R2'];
export const BLOCK_NAME: Record<Block, string> = { L2: '左側區', L1: '左區', C0: '中區', R1: '右區', R2: '右側區' };
const SECTION_BLOCK: Record<string, Block> = { WL: 'L2', L: 'L1', C: 'C0', R: 'R1', WR: 'R2', VL: 'L1', VC: 'C0', VR: 'R1' };

function withCode(s: Omit<SeatDef, 'block' | 'code'>): SeatDef {
  const block: Block = s.seatType === 'wheelchair'
    ? (s.x <= 7 ? 'L2' : s.x <= 20 ? 'L1' : s.x <= 44 ? 'R1' : 'R2')
    : SECTION_BLOCK[s.section];
  const rowPart = s.seatType === 'wheelchair' ? 'WC' : s.rowNo === 0 ? 'V' : String(s.rowNo).padStart(2, '0');
  const seatPart = s.seatType === 'wheelchair' ? s.seatNo : s.seatNo.padStart(2, '0');
  return { ...s, block, code: `${rowPart}-${seatPart}-${block}` };
}

/** 排數代號：1–27 為一般排（13 以後是三樓），0 為 VIP 排，-1 為輪椅席 */
export function rowKey(s: { rowNo: number | null; seatType: string }): number {
  return s.seatType === 'wheelchair' ? -1 : (s.rowNo ?? 0);
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
  const out: Omit<SeatDef, 'block' | 'code'>[] = [];
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
  return out.map(withCode);
}

/* ---------- 三樓（3F 入口）第 13–27 排 ---------- */

/**
 * 依〈大會堂座位示意圖〉（修訂 109.11.13）逐排數過：中間三區每排 12＋10＋12 席（共 510 席），
 * 左右斜區第 14–27 排各 107 席，合計 724 席，與圖上「第 13 至 27 排 724」相符。
 * 三樓自成一張圖（連結綁樓層，兩層不會同時出現），座標另算，第 1–12 排的資料完全不動：
 *   x 1–11 左斜區 | 12 排號 | 13–24 左區 | 25 走道 | 26–35 中區 | 36 走道 | 37–48 右區 | 49 排號 | 50–61 右斜區
 *   y = 排號 − 12（第 13 排 = 1）
 * 輪椅席 H1–H10 在第 11、14 排之間，已包含在 2M 的 16 席輪椅席裡，保留不開放，這裡不另建。
 */
export type Floor = '2M' | '3F';
export const FLOOR_NAME: Record<Floor, string> = { '2M': '2M（第 1–12 排）', '3F': '三樓（第 13–27 排）' };
export const FLOOR3_FIRST_ROW = 13;
export const FLOOR3_LAST_ROW = 27;
export const floorOfRow = (rowNo: number | null): Floor => ((rowNo ?? 0) >= FLOOR3_FIRST_ROW ? '3F' : '2M');
export const GRID3 = { cols: 61, rows: 15, rowLabelCols: [12, 49] } as const;

/** 斜區（第 14–27 排）每排座位數：左右相同 */
const WING3_COUNT: Record<number, number> = { 14: 2, 15: 3, 16: 5, 17: 6, 18: 6, 19: 7, 20: 7, 21: 8, 22: 10, 23: 11, 24: 10, 25: 11, 26: 10, 27: 11 };
/** 右斜區第 22–25 排：這個座號之後和主體隔一格（圖上是分開的，不算相連） */
const WING3_R_GAP: Record<number, number> = { 22: 50, 23: 52, 24: 52, 25: 54 };

export function buildSeats3F(): SeatDef[] {
  const out: Omit<SeatDef, 'block' | 'code'>[] = [];
  const n = (rowNo: number, seat: number, section: SeatDef['section'], x: number) =>
    out.push({ id: `${rowNo}-${seat}`, section, rowNo, seatNo: String(seat), seatType: 'normal', x, y: rowNo - 12 });
  for (let r = FLOOR3_FIRST_ROW; r <= FLOOR3_LAST_ROW; r++) {
    for (let i = 0; i < 12; i++) n(r, 33 - 2 * i, 'L', 13 + i); // 左區 33→11
    CENTER.forEach((s, i) => n(r, s, 'C', 26 + i)); // 中區
    for (let i = 0; i < 12; i++) n(r, 12 + 2 * i, 'R', 37 + i); // 右區 12→34
    const k = WING3_COUNT[r] ?? 0;
    for (let j = 0; j < k; j++) {
      n(r, 35 + 2 * j, 'WL', 11 - j); // 左斜區：35 靠走道
      const seat = 36 + 2 * j;
      n(r, seat, 'WR', 50 + j + (WING3_R_GAP[r] !== undefined && seat > WING3_R_GAP[r] ? 1 : 0)); // 右斜區：36 靠走道
    }
  }
  return out.map(withCode);
}

/** 座位圖左右的排號 */
export function rowLabels(floor: Floor, vipInstalled: boolean) {
  const rows: { y: number; label: string }[] = [];
  if (floor === '3F') {
    for (let r = FLOOR3_FIRST_ROW; r <= FLOOR3_LAST_ROW; r++) rows.push({ y: r - 12, label: String(r) });
    return rows;
  }
  if (vipInstalled) rows.push({ y: 1, label: 'VIP' });
  for (let r = 1; r <= 12; r++) rows.push({ y: r + 1, label: String(r) });
  return rows;
}
export const rowLabelCols = (floor: Floor): readonly number[] => (floor === '3F' ? GRID3.rowLabelCols : GRID.rowLabelCols);

export function seatLabel(s: { rowNo: number | null; seatNo: string; seatType: string }): string {
  if (s.seatType === 'wheelchair') return `輪椅席 ${s.seatNo}`;
  if (s.rowNo === 0) return `VIP排 ${s.seatNo}號`;
  return `第${s.rowNo}排 ${s.seatNo}號`;
}

/** 預設票種：中區全部與左右區 1–6 排為 A，左右區 7–12 排為 B，側區為 C */
export function defaultZoneCode(s: SeatDef): 'A' | 'B' | 'C' | 'V' | 'W' {
  if (s.seatType === 'wheelchair') return 'W';
  if (s.seatType === 'vip') return 'V';
  if (s.section === 'WL' || s.section === 'WR') return 'C';
  if (s.section === 'C') return 'A';
  return (s.rowNo ?? 0) <= 6 ? 'A' : 'B';
}
