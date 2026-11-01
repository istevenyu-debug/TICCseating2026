/**
 * 一鍵更新（由「啟動測試站」的主程式執行，網站本身只負責按鈕與顯示進度）
 *
 * 流程：後台按「立即更新」→ 網站先備份資料、寫入 .update/request.json →
 * 主程式看到後：
 *   1. 從 GitHub 下載最新版 ZIP、解壓到 .update/x
 *   2. 在 .update/stage 建置新版（舊版網站照常營業）；套件有變才先 npm install
 *   3. 建置成功才切換：停網站 → 舊程式存到 .update/prev → 換上新程式與建置結果 → 更新資料庫欄位 → 啟動
 *   4. 任何一步失敗：留在（或退回）舊版，並把原因寫進 .update/status.json，後台會顯示
 * .data（資料庫）、.env.local（帳密、通道代碼）、備份、node_modules 完全不動。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';
export const REPO = 'istevenyu-debug/TICCseating2026';
export const BRANCH = 'main';

/** 程式資料夾（整個換掉，舊版刪掉的檔案也會跟著刪）與頂層要覆蓋的檔案；其餘（.data、.env.local、備份…）一律不碰 */
const DIRS = ['src', 'scripts', 'drizzle', 'public', 'tests'];
const KEEP = new Set(['.data', '.env.local', '.env', '備份', 'node_modules', '.next', '.update', '測試網址.txt', '.git', '.data-before-video']);

export function updatePaths(root) {
  const u = path.join(root, '.update');
  return { dir: u, request: path.join(u, 'request.json'), status: path.join(u, 'status.json'), beat: path.join(u, 'supervisor.json'), log: path.join(u, 'update.log') };
}

const versionOf = (dir) => {
  try { return (readFileSync(path.join(dir, 'src/lib/version.ts'), 'utf8').match(/APP_VERSION = '([^']+)'/) ?? [])[1] ?? ''; } catch { return ''; }
};

function run(cmd, args, cwd, logFile) {
  const r = spawnSync(cmd, args, { cwd, shell: isWin, encoding: 'utf8', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  try { writeFileSync(logFile, `\n$ ${cmd} ${args.join(' ')}\n${out}`, { flag: 'a' }); } catch { /* 忽略 */ }
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失敗：${out.split(/\r?\n/).filter(Boolean).slice(-6).join(' ｜ ').slice(0, 600)}`);
  return out;
}

function unzip(zip, dest, logFile) {
  mkdirSync(dest, { recursive: true });
  if (isWin) {
    // Windows 10 以上內建 tar 可解 ZIP；不行就用 PowerShell
    try { return run('tar', ['-xf', zip, '-C', dest], dest, logFile); } catch { /* 改用 PowerShell */ }
    return run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], dest, logFile);
  }
  return run('unzip', ['-q', '-o', zip, '-d', dest], dest, logFile);
}

/** 解壓後找到真正的程式資料夾（ZIP 外面通常包了一層 TICCseating2026-main） */
function findRoot(dir) {
  if (existsSync(path.join(dir, 'package.json'))) return dir;
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory() && existsSync(path.join(p, 'package.json'))) return p;
  }
  throw new Error('下載的檔案裡找不到程式（package.json）');
}

/** 把 from 的程式檔放到 to：DIRS 整個換掉，頂層檔案覆蓋；KEEP 名單不碰 */
function placeProgram(from, to) {
  for (const n of readdirSync(from)) {
    if (KEEP.has(n)) continue;
    const src = path.join(from, n); const dst = path.join(to, n);
    if (DIRS.includes(n)) rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true, force: true });
  }
}

/** 刪暫存區前先拆掉 node_modules 連結（只拆連結，不碰真正的 node_modules） */
function dropDir(d) {
  const nm = path.join(d, 'node_modules');
  try { unlinkSync(nm); } catch { try { rmdirSync(nm); } catch { /* 沒有連結 */ } }
  rmSync(d, { recursive: true, force: true });
}

const deps = (dir) => { try { const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); return JSON.stringify([p.dependencies, p.devDependencies]); } catch { return ''; } };

/**
 * 執行一次更新。stopWeb／startWeb 由主程式提供（startWeb 需在網站可回應後才 resolve，失敗則 reject）。
 * setStatus(step, extra) 會寫進 status.json 讓後台顯示。
 */
export async function runUpdate({ root, stopWeb, startWeb, setStatus, zipUrl = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}` }) {
  const P = updatePaths(root);
  const x = path.join(P.dir, 'x'); const stage = path.join(P.dir, 'stage'); const prev = path.join(P.dir, 'prev'); const zip = path.join(P.dir, 'new.zip');
  const from = versionOf(root);
  mkdirSync(P.dir, { recursive: true });
  writeFileSync(P.log, `== 更新開始 ${new Date().toISOString()}（目前 ${from}）\n`);
  for (const d of [x, stage]) dropDir(d);

  // 1. 下載
  setStatus('download', { from });
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`下載新版失敗（${res.status}），請確認網路`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  unzip(zip, x, P.log);
  const src = findRoot(x);
  const to = versionOf(src);
  if (!to) throw new Error('下載的檔案不是劃位系統');
  if (to === from) { setStatus('same', { from, to }); return { from, to, same: true }; }

  // 2. 套件有變：先裝（網站照常營業）
  if (deps(src) !== deps(root)) {
    setStatus('install', { from, to });
    cpSync(path.join(src, 'package.json'), path.join(root, 'package.json'));
    if (existsSync(path.join(src, 'package-lock.json'))) cpSync(path.join(src, 'package-lock.json'), path.join(root, 'package-lock.json'));
    run(npm, ['install', '--no-audit', '--no-fund'], root, P.log);
  }

  // 3. 在暫存區建置新版（舊版照常營業）
  setStatus('build', { from, to });
  mkdirSync(stage, { recursive: true });
  placeProgram(src, stage);
  symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), isWin ? 'junction' : 'dir');
  run(npm, ['run', 'build'], stage, P.log);

  // 4. 切換：停網站 → 舊版存起來 → 換上新版 → 更新資料庫欄位 → 啟動
  setStatus('switch', { from, to });
  await stopWeb();
  await new Promise((r) => setTimeout(r, 3000)); // 讓資料庫完全關好
  rmSync(prev, { recursive: true, force: true }); mkdirSync(prev, { recursive: true });
  for (const n of readdirSync(root)) if (!KEEP.has(n) || n === '.next') cpSync(path.join(root, n), path.join(prev, n), { recursive: true });
  // 資料庫整個資料夾先複製一份（網站已停，資料不會再變）：更新欄位失敗就原樣放回
  const dataDir = path.join(root, '.data'); const dataCopy = path.join(P.dir, 'data-before');
  rmSync(dataCopy, { recursive: true, force: true });
  if (existsSync(dataDir)) cpSync(dataDir, dataCopy, { recursive: true });
  const restoreData = () => { if (existsSync(dataCopy)) { rmSync(dataDir, { recursive: true, force: true }); cpSync(dataCopy, dataDir, { recursive: true }); } };
  try {
    placeProgram(src, root);
    rmSync(path.join(root, '.next'), { recursive: true, force: true });
    renameSync(path.join(stage, '.next'), path.join(root, '.next'));
    try { run(npm, ['run', 'db:seed'], root, P.log); } catch {
      restoreData(); await new Promise((r) => setTimeout(r, 5000));
      run(npm, ['run', 'db:seed'], root, P.log);
    }
    await startWeb();
  } catch (e) {
    // 退回舊版（程式與資料庫都放回更新前的樣子）
    setStatus('rollback', { from, to, error: String(e.message ?? e) });
    try { await stopWeb(); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 2000));
    for (const d of DIRS) rmSync(path.join(root, d), { recursive: true, force: true });
    rmSync(path.join(root, '.next'), { recursive: true, force: true });
    for (const n of readdirSync(prev)) cpSync(path.join(prev, n), path.join(root, n), { recursive: true, force: true });
    restoreData();
    await startWeb();
    throw e;
  }
  for (const d of [x, stage]) dropDir(d);
  rmSync(zip, { force: true });
  return { from, to, same: false };
}
