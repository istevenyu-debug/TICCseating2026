import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { dispatchQueued, saveNotifyConfig, sendTest } from '@/lib/notify';
import { isSafeMode, safeBlock } from '@/lib/safeMode';
import { createGates, gateInfo, listGates } from '@/lib/ticket';

let db: Db;
const keep = { mode: process.env.SAFE_MODE, allow: process.env.SAFE_MODE_ALLOW };

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '測試場次', showAt: new Date('2026-12-09T19:30:00+08:00') });
});
afterEach(() => {
  if (keep.mode === undefined) delete process.env.SAFE_MODE; else process.env.SAFE_MODE = keep.mode;
  if (keep.allow === undefined) delete process.env.SAFE_MODE_ALLOW; else process.env.SAFE_MODE_ALLOW = keep.allow;
});

describe('測試機（SAFE_MODE）', () => {
  it('沒開時什麼都不擋', () => {
    delete process.env.SAFE_MODE;
    expect(isSafeMode()).toBe(false);
    expect(() => safeBlock('email', 'buyer@example.com')).not.toThrow();
    expect(() => safeBlock('einv')).not.toThrow();
  });

  it('開了：Email 只放行允許清單（不分大小寫），簡訊、推播、正式綠界一律擋', () => {
    process.env.SAFE_MODE = '1';
    process.env.SAFE_MODE_ALLOW = 'me@test.com, Staff@Test.com';
    expect(() => safeBlock('email', 'buyer@example.com')).toThrow(/測試機/);
    expect(() => safeBlock('email', 'staff@test.com')).not.toThrow();
    expect(() => safeBlock('email', ' ME@test.com ')).not.toThrow();
    for (const k of ['sms', 'push', 'einv', 'card'] as const) expect(() => safeBlock(k)).toThrow(/測試機/);
  });

  it('還原的複本開機補寄：排隊中的信寄不出去、標成失敗並寫原因，不會算已寄出（不連 SMTP）', async () => {
    process.env.SAFE_MODE = '1';
    await saveNotifyConfig(db, 'tester', { 'email.user': 'ticket@gmail.com', 'email.pass': 'abcdabcdabcdabcd' });
    await db.insert(t.notification).values({ channel: 'email', template: 'order_confirmed', recipient: 'buyer@example.com', content: '【測試場次】劃位成功' });
    for (let i = 0; i < 3; i++) await dispatchQueued(db);
    const [n] = await db.select().from(t.notification);
    expect(n.status).toBe('failed');
    expect(n.error).toMatch(/測試機/);
    expect(n.sentAt).toBeNull();
    // 後台「寄測試信」給不在允許清單的信箱也擋
    await expect(sendTest(db, 'email', 'someone@example.com')).rejects.toThrow(/測試機/);
  });

  it('驗票頁知道是測試機（顯示紅色橫幅）', async () => {
    await createGates(db, 'admin', ['左1']);
    const [g] = await listGates(db);
    delete process.env.SAFE_MODE;
    expect((await gateInfo(db, g.token)).safeMode).toBe(false);
    process.env.SAFE_MODE = '1';
    expect((await gateInfo(db, g.token)).safeMode).toBe(true);
  });
});
