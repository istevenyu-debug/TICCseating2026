/**
 * 還原備份：先關掉網站（黑色視窗按 Ctrl + C），再執行「還原備份.bat」。
 * 會先把目前的資料另存一份（備份資料夾裡 before-restore-… 開頭），再用選的備份蓋掉。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { connect } from '../src/db/client';
import { backupDir, exportAll, fromGz, importAll, listBackups, toGz } from '../src/lib/backup';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const it = rl[Symbol.asyncIterator]();
const ask = async (q: string) => { process.stdout.write(q); const r = await it.next(); return r.done ? '' : String(r.value).trim(); };

(async () => {
  console.log('\n▶ 還原備份\n');
  try {
    await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(2000) });
    console.log('✖ 網站還開著。請先到「啟動測試站」的黑色視窗按 Ctrl + C 關掉，再執行一次。');
    process.exit(1);
  } catch { /* 沒開，繼續 */ }

  const list = listBackups().slice(0, 15);
  if (list.length) {
    console.log(`備份資料夾：${backupDir()}`);
    list.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${new Date(b.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}  ${b.name}`));
  } else console.log('備份資料夾裡沒有備份。');
  console.log('\n輸入編號；或把備份檔（例如從 Gmail 下載的 .json.gz）拖進這個視窗後按 Enter。');
  const ans = (await ask('選擇：')).replace(/^"|"$/g, '');
  const file = /^\d+$/.test(ans) && list[Number(ans) - 1] ? path.join(backupDir(), list[Number(ans) - 1].name) : ans;
  if (!file || !existsSync(file)) { console.log('✖ 找不到這個檔案。'); process.exit(1); }
  const b = fromGz(readFileSync(file));
  const n = (k: string) => b.tables[k]?.length ?? 0;
  console.log(`\n備份時間：${new Date(b.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}`);
  console.log(`內容：訂單 ${n('preorder')} 筆、劃位 ${n('orders')} 筆、劃位連結 ${n('invite_link')} 條、入場紀錄 ${n('checkin')} 筆`);
  if ((await ask('\n確定要還原？目前的資料會被這份備份取代。請輸入「還原」：')) !== '還原') { console.log('已取消。'); process.exit(0); }

  const db = await connect();
  mkdirSync(backupDir(), { recursive: true });
  const safety = path.join(backupDir(), `before-restore-${Date.now()}.json.gz`);
  writeFileSync(safety, toGz(await exportAll(db)));
  console.log(`已先把目前的資料另存：${safety}`);
  const r = await importAll(db, b);
  console.log(`\n✔ 還原完成（訂單 ${r.preorder} 筆、劃位 ${r.orders} 筆）。現在可以重新執行「啟動測試站.bat」。`);
  process.exit(0);
})().catch((e) => { console.error('\n✖ 還原失敗，資料沒有變動：', (e as Error).message); process.exit(1); });
