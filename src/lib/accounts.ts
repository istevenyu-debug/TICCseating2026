/**
 * 後台帳號管理（只有 admin 能用）。角色：admin 主管／網管、staff 工作人員、finance 財務（只能開發票）。
 * 防呆：不能停用或降級自己；至少要留一個啟用中的 admin。
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, like, ne } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { hashPassword, verifyPassword } from './auth';

export const ROLES = ['admin', 'staff', 'finance'] as const;
export type Role = (typeof ROLES)[number];

export async function listUsers(db: Db) {
  const rows = await db.select().from(t.adminUser).orderBy(asc(t.adminUser.id));
  return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() }));
}

const pwOk = (pw: string) => { if (pw.length < 10) throw new BookingError('INVALID', '密碼至少 10 個字元'); };

/** 新增帳號。password 空白＝由本人用設定連結自己設（回傳 setup 代碼） */
export async function createUser(db: Db, actor: string, v: { username: string; displayName: string; password?: string; role: Role }, now = new Date()) {
  const username = v.username.trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new BookingError('INVALID', '帳號只能用英文、數字、. _ -，3–30 字');
  if (v.password) pwOk(v.password);
  const [dup] = await db.select({ id: t.adminUser.id }).from(t.adminUser).where(eq(t.adminUser.username, username));
  if (dup) throw new BookingError('INVALID', `帳號 ${username} 已經有人用了`);
  // 沒給密碼：放一組沒人知道的隨機密碼，等本人用設定連結設定
  const [u] = await db.insert(t.adminUser).values({ username, displayName: v.displayName.trim(), passwordHash: hashPassword(v.password || randomBytes(24).toString('base64')), role: v.role }).returning({ id: t.adminUser.id });
  await db.insert(t.auditLog).values({ actor, action: 'user_create', target: `admin_user:${u.id}`, detail: `${username}（${v.role}）` });
  return { id: u.id, setup: v.password ? null : await newSetupToken(db, actor, u.id, now) };
}

/* ---------- 設定密碼連結：一次性、1 小時有效；只存雜湊 ---------- */
export const SETUP_MINUTES = 60;
const SETUP_KEY = (id: number) => `user.setup.${id}`;
const sha = (x: string) => createHash('sha256').update(x).digest('hex');

export async function newSetupToken(db: Db, actor: string, id: number, now = new Date()) {
  const [u] = await db.select({ id: t.adminUser.id, username: t.adminUser.username }).from(t.adminUser).where(eq(t.adminUser.id, id));
  if (!u) throw new BookingError('NOT_FOUND', '找不到這個帳號');
  const token = `${id}.${randomBytes(24).toString('base64url')}`;
  const v = JSON.stringify({ h: sha(token), exp: now.getTime() + SETUP_MINUTES * 60_000 });
  await db.insert(t.appSetting).values({ key: SETUP_KEY(id), value: v }).onConflictDoUpdate({ target: t.appSetting.key, set: { value: v } });
  await db.insert(t.auditLog).values({ actor, action: 'user_setup_link', target: `admin_user:${id}`, detail: u.username });
  return { token, expiresAt: new Date(now.getTime() + SETUP_MINUTES * 60_000).toISOString() };
}

async function findSetup(db: Db, token: string, now: Date) {
  const id = Number(token.split('.')[0]);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [s] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, SETUP_KEY(id)));
  if (!s) return null;
  try {
    const v = JSON.parse(s.value) as { h: string; exp: number };
    if (v.h !== sha(token) || v.exp < now.getTime()) return null;
  } catch { return null; }
  const [u] = await db.select().from(t.adminUser).where(eq(t.adminUser.id, id));
  return u && u.active ? u : null;
}

/** 設定頁顯示用：連結有效就回傳帳號名稱 */
export async function setupInfo(db: Db, token: string, now = new Date()) {
  const u = await findSetup(db, token, now);
  return u ? { username: u.username, displayName: u.displayName } : null;
}

/** 本人用設定連結設密碼：成功後連結立刻失效，回傳帳號 id（呼叫端幫他登入） */
export async function redeemSetup(db: Db, token: string, password: string, now = new Date()) {
  const u = await findSetup(db, token, now);
  if (!u) throw new BookingError('INVALID', '這個連結已失效（超過 1 小時或已用過），請找主管重寄設定連結。');
  pwOk(password);
  await db.update(t.adminUser).set({ passwordHash: hashPassword(password) }).where(eq(t.adminUser.id, u.id));
  await db.delete(t.appSetting).where(eq(t.appSetting.key, SETUP_KEY(u.id)));
  await db.insert(t.auditLog).values({ actor: u.username, action: 'user_setup_done', target: `admin_user:${u.id}`, detail: '用設定連結設定密碼' });
  return { id: u.id };
}

/** 本人修改密碼（要先輸入目前的密碼） */
export async function changeOwnPassword(db: Db, userId: number, oldPw: string, newPw: string) {
  const [u] = await db.select().from(t.adminUser).where(eq(t.adminUser.id, userId));
  if (!u || !verifyPassword(oldPw, u.passwordHash)) throw new BookingError('INVALID', '目前的密碼不正確');
  pwOk(newPw);
  if (oldPw === newPw) throw new BookingError('INVALID', '新密碼和目前的一樣');
  await db.update(t.adminUser).set({ passwordHash: hashPassword(newPw) }).where(eq(t.adminUser.id, userId));
  await db.insert(t.auditLog).values({ actor: u.username, action: 'user_password', target: `admin_user:${userId}`, detail: '本人修改密碼' });
  return true;
}

/** 列出還有效的設定連結（後台顯示「連結有效到幾點」） */
export async function pendingSetups(db: Db, now = new Date()) {
  const rows = await db.select().from(t.appSetting).where(like(t.appSetting.key, 'user.setup.%'));
  const out: Record<number, string> = {};
  for (const r of rows) { try { const v = JSON.parse(r.value) as { exp: number }; if (v.exp > now.getTime()) out[Number(r.key.split('.')[2])] = new Date(v.exp).toISOString(); } catch { /* 略過 */ } }
  return out;
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
