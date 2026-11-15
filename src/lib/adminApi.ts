import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { BookingError } from './booking';
import { SESSION_COOKIE, sessionUser } from './auth';

/** 後台 API 一律先確認登入 */
export async function requireAdmin(opts: { finance?: boolean } = {}) {
  const db = await getDb();
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) throw new BookingError('UNAUTHORIZED', '請先登入後台。');
  // 財務帳號只能用明確允許的 API（後台狀態、電子發票操作）
  if (user.role === 'finance' && !opts.finance) throw new BookingError('FORBIDDEN', '財務帳號只能處理電子發票');
  return { db, user };
}
