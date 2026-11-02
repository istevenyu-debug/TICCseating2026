/** 電子發票品名（純函式，前後端共用） */
/** 品名開頭：後台填整段（例「萬變中 喚醒不變的力量 入場券」）；只填舊預設「入場券」時，前面自動加活動名稱 */
export const invLabel = (evName: string, itemName: string) => (itemName.trim() === '入場券' || !itemName.trim() ? `${evName} 入場券` : itemName).trim();
/** 品名：開頭（方案名去括號＋套票）。例：尊榮席(1+2) → 「… 入場券（尊榮席套票）」；單張票種照原名 */
export function invItemName(label: string, kind: string, name: string) {
  const base = name.replace(/\s*[(（][^()（）]*[)）]\s*/g, '').trim() || name;
  return `${label}（${kind === 'combo' && !/套票$/.test(base) ? `${base}套票` : base}）`;
}

