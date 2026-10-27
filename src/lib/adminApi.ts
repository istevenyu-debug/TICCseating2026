import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { BookingError } from './booking';
import { SESSION_COOKIE, sessionUser } from './auth';

/** 後台 API 一律先確認登入 */
export async function requireAdmin() {
  const db = await getDb();
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) throw new BookingError('UNAUTHORIZED', '請先登入後台。');
  return { db, user };
}
