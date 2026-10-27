import { z } from 'zod';

export const normalizePhone = (s: string) => s.replace(/[\s-]/g, '');

/** 持票人自動編號（例如功德組）：第 1 張為本名＋證末4碼01，之後為「姓名02」「證末4碼02」…依序 */
export function autoHolders(buyerName: string, idBase: string, count: number) {
  const w = Math.max(2, String(count).length);
  const name = buyerName.trim();
  const base = idBase.trim().toUpperCase();
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(w, '0');
    return { name: i === 0 ? name : `${name}${n}`, id4: `${base}${n}` };
  });
}

/** 手機即時檢查：回傳錯誤說明，正確時回傳 null（空白也回傳 null，由必填檢查處理） */
export function phoneProblem(s: string): string | null {
  const raw = s.trim();
  if (!raw) return null;
  if (/[^\d\s-]/.test(raw)) return '手機只能填數字（可含 - 或空格）';
  const d = raw.replace(/\D/g, '');
  if (!d.startsWith('09')) return '手機應為 09 開頭';
  if (d.length > 10) return `手機應為 10 碼，目前是 ${d.length} 碼，多了 ${d.length - 10} 碼`;
  if (d.length < 10) return `手機應為 10 碼，目前是 ${d.length} 碼`;
  return null;
}

export const holdInput = z.object({
  seatIds: z.array(z.string().min(1).max(16)).min(1).max(200),
  comboId: z.number().int().positive(),
});

export const submitInput = z.object({
  orderId: z.number().int().positive(),
  buyer: z.object({
    name: z.string().trim().min(1, '請填寫購票人姓名').max(40),
    phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機應為 09 開頭的 10 位數字，例如 0912-345-678')),
    email: z.string().trim().email('Email 格式不正確').max(120),
  }),
  holders: z.array(z.object({
    seatId: z.string().min(1),
    name: z.string().trim().min(1, '請填寫每張票的持票人姓名').max(40),
    id4: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4}(\d{2,3})?$/, '身分證末 4 碼應為 4 個英數字'),
  })).min(1),
  /** 持票人自動編號的購票方式：購票人身分證末 4 碼 */
  idBase: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4}$/, '購票人身分證末 4 碼應為 4 個英數字').optional(),
  transfer: z.object({
    last5: z.string().trim().regex(/^\d{5}$/, '匯款帳號末 5 碼應為 5 位數字'),
    amount: z.number().int().nonnegative('匯款金額不正確'),
    time: z.string().trim().min(1, '請填寫匯款時間').max(40),
  }),
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
});

export type SubmitInput = z.infer<typeof submitInput>;
