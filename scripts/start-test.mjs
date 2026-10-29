/**
 * 一鍵啟動測試站（家用電腦、不需固定 IP）
 *
 * 1. 第一次執行時詢問後台帳號密碼，寫入 .env.local
 * 2. 建置網站（第一次約 1–2 分鐘）、建立示範場次
 * 3. 啟動網站，並透過 Cloudflare 臨時通道產生一個 https 網址，手機可直接開啟
 *
 * 用法：npm run test-site
 * 停止：在這個視窗按 Ctrl + C
 * 注意：電腦關機或關掉這個視窗，網址就連不上。
 * 沒設定固定網址時用 Cloudflare 臨時通道，每次重新啟動網址都會改變；
 * 執行過「設定固定網址.bat」後（.env.local 有 TUNNEL_TOKEN 與 SITE_URL），改用自己的網域，網址固定。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const PORT = 3000;
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';

const say = (s) => console.log(`\n▶ ${s}`);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) { console.error(`\n✖ 執行失敗：${cmd} ${args.join(' ')}`); process.exit(1); }
};

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) { console.error('✖ Node.js 版本太舊，請安裝 20 版以上：https://nodejs.org'); process.exit(1); }

/* 1. 後台帳號 */
if (!existsSync('.env.local')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  say('第一次啟動：設定後台登入帳號');
  const user = (await rl.question('後台帳號（直接按 Enter 用 admin）：')).trim() || 'admin';
  let pass = '';
  while (pass.length < 10) {
    pass = (await rl.question('後台密碼（至少 10 個字元，這個網址會公開在網路上，請勿用簡單密碼）：')).trim();
    if (pass.length < 10) console.log('  密碼太短，請再輸入一次。');
  }
  rl.close();
  writeFileSync('.env.local', [
    `ADMIN_USERNAME=${user}`,
    `ADMIN_PASSWORD=${pass}`,
    `SESSION_SECRET=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'));
  console.log('  已存到 .env.local（只在這台電腦）。');
}
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/* 2. 建置與示範資料 */
// 解壓縮新版 ZIP「取代檔案」不會刪掉舊版已移除的檔案，這裡先清掉，避免建置失敗
for (const old of ['src/app/app-icon', '.next/types']) rmSync(old, { recursive: true, force: true });
say('建置網站（約 1–2 分鐘）'); run(npm, ['run', 'build']);
say('準備資料庫'); run(npm, ['run', 'db:seed']);

/* 3. 啟動網站：先確認連接埠沒被上一次的網站佔用 */
try {
  const r = await fetch(`http://localhost:${PORT}/`);
  if (r) {
    console.error(`\n✖ 連接埠 ${PORT} 已被佔用，可能是上一次的網站還在背景執行。`);
    console.error(isWin ? '  請關掉所有黑色視窗，開一個新的命令提示字元輸入：taskkill /F /IM node.exe，再重新啟動。' : `  請執行：lsof -ti :${PORT} | xargs kill，再重新啟動。`);
    process.exit(1);
  }
} catch { /* 沒有回應代表連接埠可用 */ }

say(`啟動網站（本機 http://localhost:${PORT}）`);
const fixedUrl = (env.SITE_URL ?? '').replace(/\/$/, '');
const web = spawn(npx, ['next', 'start', '-p', String(PORT)], { stdio: 'inherit', shell: isWin, env: { ...process.env, ...env, ...(fixedUrl ? { PUBLIC_BASE_URL: fixedUrl } : {}) } });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch { /* 等待啟動 */ }
  await new Promise((r) => setTimeout(r, 1000));
}

/* 4. Cloudflare 通道：有固定網址用自己的網域，否則用臨時通道 */
const fixed = !!(env.TUNNEL_TOKEN && fixedUrl);
say(fixed ? `連上固定網址 ${fixedUrl}（Cloudflare 通道）` : '建立對外的 https 網址（Cloudflare 臨時通道）');
const { bin, install } = await import('cloudflared');
if (!existsSync(bin)) { console.log('  第一次使用，下載 cloudflared…'); await install(bin); }
const tunnel = fixed
  ? spawn(bin, ['tunnel', '--no-autoupdate', 'run', '--token', env.TUNNEL_TOKEN])
  : spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
let shown = false;
const onOut = (buf) => {
  // 固定網址：通道連上就顯示；臨時通道網址形如 https://xxx-yyy-zzz.trycloudflare.com（排除 api.trycloudflare.com）
  const m = fixed ? (/Registered tunnel connection/i.test(String(buf)) ? [fixedUrl] : null)
    : String(buf).match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
  if (fixed && /Unauthorized|invalid token|failed to unmarshal/i.test(String(buf)) && !shown) {
    shown = true;
    console.log('\n✖ 固定網址的通道代碼不正確或已失效。請重新執行「設定固定網址.bat」貼上新的代碼。');
  }
  if (m && !shown) {
    shown = true;
    const url = m[0];
    const text = [
      '============================================================',
      ' 測試站已啟動（請保持這個視窗開著，電腦不要睡眠）',
      ` 版本：${(readFileSync('src/lib/version.ts', 'utf8').match(/APP_VERSION = '([^']+)'/) ?? [])[1] ?? ''}`,
      ` 資料夾：${root}`,
      '',
      ` 後台（桌機）：  ${url}/admin`,
      '',
      ' 購票連結：到後台「五、專屬連結」發連結，按「複製連結」就是完整網址。',
      ...(fixed ? [' 這是固定網址，重新啟動也不會變。', ' 停止：按 Ctrl + C。'] : [
        ' 網址換了，之前傳出去的連結要重新複製再傳一次。',
        ' 停止：按 Ctrl + C。重新啟動後網址會改變。',
      ]),
      '============================================================',
    ].join('\n');
    console.log(`\n${text}\n`);
    writeFileSync('測試網址.txt', `${text}\n`);
  }
};
tunnel.stdout.on('data', onOut);
tunnel.stderr.on('data', onOut);
setTimeout(() => { if (!shown) console.log('\n⚠ 30 秒內沒有取得網址。請確認網路正常，或按 Ctrl + C 後重新執行。'); }, 30_000);

// Windows 上 kill 只會停掉外層的 cmd，要用 taskkill /T 連同子程序一起停掉
const killTree = (p) => {
  if (!p.pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill();
};
const stop = () => { killTree(tunnel); killTree(web); process.exit(0); };
process.on('exit', () => { killTree(tunnel); killTree(web); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
web.on('exit', (c) => { console.log(`網站已停止（${c}）`); tunnel.kill(); process.exit(c ?? 0); });
