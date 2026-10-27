/**
 * 新增一個後台帳號（例如讓同事用不同帳號登入）。
 * 用法：npm run admin:add
 */
import { createInterface } from 'node:readline/promises';
import { getDb } from '../src/db/client';
import { hashPassword } from '../src/lib/auth';
import * as t from '../src/db/schema';

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const username = (await rl.question('新帳號：')).trim();
  const displayName = (await rl.question('顯示名稱（例：王小明）：')).trim();
  const password = (await rl.question('密碼（至少 10 個字元）：')).trim();
  rl.close();
  if (!username || password.length < 10) { console.error('帳號不可空白，密碼至少 10 個字元。'); process.exit(1); }
  const db = await getDb();
  const r = await db.insert(t.adminUser).values({ username, displayName, passwordHash: hashPassword(password), role: 'admin' })
    .onConflictDoNothing().returning();
  console.log(r.length ? `已新增後台帳號 ${username}` : `帳號 ${username} 已存在，未變更。`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
