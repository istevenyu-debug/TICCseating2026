import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPgliteDb } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { backupNow, exportAll, fromGz, importAll, toGz } from '@/lib/backup';
import { confirmPreorder, listPreorders, submitPreorder } from '@/lib/preorder';

describe('備份與還原', () => {
  it('匯出成壓縮檔、還原到全新的資料庫，資料一致，流水號接續', async () => {
    const db = await createPgliteDb(); await seedVenue(db);
    await createEvent(db, { name: '祈福音樂會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
    await A.publish(db, 'admin'); await A.updateEventSettings(db, 'admin', { preorderOpen: true });
    const combo = (await db.select().from(t.combo)).find((c) => c.name === '雙人套票')!.id;
    await submitPreorder(db, { items: [{ kind: 'combo', id: combo, qty: 1 }], name: '林大同', phone: '0912345678', email: 'l@x.co', paidAmount: 6080, last5: '12345', agree: true });
    await confirmPreorder(db, 'admin', (await listPreorders(db))[0].id);

    const dir = mkdtempSync(path.join(tmpdir(), 'ticc-bk-'));
    process.env.BACKUP_DIR = dir;
    const { file } = await backupNow(db, new Date('2026-11-02T10:00:00+08:00'));
    expect(path.basename(file)).toBe('ticc-202611021000.json.gz');
    expect(readdirSync(dir)).toHaveLength(1);
    const b = fromGz(readFileSync(file));
    expect(b.tables.preorder).toHaveLength(1);

    const db2 = await createPgliteDb();
    const r = await importAll(db2, b);
    expect(r.preorder).toBe(1);
    expect(r.event_seat).toBeGreaterThan(500);
    const [po] = await db2.select().from(t.preorder);
    expect(po).toMatchObject({ no: 'P0001', name: '林大同', status: 'confirmed' });
    expect(JSON.stringify((await exportAll(db2)).tables)).toBe(JSON.stringify((await exportAll(db)).tables));
    // 還原後還能繼續下單，編號接續
    await submitPreorder(db2, { items: [{ kind: 'combo', id: combo, qty: 1 }], name: '王', phone: '0922222222', email: 'w@x.co', paidAmount: 6080, last5: '22222', agree: true }, '2');
    expect((await listPreorders(db2)).map((x) => x.no)).toEqual(['P0002', 'P0001']);
    // 再還原一次（覆蓋）也沒問題
    await importAll(db2, fromGz(toGz(b)));
    expect(await db2.select().from(t.preorder)).toHaveLength(1);
    delete process.env.BACKUP_DIR;
  }, 60000);
});
