/**
 * 後台登入：帳號密碼（scrypt 雜湊）＋簽章 cookie。
 * - SESSION_SECRET：簽章用金鑰，正式環境必填（至少 32 字元）。
 * - ADMIN_USERNAME / ADMIN_PASSWORD：資料庫還沒有任何後台帳號時，用來建立第一個管理員。
 *   本機開發未設定時，自動建立 admin / ticc-dev-2026。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';

export const SESSION_COOKIE = 'ticc_admin';
const SESSION_HOURS = 12;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('正式環境必須設定 SESSION_SECRET（至少 32 字元）');
  return 'dev-only-secret-do-not-use-in-production-0000';
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), want.length);
  return timingSafeEqual(want, got);
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function makeSession(userId: number, now = Date.now()): { value: string; maxAge: number } {
  const exp = Math.floor(now / 1000) + SESSION_HOURS * 3600;
  const payload = `${userId}.${exp}`;
  return { value: `${payload}.${sign(payload)}`, maxAge: SESSION_HOURS * 3600 };
}

export function readSession(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const [uid, exp, sig] = value.split('.');
  if (!uid || !exp || !sig) return null;
  const expect = sign(`${uid}.${exp}`);
  if (expect.length !== sig.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  if (Number(exp) * 1000 < now) return null;
  return Number(uid);
}

export async function sessionUser(db: Db, value: string | undefined) {
  const id = readSession(value);
  if (!id) return null;
  const [u] = await db.select().from(t.adminUser).where(eq(t.adminUser.id, id));
  return u && u.active ? { id: u.id, username: u.username, displayName: u.displayName || u.username, role: u.role } : null;
}

/** 資料庫沒有任何後台帳號時，建立第一個管理員 */
export async function ensureBootstrapAdmin(db: Db) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.adminUser);
  if (n > 0) return;
  let username = process.env.ADMIN_USERNAME;
  let password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    if (process.env.NODE_ENV === 'production') return; // 正式環境不自動建立預設帳號
    username = 'admin';
    password = 'ticc-dev-2026';
  }
  await db.insert(t.adminUser).values({ username, passwordHash: hashPassword(password), displayName: '管理員', role: 'admin' }).onConflictDoNothing();
}

/* 登入失敗次數限制：同一來源 10 分鐘內最多 5 次 */
const fails = new Map<string, { n: number; until: number }>();
export function loginBlocked(key: string, now = Date.now()): boolean {
  const f = fails.get(key);
  return !!f && f.n >= 5 && f.until > now;
}
export function loginFailed(key: string, now = Date.now()) {
  const f = fails.get(key);
  if (!f || f.until < now) fails.set(key, { n: 1, until: now + 10 * 60_000 });
  else f.n += 1;
}
export function loginOk(key: string) { fails.delete(key); }

export async function login(db: Db, username: string, password: string) {
  await ensureBootstrapAdmin(db);
  const [u] = await db.select().from(t.adminUser).where(eq(t.adminUser.username, username));
  if (!u || !u.active || !verifyPassword(password, u.passwordHash)) return null;
  await db.insert(t.auditLog).values({ actor: u.username, action: 'login', target: `admin:${u.id}` });
  return u;
}
