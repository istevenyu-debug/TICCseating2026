/**
 * 建立示範資料：一個場次、兩條測試用專屬連結。
 * 用法：npm run db:seed
 * 已有場次時不重複建立。
 */
import { getDb } from '../src/db/client';
import { createEvent, createLink, seedVenue, setUsage } from '../src/db/seed';
import * as t from '../src/db/schema';

async function main() {
  const db = await getDb();
  await seedVenue(db);
  const existing = await db.select().from(t.event).limit(1);
  if (existing.length) {
    console.log(`已有場次（id ${existing[0].id}），未重複建立。`);
    process.exit(0);
  }
  const ev = await createEvent(db, {
    name: '2026 冬季音樂會（示範）',
    showAt: new Date('2026-12-20T19:30:00+08:00'),
    bankName: '範例銀行（代碼 000）',
    bankAccount: '000-00-0000000',
    accountName: '範例主辦單位',
  });
  await setUsage(db, ev.id, 'hold-pr', ['6-1', '6-2', '6-3', '6-4']);
  await setUsage(db, ev.id, 'hold-sponsor', ['1-1', '1-2', '1-3', '1-4', '1-5', '1-6']);
  const exp = new Date('2026-12-10T23:59:59+08:00');
  await createLink(db, { eventId: ev.id, code: 'DEMO26', name: '測試購票人', phone: '0900000000', quota: 6, expiresAt: exp });
  await createLink(db, { eventId: ev.id, code: 'DEMO27', name: '第二位測試者', phone: '0900000001', quota: 4, expiresAt: exp });
  console.log(`已建立場次 ${ev.id}。測試連結：/t/DEMO26、/t/DEMO27`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
