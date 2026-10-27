import { z } from 'zod';

export const normalizePhone = (s: string) => s.replace(/[\s-]/g, '');

export const holdInput = z.object({
  seatIds: z.array(z.string().min(1).max(16)).min(1).max(20),
  comboCode: z.string().min(1).max(32),
});

export const submitInput = z.object({
  orderId: z.number().int().positive(),
  buyer: z.object({
    name: z.string().trim().min(1, '請填寫購票人姓名').max(40),
    phone: z.string().transform(normalizePhone).pipe(z.string().regex(/^09\d{8}$/, '手機格式應為 09xxxxxxxx')),
    email: z.string().trim().email('Email 格式不正確').max(120),
  }),
  holders: z.array(z.object({
    seatId: z.string().min(1),
    name: z.string().trim().min(1, '請填寫每張票的持票人姓名').max(40),
    id4: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4}$/, '身分證末 4 碼應為 4 個英數字'),
  })).min(1),
  transfer: z.object({
    last5: z.string().trim().regex(/^\d{5}$/, '匯款帳號末 5 碼應為 5 位數字'),
    amount: z.number().int().nonnegative('匯款金額不正確'),
    time: z.string().trim().min(1, '請填寫匯款時間').max(40),
  }),
  agree: z.literal(true, { errorMap: () => ({ message: '請勾選同意個資蒐集' }) }),
});

export type SubmitInput = z.infer<typeof submitInput>;
