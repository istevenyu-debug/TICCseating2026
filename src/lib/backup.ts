/**
 * 備份與還原：把所有資料表匯出成一個壓縮的 JSON 檔（.json.gz）。
 *
 * - 自動：網站開著時，啟動 1 分鐘後備份一次，之後每小時一次，存在「備份」資料夾
 *   （可用環境變數 BACKUP_DIR 改位置）。保留最近 72 份，另外每天保留一份、保留 30 天。
 * - 每天第一次備份時，若已設定 Gmail，另寄一份到寄件信箱自己（異地備份：電腦壞了也找得回）。
 * - 後台首頁可「立即備份並下載」。
 * - 還原：關掉網站後執行「還原備份.bat」（scripts/restore.ts）。
 * - 同一份檔案也能匯入雲端的 PostgreSQL（搬到 Google Cloud 時用）。
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';

/** 依外鍵順序（還原時先刪後面的、先建前面的） */
export const TABLES = [
  'venue_seat', 'event', 'price_zone', 'seat_usage', 'event_seat', 'combo', 'combo_item', 'invite_link', 'orders', 'order_seat',
  'payment', 'notification', 'preorder', 'gate', 'checkin', 'push_sub', 'app_setting', 'audit_log', 'admin_user', 'invoice',
] as const;

export interface BackupFile { format: 'ticc-backup'; version: number; at: string; tables: Record<string, Record<string, unknown>[]> }

export async function exportAll(db: Db): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {};
  for (const tb of TABLES) {
    const r = await db.execute(sql.raw(`select * from "${tb}"`));
    tables[tb] = ((r as unknown as { rows?: Record<string, unknown>[] }).rows ?? (r as unknown as Record<string, unknown>[]));
  }
  return { format: 'ticc-backup', version: 1, at: new Date().toISOString(), tables };
}

export const toGz = (b: BackupFile) => gzipSync(Buffer.from(JSON.stringify(b)));
export function fromGz(buf: Buffer): BackupFile {
  const b = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8')) as BackupFile;
  if (b.format !== 'ticc-backup') throw new Error('這不是劃位系統的備份檔');
  return b;
}

/** 還原：清空所有資料表再寫回備份內容（同一交易，失敗就不變） */
export async function importAll(db: Db, b: BackupFile) {
  await db.transaction(async (tx) => {
    for (const tb of [...TABLES].reverse()) await tx.execute(sql.raw(`delete from "${tb}"`));
    for (const tb of TABLES) {
      const rows = b.tables[tb] ?? [];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = JSON.stringify(rows.slice(i, i + 500));
        await tx.execute(sql`insert into ${sql.raw(`"${tb}"`)} select * from jsonb_populate_recordset(null::${sql.raw(`"${tb}"`)}, ${chunk}::jsonb)`);
      }
      // 流水號接續最大值（只有數字流水號的資料表）
      const q = await tx.execute(sql.raw(`select pg_get_serial_sequence('"${tb}"', column_name) as seq from information_schema.columns where table_schema = 'public' and table_name = '${tb}' and column_name = 'id'`));
      const seq = (((q as unknown as { rows?: { seq: string | null }[] }).rows ?? (q as unknown as { seq: string | null }[]))[0])?.seq;
      if (seq) await tx.execute(sql.raw(`select setval('${seq}', coalesce((select max(id) from "${tb}"), 0) + 1, false)`));
    }
  });
  return Object.fromEntries(TABLES.map((tb) => [tb, (b.tables[tb] ?? []).length]));
}

export const backupDir = () => path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), '備份'));
const stamp = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/[-: ]/g, '').slice(0, 12); // 202611021530

/** 存一份到備份資料夾，並清掉太舊的 */
export async function backupNow(db: Db, now = new Date()) {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const gz = toGz(await exportAll(db));
  const file = path.join(dir, `ticc-${stamp(now)}.json.gz`);
  writeFileSync(file, gz);
  prune(dir, now);
  return { file, size: gz.length };
}

function prune(dir: string, now: Date) {
  const files = readdirSync(dir).filter((f) => /^ticc-\d{12}\.json\.gz$/.test(f)).sort().reverse(); // 新的在前
  const keepDays = new Set<string>();
  files.forEach((f, i) => {
    const day = f.slice(5, 13);
    const ageDays = (now.getTime() - statSync(path.join(dir, f)).mtimeMs) / 86400_000;
    const firstOfDay = !keepDays.has(day);
    keepDays.add(day);
    if (i < 72 || (firstOfDay && ageDays <= 30)) return;
    try { unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ }
  });
}

export function listBackups() {
  const dir = backupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^ticc-\d{12}\.json\.gz$/.test(f)).sort().reverse()
    .map((f) => ({ name: f, size: statSync(path.join(dir, f)).size, at: statSync(path.join(dir, f)).mtime.toISOString() }));
}

/** 每天第一次備份時寄一份到寄件信箱自己（異地備份） */
async function mailDaily(db: Db, now: Date) {
  const { getNotifyConfig } = await import('./notify');
  const cfg = (await getNotifyConfig(db)).email;
  if (!cfg) return;
  const day = stamp(now).slice(0, 8);
  const g = globalThis as unknown as { __ticcMailedDay?: string };
  if (g.__ticcMailedDay === day) return;
  const nodemailer = (await import('nodemailer')).default;
  const gz = toGz(await exportAll(db));
  const t = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
  await t.sendMail({
    from: cfg.fromName ? `"${cfg.fromName}" <${cfg.user}>` : cfg.user, to: cfg.user,
    subject: `【劃位系統備份】${day}`, text: '劃位系統每日自動備份（含個人資料，請勿轉寄）。還原方式：關掉網站後執行「還原備份.bat」，選擇這個檔案。',
    attachments: [{ filename: `ticc-${stamp(now)}.json.gz`, content: gz }],
  });
  g.__ticcMailedDay = day;
}

/** 網站啟動後：1 分鐘後備份一次，之後每小時一次 */
export function startBackups(db: Db) {
  const g = globalThis as unknown as { __ticcBackup?: NodeJS.Timeout };
  if (g.__ticcBackup || process.env.VITEST) return;
  const tick = async () => {
    try {
      const now = new Date();
      await backupNow(db, now);
      await mailDaily(db, now).catch((e) => console.error('每日備份信寄送失敗', e));
    } catch (e) { console.error('自動備份失敗', e); }
  };
  setTimeout(tick, 60_000);
  g.__ticcBackup = setInterval(tick, 3600_000);
}
