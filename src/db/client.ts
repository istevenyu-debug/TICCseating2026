/**
 * 資料庫連線。
 * - 有設定 DATABASE_URL：連正式 PostgreSQL。
 * - 未設定：使用 PGlite（WASM 版 PostgreSQL），資料存於 .data/pglite，僅供本機開發。
 * 兩者皆為 PostgreSQL 語意，交易與列鎖行為一致。
 */
import path from 'node:path';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

const MIGRATIONS = path.resolve(process.cwd(), 'drizzle');

const g = globalThis as unknown as { __ticcDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__ticcDb) {
    g.__ticcDb = connect().then(async (db) => {
      (await import('@/lib/notify')).startDispatcher(db); // 每 30 秒補寄通知
      return db;
    });
  }
  return g.__ticcDb;
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const db = drizzle(new Pool({ connectionString: url, max: 10 }), { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as Db;
  }
  return createPgliteDb(path.resolve(process.cwd(), '.data/pglite'));
}

/** dataDir 省略時為記憶體資料庫（測試用） */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  if (dataDir) (await import('node:fs')).mkdirSync(path.dirname(dataDir), { recursive: true });
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}
