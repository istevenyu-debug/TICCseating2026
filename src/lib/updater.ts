/**
 * 一鍵更新（網站端）：顯示目前版本／最新版本、按鈕送出更新要求、顯示進度。
 * 真正下載、建置、切換的是「啟動測試站」的主程式（scripts/updater.mjs），它每 5 秒寫一次 .update/supervisor.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { APP_VERSION } from './version';
import { BookingError } from './booking';
import { backupNow } from './backup';

const REPO = 'istevenyu-debug/TICCseating2026';
const dir = () => path.join(process.cwd(), '.update');
const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(path.join(dir(), f), 'utf8')) as T; } catch { return null; } };

let latestCache: { at: number; v: string } | null = null;
export async function latestVersion(now = Date.now()) {
  if (latestCache && now - latestCache.at < 60_000) return latestCache.v;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/src/lib/version.ts?t=${Math.floor(now / 60_000)}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const v = r.ok ? ((await r.text()).match(/APP_VERSION = '([^']+)'/) ?? [])[1] ?? '' : '';
    latestCache = { at: now, v };
    return v;
  } catch { return latestCache?.v ?? ''; }
}

export type UpdateStatus = { step: string; at: string; from?: string; to?: string; error?: string; rolledBack?: boolean };
export async function getUpdateInfo(now = Date.now()) {
  const beat = readJson<{ at: string; version: string }>('supervisor.json');
  const status = readJson<UpdateStatus>('status.json');
  const pending = existsSync(path.join(dir(), 'request.json'));
  return {
    current: APP_VERSION,
    latest: await latestVersion(now),
    canUpdate: !!beat && now - Date.parse(beat.at) < 20_000, // 用新版「啟動測試站.bat」啟動的才有更新功能
    pending,
    status,
  };
}

const RUNNING = ['download', 'install', 'build', 'switch', 'rollback'];
export async function requestUpdate(db: Db, actor: string, now = Date.now()) {
  const info = await getUpdateInfo(now);
  if (!info.canUpdate) throw new BookingError('INVALID', '這次是用舊版的啟動程式開的，還不能一鍵更新。請照說明手動更新最後一次。');
  if (info.pending || (info.status && RUNNING.includes(info.status.step) && now - Date.parse(info.status.at) < 15 * 60_000)) throw new BookingError('BUSY', '更新已經在進行中，請稍候。');
  await backupNow(db); // 更新前先備份一次
  mkdirSync(dir(), { recursive: true });
  writeFileSync(path.join(dir(), 'status.json'), JSON.stringify({ step: 'queued', at: new Date(now).toISOString(), from: APP_VERSION, to: info.latest }));
  writeFileSync(path.join(dir(), 'request.json'), JSON.stringify({ by: actor, at: new Date(now).toISOString() }));
  await db.insert(t.auditLog).values({ actor, action: 'app_update', target: 'app', detail: JSON.stringify({ from: APP_VERSION, to: info.latest }) });
  return { ok: true };
}
