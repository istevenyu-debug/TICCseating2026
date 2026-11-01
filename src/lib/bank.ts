/** 網銀對帳：匯入入帳明細、略過非認購款、一次勾多筆「已匯款」 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { currentEvent } from './admin';
import { parseBankGrid } from './reconcile';

/** 匯入網銀明細（表格）。完整帳號只用來算 key，不存。同一筆重複匯入會略過 */
export async function importBank(db: Db, actor: string, grid: unknown[][]) {
  const ev = await currentEvent(db);
  const { rows, skipped } = parseBankGrid(grid);
  if (!rows.length) throw new BookingError('INVALID', '看不到任何「存入」的入帳。請確認是網銀下載的「交易明細」，或複製時有包含日期與金額。');
  let added = 0;
  for (const r of rows) {
    const key = createHash('sha256').update(`${r.at}|${r.amount}|${r.acct}|${r.balance}`).digest('hex').slice(0, 32);
    const ins = await db.insert(t.bankTx).values({ eventId: ev.id, at: new Date(r.at), amount: r.amount, last5: r.last5, memo: r.memo, key, createdBy: actor })
      .onConflictDoNothing().returning({ id: t.bankTx.id });
    added += ins.length;
  }
  const noCode = rows.filter((r) => !r.last5).length;
  await db.insert(t.auditLog).values({ actor, action: 'bank_import', target: 'bank_tx', detail: JSON.stringify({ rows: rows.length, added, skipped }) });
  return { rows: rows.length, added, dup: rows.length - added, skipped, noCode };
}

export async function listBank(db: Db) {
  const ev = await currentEvent(db);
  const rows = await db.select({ id: t.bankTx.id, at: t.bankTx.at, amount: t.bankTx.amount, last5: t.bankTx.last5, memo: t.bankTx.memo, ignored: t.bankTx.ignored })
    .from(t.bankTx).where(eq(t.bankTx.eventId, ev.id)).orderBy(desc(t.bankTx.at), desc(t.bankTx.id));
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

export async function ignoreBank(db: Db, actor: string, id: number, on: boolean) {
  const ev = await currentEvent(db);
  const r = await db.update(t.bankTx).set({ ignored: on }).where(and(eq(t.bankTx.id, id), eq(t.bankTx.eventId, ev.id))).returning({ id: t.bankTx.id });
  if (!r.length) throw new BookingError('NOT_FOUND', '找不到這筆入帳');
  await db.insert(t.auditLog).values({ actor, action: on ? 'bank_ignore' : 'bank_unignore', target: `bank_tx:${id}` });
}

/** 全部清除（上傳錯帳戶的明細時用） */
export async function clearBank(db: Db, actor: string) {
  const ev = await currentEvent(db);
  const r = await db.delete(t.bankTx).where(eq(t.bankTx.eventId, ev.id)).returning({ id: t.bankTx.id });
  await db.insert(t.auditLog).values({ actor, action: 'bank_clear', target: 'bank_tx', detail: String(r.length) });
  return { removed: r.length };
}

/** 一次勾（或取消勾）多筆「已匯款」：只記錄，不寄任何東西 */
export async function checkPaidMany(db: Db, actor: string, ids: number[], paid: boolean, now = new Date()) {
  const ev = await currentEvent(db);
  if (!ids.length) return { n: 0 };
  const r = await db.update(t.preorder)
    .set(paid ? { paidOkAt: now, paidOkBy: actor, seenAt: sql`coalesce(${t.preorder.seenAt}, ${now.toISOString()}::timestamptz)` } : { paidOkAt: null, paidOkBy: null })
    .where(and(eq(t.preorder.eventId, ev.id), inArray(t.preorder.id, ids), sql`${t.preorder.status} <> 'cancelled'`)).returning({ id: t.preorder.id });
  await db.insert(t.auditLog).values({ actor, action: paid ? 'preorder_check_many' : 'preorder_uncheck_many', target: 'preorder', detail: JSON.stringify(r.map((x) => x.id)) });
  return { n: r.length };
}
