/** 連座（例：贈票區左右兩位一組）的畫面用工具 */
export interface BundleSeat { id: string; x: number; y: number; bundle?: string | null }

/** 每個連座的成員（依左到右）與每個座位所屬的組 */
export function bundleIndex<T extends BundleSeat>(seats: T[]) {
  const groups = new Map<string, T[]>();
  for (const s of seats) if (s.bundle) (groups.get(s.bundle) ?? groups.set(s.bundle, []).get(s.bundle)!).push(s);
  groups.forEach((g) => g.sort((a, b) => a.x - b.x));
  /** 右邊還接著同組座位的（畫連接線） */
  const linkRight = new Set<string>();
  groups.forEach((g) => g.slice(0, -1).forEach((s) => linkRight.add(s.id)));
  const membersOf = (id: string, bundle?: string | null) => (bundle ? (groups.get(bundle) ?? []).map((s) => s.id) : [id]);
  return { groups, linkRight, membersOf };
}

/** 座位按鈕的連座樣式 */
export const bundleClass = (s: BundleSeat, linkRight: Set<string>) => (s.bundle ? ` bm${linkRight.has(s.id) ? ' bl' : ''}` : '');
