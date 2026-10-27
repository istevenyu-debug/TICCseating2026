/**
 * 準備資料庫：場館座位、一個空白場次（名稱與匯款帳戶請在後台填寫）。
 * 不再建立示範連結或示範場次；舊版留下的示範資料（DEMO26、DEMO27）會自動移除。
 * 用法：npm run db:seed（啟動測試站時會自動執行）
 */
import { getDb } from '../src/db/client';
import { createEvent, PLACEHOLDER_EVENT_NAME, removeDemoData, seedVenue } from '../src/db/seed';
import * as t from '../src/db/schema';

async function main() {
  const db = await getDb();
  await seedVenue(db);
  const existing = await db.select().from(t.event).limit(1);
  if (existing.length) {
    const r = await removeDemoData(db);
    if (r.links.length) console.log(`已移除舊版示範連結 ${r.links.join('、')}（含其下 ${r.orders} 筆訂單與通知）。`);
    if (r.renamed) console.log(`場次名稱原為示範文字，已改為「${PLACEHOLDER_EVENT_NAME}」，請到後台填寫。`);
    if (r.bankCleared) console.log('匯款帳戶原為範例資料，已清空，請到後台填寫。');
    console.log(`使用既有場次（id ${existing[0].id}）。`);
    process.exit(0);
  }
  const showAt = new Date(Date.now() + 60 * 86400_000);
  showAt.setUTCHours(11, 30, 0, 0); // 台北 19:30；請在後台改成實際演出時間
  const ev = await createEvent(db, { name: PLACEHOLDER_EVENT_NAME, showAt });
  console.log(`已建立空白場次（id ${ev.id}）。請到後台填寫演出名稱、演出時間與匯款帳戶。`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
