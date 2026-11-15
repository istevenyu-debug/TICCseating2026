/**
 * 後台帳號管理（只有 admin 能用）。角色：admin 主管／網管、staff 工作人員、finance 財務（只能開發票）。
 * 防呆：不能停用或降級自己；至少要留一個啟用中的 admin。
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { hashPassword } from './auth';

export const ROLES = ['admin', 'staff', 'finance'] as const;
export type Role = (typeof ROLES)[number];

export async function listUsers(db: Db) {
  const rows = await db.select().from(t.adminUser).orderBy(asc(t.adminUser.id));
  return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() }));
}

const pwOk = (pw: string) => { if (pw.length < 10) throw new BookingError('INVALID', '密碼至少 10 個字元'); };

export async function createUser(db: Db, actor: string, v: { username: string; displayName: string; password: string; role: Role }) {
  const username = v.username.trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new BookingError('INVALID', '帳號只能用英文、數字、. _ -，3–30 字');
  pwOk(v.password);
  const [dup] = await db.select({ id: t.adminUser.id }).from(t.adminUser).where(eq(t.adminUser.username, username));
  if (dup) throw new BookingError('INVALID', `帳號 ${username} 已經有人用了`);
  const [u] = await db.insert(t.adminUser).values({ username, displayName: v.displayName.trim(), passwordHash: hashPassword(v.password), role: v.role }).returning({ id: t.adminUser.id });
  await db.insert(t.auditLog).values({ actor, action: 'user_create', target: `admin_user:${u.id}`, detail: `${username}（${v.role}）` });
  return { id: u.id };
}

export async function updateUser(db: Db, actor: { id: number; username: string }, id: number, v: { displayName?: string; role?: Role; active?: boolean; password?: string }) {
  const [u] = await db.select().from(t.adminUser).where(eq(t.adminUser.id, id));
  if (!u) throw new BookingError('NOT_FOUND', '找不到這個帳號');
  if (id === actor.id && ((v.role && v.role !== 'admin') || v.active === false)) throw new BookingError('INVALID', '不能停用或降級自己的帳號');
  const losesAdmin = u.role === 'admin' && u.active && ((v.role && v.role !== 'admin') || v.active === false);
  if (losesAdmin) {
    const others = await db.select({ id: t.adminUser.id }).from(t.adminUser).where(and(eq(t.adminUser.role, 'admin'), eq(t.adminUser.active, true), ne(t.adminUser.id, id)));
    if (!others.length) throw new BookingError('INVALID', '至少要留一個啟用中的主管（admin）帳號');
  }
  const set: Partial<typeof t.adminUser.$inferInsert> = {};
  const what: string[] = [];
  if (v.displayName !== undefined && v.displayName.trim() !== u.displayName) { set.displayName = v.displayName.trim(); what.push(`名稱→${set.displayName}`); }
  if (v.role && v.role !== u.role) { set.role = v.role; what.push(`角色 ${u.role}→${v.role}`); }
  if (v.active !== undefined && v.active !== u.active) { set.active = v.active; what.push(v.active ? '啟用' : '停用'); }
  if (v.password) { pwOk(v.password); set.passwordHash = hashPassword(v.password); what.push('重設密碼'); }
  if (!what.length) return { changed: false };
  await db.update(t.adminUser).set(set).where(eq(t.adminUser.id, id));
  await db.insert(t.auditLog).values({ actor: actor.username, action: 'user_update', target: `admin_user:${id}`, detail: `${u.username}：${what.join('、')}` });
  return { changed: true };
}
