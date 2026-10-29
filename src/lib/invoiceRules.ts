/** 電子發票開立方式與格式檢查（純函式，前後端共用） */

export type InvType = 'member' | 'mobile' | 'cert' | 'donate' | 'company';

export const INV_TYPES: { id: InvType; name: string; hint: string }[] = [
  { id: 'member', name: '存入綠界會員載具（寄到 Email）', hint: '最簡單：發票通知寄到您的 Email，中獎會通知您' },
  { id: 'mobile', name: '手機條碼載具', hint: '例：/ABC1234（斜線加 7 碼）' },
  { id: 'cert', name: '自然人憑證載具', hint: '2 個大寫英文字母＋14 位數字' },
  { id: 'donate', name: '捐贈發票', hint: '填受贈單位的愛心碼（3–7 位數字）' },
  { id: 'company', name: '公司報帳（打統一編號）', hint: '填 8 位數統一編號與公司抬頭' },
];

/** 統一編號檢查碼（財政部 2023 起：加權和可被 5 整除；第 7 碼為 7 時有兩種算法） */
export function ubnValid(ubn: string): boolean {
  if (!/^\d{8}$/.test(ubn)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  const d = ubn.split('').map(Number);
  const digitSum = (n: number) => Math.floor(n / 10) + (n % 10);
  const sum = d.reduce((a, x, i) => a + digitSum(x * w[i]), 0);
  return sum % 5 === 0 || (d[6] === 7 && (sum + 1) % 5 === 0);
}

/** 回傳錯誤訊息；正確回傳 null */
export function invProblem(type: string, code: string, title: string): string | null {
  const c = code.trim();
  switch (type) {
    case 'member': return null;
    case 'mobile': return /^\/[0-9A-Z.+-]{7}$/.test(c) ? null : '手機條碼格式不正確：斜線開頭，共 8 碼（例：/ABC1234，英文要大寫）';
    case 'cert': return /^[A-Z]{2}\d{14}$/.test(c) ? null : '自然人憑證號碼應為 2 個大寫英文字母＋14 位數字';
    case 'donate': return /^\d{3,7}$/.test(c) ? null : '愛心碼應為 3–7 位數字';
    case 'company':
      if (!ubnValid(c)) return '統一編號不正確，請確認 8 位數字';
      return title.trim() ? null : '請填寫公司抬頭';
    default: return '請選擇發票開立方式';
  }
}

/** 顯示用：「手機條碼 /ABC1234」「公司 12345675 某某股份有限公司」 */
export function invDesc(type: string, code: string, title: string, email = ''): string {
  switch (type) {
    case 'mobile': return `手機條碼 ${code}`;
    case 'cert': return `自然人憑證 ${code}`;
    case 'donate': return `捐贈（愛心碼 ${code}）`;
    case 'company': return `公司 ${code} ${title}`;
    default: return `綠界會員載具${email ? `（${email}）` : ''}`;
  }
}
