import { z } from 'zod';

export const normalizePhone = (s: string) => s.replace(/[\s-]/g, '');

/** 持票人自動編號（例如功德組）：第 1 張為本名＋證末4碼01，之後為「姓名02」「證末4碼02」…依序 */
export function autoHolders(buyerName: string, idBase: string, count: number, start = 0) {
  // start：這位贊助者之前已劃的席數。分好幾次劃（例如尊榮席、金區各一次）時接著編號，名字不會重複
  const w = Math.max(2, String(count + start).length);
  const name = buyerName.trim();
  const base = idBase.trim().toUpperCase();
  return Array.from({ length: count }, (_, k) => {
    const i = k + start;
    const n = String(i + 1).padStart(w, '0');
    return { name: i === 0 ? name : `${name}${n}`, id4: base ? `${base}${n}` : '' };
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
    name: z.string().trim().min(1, '請填寫每個座位的出席貴賓姓名').max(40),
    id4: z.string().trim().toUpperCase().regex(/^([0-9A-Z]{4}(\d{2,3})?)?$/, '證號格式不正確').optional().default(''), // 不再要求身分證
  })).min(1),
  /** 持票人自動編號的購票方式：購票人身分證末 4 碼 */
  idBase: z.string().trim().toUpperCase().regex(/^([0-9A-Z]{4})?$/, '購票人身分證末 4 碼應為 4 個英數字').optional(),
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
});

export type SubmitInput = z.infer<typeof submitInput>;
