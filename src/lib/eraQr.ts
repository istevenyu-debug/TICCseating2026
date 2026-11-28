/**
 * 年代電子票 QR（年代售票 App「電子票券」）。
 * 實測（2026-11-23，7 張票）：內容是「票 ID（14 碼英數）-日時分秒（8 碼）＋2 碼＋1 個檢查字元」，例：
 *   C136DSP1IGZL8E-23033250027
 * 橫線前的 ID 每張票固定（隔幾分鐘、轉贈接收後都一樣），橫線後隨時間變（動態 QR）。
 * 轉贈尚未接收時，QR 內容是文字「轉贈待接收」。
 * 我們驗不了真假（不知道年代的檢查算法），只用 ID 計數：同一張票只算一次。
 */
export type EraQr = { kind: 'era'; id: string; paper?: true } | { kind: 'pending' } | null;

const RE = /^([A-Z0-9]{10,20})-(\d{8}[0-9A-Z]{2,4})$/;
/**
 * 年代紙本票（11/24 樣本「貴賓券」3樓-15排-36號）：QR 是一串固定英數，例 D136DSP1IL8XQYN（15 碼，沒有橫線）。
 * 只有一張樣本：放寬成 12–20 碼、同時有英文和數字；練習時會記下原文，再依實際樣本調整。
 */
const PAPER_RE = /^(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{12,20}$/;

export function parseEraQr(text: string): EraQr {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (s.includes('轉贈')) return { kind: 'pending' };
  const u = s.toUpperCase();
  const m = u.match(RE);
  if (m) return { kind: 'era', id: m[1] };
  return PAPER_RE.test(s) ? { kind: 'era', id: s, paper: true } : null;
}

export const ERA_FLOORS = ['3F', '4F', '5F'] as const;
export type EraFloor = (typeof ERA_FLOORS)[number];
export const isEraFloor = (f: unknown): f is EraFloor => ERA_FLOORS.includes(f as EraFloor);

/** 入場紀錄：序號 ERA:<ID>、座位欄 ERA（11-25 起不分樓層；11-23 版留下的 ERA-3F 仍看得懂） */
export const eraSerial = (id: string) => `ERA:${id}`;
export const ERA_SEAT = 'ERA';
export const eraSeat = (f: EraFloor) => `ERA-${f}`;
export const eraFloorOfSeat = (seatId: string) => (seatId.startsWith('ERA-') ? seatId.slice(4) : '');
export const isEraSerial = (s: string) => s.startsWith('ERA:');

/** 年代名單的「區樓」→ 3F／4F／5F；看不懂回傳空字串 */
export function eraFloorOf(floor: string): string {
  const s = String(floor ?? '').trim();
  const m = s.match(/(\d)\s*(樓|F|f)/) ?? s.match(/^(\d)$/);
  if (m) return `${m[1]}F`;
  const zh: Record<string, string> = { 三: '3F', 四: '4F', 五: '5F' };
  const z = s.match(/([三四五])樓/);
  return z ? zh[z[1]] : '';
}
