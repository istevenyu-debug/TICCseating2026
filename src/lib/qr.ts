/** 入場 QR code 內容與簽章（獨立模組，避免互相引用） */
import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';

/** 簽章密鑰：第一次使用時自動產生，存在資料庫 */
export async function qrSecret(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, 'qr.secret'));
  if (r?.value) return r.value;
  await db.insert(t.appSetting).values({ key: 'qr.secret', value: randomBytes(32).toString('hex') }).onConflictDoNothing();
  const [again] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, 'qr.secret'));
  return again.value;
}

const sign = (secret: string, serial: string) => createHmac('sha256', secret).update(serial).digest('base64url').slice(0, 12);

/** QR 內容：TICC|序號|簽章 */
export const qrValue = (secret: string, serial: string) => `TICC|${serial}|${sign(secret, serial)}`;

/** 從掃到的文字取出序號；簽章不符回傳 null */
export function readQr(secret: string, text: string): { serial: string } | null {
  const m = text.trim().match(/^TICC\|([A-Z0-9-]{4,40})\|([A-Za-z0-9_-]{12})$/);
  if (!m) return null;
  return sign(secret, m[1]) === m[2] ? { serial: m[1] } : null;
}
