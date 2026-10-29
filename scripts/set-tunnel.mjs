/**
 * 設定固定網址：把 Cloudflare 通道代碼與網址寫進 .env.local。
 * 之後執行「啟動測試站.bat」就會用固定網址（例如 https://ticket.aolforgood.com）。
 * 想改回臨時網址：再執行一次，代碼直接按 Enter 留空。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const it = rl[Symbol.asyncIterator]();
const ask = async (q) => { process.stdout.write(q); const r = await it.next(); return r.done ? '' : String(r.value); };
console.log('\n▶ 設定固定網址\n');
console.log('請到 Cloudflare 建立通道後，把畫面上那一整行安裝指令（含 eyJ 開頭的長代碼）複製貼上。');
const raw = (await ask('貼上（按 Enter 留空＝改回臨時網址）：')).trim();
const token = (raw.match(/eyJ[A-Za-z0-9_\-=.]{40,}/) ?? [''])[0];
let url = '';
if (raw && !token) { console.log('\n✖ 沒找到代碼（應該是 eyJ 開頭的一長串）。請重新複製後再執行一次。'); process.exit(1); }
if (token) {
  while (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(url)) {
    url = (await ask('網址（例：https://ticket.aolforgood.com）：')).trim().replace(/\/$/, '');
    if (url && !url.startsWith('http')) url = `https://${url}`;
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(url)) { console.log('  格式不對，請再輸入一次。'); if (!url) { const r = await it.next(); if (r.done) process.exit(1); url = String(r.value).trim(); if (url && !url.startsWith('http')) url = `https://${url}`; } }
  }
}
rl.close();
const lines = existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !/^(TUNNEL_TOKEN|SITE_URL)=/.test(l)) : [];
if (token) lines.push(`TUNNEL_TOKEN=${token}`, `SITE_URL=${url}`);
writeFileSync('.env.local', `${lines.join('\n')}\n`);
console.log(token ? `\n✔ 已設定。之後執行「啟動測試站.bat」，網址固定為 ${url}` : '\n✔ 已改回臨時網址。');
