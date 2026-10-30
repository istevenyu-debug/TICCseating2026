import { describe, expect, it } from 'vitest';
import { pick } from '@/lib/formIn';

describe('Google 表單欄位對應', () => {
  it('依題目文字找欄位，個資與 LINE 題略過', () => {
    const p = pick([
      { q: '因應中華民國個資法規定，請點選同意此課程報名資料之蒐集與運用。', a: '同意' },
      { q: '姓名', a: '王小明' },
      { q: '電話', a: '0912-345-678' },
      { q: 'Email', a: 'a@b.com' },
      { q: '帳號後5碼（如使用2個以上帳號,請分別詳列及個別金額）', a: '12345 30000\n67890 2000' },
      { q: '勾選二三聯發票', a: '三聯' },
      { q: '公司名稱統編', a: '好公司 12345678' },
      { q: '加入LINE群連結', a: '確定' },
    ]);
    expect(p).toMatchObject({ name: '王小明', phone: '0912-345-678', email: 'a@b.com', last5: '12345 30000\n67890 2000', inv: '三聯', company: '好公司 12345678' });
  });
  it('沒有 Email 題時用表單收集的 Email', () => {
    expect(pick([{ q: '姓名', a: 'A' }], 'x@y.com').email).toBe('x@y.com');
  });
});

import { beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import * as A from '@/lib/admin';
import { ingestForm } from '@/lib/formIn';
import { confirmPreorder, listPreorders } from '@/lib/preorder';
import { linkEntitle } from '@/lib/booking';

describe('Google 表單匯入 → 確認收訖', () => {
  let db: Db; let zoneA: number;
  const resp = (id: string, name: string, email = 'a@b.com') => ({ id, at: '2026-10-31T01:00:00Z', answers: [
    { q: '姓名', a: name }, { q: '電話', a: '0912345678' }, { q: 'Email', a: email },
    { q: '帳號後5碼（如使用2個以上帳號,請分別詳列及個別金額）', a: '12345 6400' }, { q: '勾選二三聯發票', a: '二聯' }] });
  beforeEach(async () => {
    db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '祈福法會', showAt: new Date('2026-12-20T19:30:00+08:00'), bankName: '台灣銀行', bankAccount: '123-456', accountName: '主辦' });
    zoneA = (await db.select().from(t.priceZone)).find((z) => z.name === 'A區')!.id;
    await A.publish(db, 'admin');
  });

  it('同一筆回覆不重複；確認時選數量，寄劃位連結且只能劃付款的', async () => {
    expect(await ingestForm(db, { list: [resp('r1', '王小明'), resp('r2', '李四')] })).toEqual({ received: 2, added: 2 });
    expect(await ingestForm(db, { list: [resp('r1', '王小明'), resp('r2', '李四'), resp('r3', '張三')] })).toEqual({ received: 3, added: 1 });
    const list = await listPreorders(db);
    expect(list.map((p) => p.no).sort()).toEqual(['F0001', 'F0002', 'F0003']);
    const p = list.find((x) => x.name === '王小明')!;
    expect(p).toMatchObject({ source: 'form', status: 'submitted', items: [], last5: '12345 6400' });
    expect(await db.select().from(t.notification)).toHaveLength(0); // 表單來的不寄「收到訂單」
    await expect(confirmPreorder(db, 'admin', p.id)).rejects.toThrow('數量');
    const r = await confirmPreorder(db, 'admin', p.id, 'https://x', new Date(), [{ kind: 'zone', id: zoneA, qty: 2 }]);
    expect(r.fromForm).toBe(true);
    const mail = (await db.select().from(t.notification).where(eq(t.notification.template, 'preorder_link')));
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ channel: 'email', recipient: 'a@b.com' });
    expect(mail[0].content).toContain('A區 單張 × 2');
    expect(mail[0].content).toContain(`/t/${r.code}`);
    const ent = await linkEntitle(db, r.linkId);
    expect(ent?.rows[0]).toMatchObject({ qty: 2, left: 2 });
  });
});
