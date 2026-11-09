import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { exportAll, importAll } from '@/lib/backup';
import {
  addVenues, decideReg, deleteReg, deleteVenue, editReg, joinAdminState, joinMenu, mergeVenue, setJoinSettings, setRegVenue, submitJoin, updateVenue,
} from '@/lib/join';

let db: Db;
let ipN = 0;
const ip = () => `10.0.0.${++ipN}`; // 每次換來源，不受防灌次數影響
beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
});

const venueId = async (name: string) => (await db.select().from(t.joinVenue).where(eq(t.joinVenue.name, name)))[0].id;
const base = (vid: number | null, extra: Record<string, unknown> = {}) => ({
  venueId: vid, venueText: '', headName: '王小明', headPhone: '0912-345-678',
  leaders: [{ sameAsHead: true, email: 'wang@example.com' }], consent: true, ...extra,
});
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };

describe('揪團登記（第一階段）', () => {
  it('預設關閉：登記頁不給團練場、送出被擋；開放後才收', async () => {
    await addVenues(db, '網管', ['台北微風小棧', '台北木柵']);
    expect((await joinMenu(db)).open).toBe(false);
    expect((await joinMenu(db)).venues).toEqual([]);
    expect(await msg(submitJoin(db, base(await venueId('台北木柵')), ip()))).toContain('尚未開放');
    await setJoinSettings(db, '網管', { open: true, contact: '群票服務' });
    const m = await joinMenu(db);
    expect(m.venues.map((v) => v.name).sort()).toEqual(['台北微風小棧', '台北木柵'].sort());
    expect(m.contact).toBe('群票服務');
    expect(JSON.stringify(m)).not.toContain('0912'); // 不含個資
  });

  it('團練場一行一個新增，重複略過；可隱藏、改名、合併、只能刪沒有登記的', async () => {
    expect(await addVenues(db, '網管', ['台北木柵', ' 台北木柵 ', '', '木柵'])).toEqual({ added: 2, skipped: 0 }); // 同一批重複的合成一個
    expect(await addVenues(db, '網管', ['台北木柵'])).toEqual({ added: 0, skipped: 1 });
    await setJoinSettings(db, '網管', { open: true });
    const r = await submitJoin(db, base(await venueId('木柵')), ip());
    expect(await msg(deleteVenue(db, '網管', await venueId('木柵')))).toContain('不能刪除');
    expect(await msg(updateVenue(db, '網管', await venueId('木柵'), { name: '台北木柵' }))).toContain('合併');
    await mergeVenue(db, '網管', await venueId('木柵'), await venueId('台北木柵'));
    const [reg] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, r.id));
    expect(reg.venueId).toBe(await venueId('台北木柵'));
    await updateVenue(db, '網管', await venueId('台北木柵'), { active: false });
    expect((await joinMenu(db)).venues).toEqual([]);
    expect(await msg(submitJoin(db, base(await venueId('台北木柵'), { headPhone: '0922000111', leaders: [{ sameAsHead: true, email: 'a@b.co' }] }), ip()))).toContain('找不到這個團練場');
  });

  it('同負責人自動帶入姓名、手機；可多位揪團人；沒有 Email 要勾選', async () => {
    await addVenues(db, '網管', ['台北木柵']);
    await setJoinSettings(db, '網管', { open: true });
    const v = await venueId('台北木柵');
    const r = await submitJoin(db, base(v, { leaders: [
      { sameAsHead: true, email: 'wang@example.com' },
      { name: ' 李 大 華 ', phone: '0933 111 222', noEmail: true },
    ] }), ip());
    const ls = await db.select().from(t.joinLeader).where(eq(t.joinLeader.regId, r.id));
    expect(ls.map((l) => [l.name, l.phone, l.email, l.noEmail, l.sameAsHead])).toEqual([
      ['王小明', '0912345678', 'wang@example.com', false, true],
      ['李 大 華', '0933111222', '', true, false],
    ]);
    expect(new Set(ls.map((l) => l.code)).size).toBe(2);
    expect(r.contact).toBe('主辦方');

    expect(await msg(submitJoin(db, base(v, { headPhone: '0955000111', leaders: [{ sameAsHead: true, email: '' }] }), ip()))).toContain('Email');
    expect(await msg(submitJoin(db, base(v, { headPhone: '0955000111', leaders: [{ sameAsHead: true, email: 'x@y' }] }), ip()))).toContain('格式');
    expect(await msg(submitJoin(db, base(v, { headPhone: '0955000111', consent: false }), ip()))).toContain('同意');
    expect(await msg(submitJoin(db, base(v, { headPhone: '0955000111', leaders: [{ sameAsHead: true, noEmail: true }, { name: '甲', phone: '0955000111', noEmail: true }] }), ip()))).toContain('重複');
    expect(await msg(submitJoin(db, base(v, { headPhone: '0955000111', leaders: [{ name: '甲', phone: '0912', noEmail: true }] }), ip()))).toContain('10 位');
  });

  it('同一位揪團人不能登記兩次（不洩漏別人姓名）；退回後可重新登記', async () => {
    await addVenues(db, '網管', ['台北木柵', '台北微風小棧']);
    await setJoinSettings(db, '網管', { open: true });
    const r = await submitJoin(db, base(await venueId('台北木柵')), ip());
    const m = await msg(submitJoin(db, base(await venueId('台北微風小棧'), { headName: '陳某' }), ip()));
    expect(m).toContain('0912-345-678 已經登記過');
    expect(m).not.toContain('王小明');
    await decideReg(db, '網管', r.id, 'rejected', '重複登記');
    const r2 = await submitJoin(db, base(await venueId('台北微風小棧')), ip());
    // 舊的那份不能直接恢復：手機已在新的一份
    expect(await msg(decideReg(db, '網管', r.id, 'pending'))).toContain(`第 ${r2.id} 號`);
  });

  it('「其他」團練場：要先指定才能核准；打的名字已在清單就直接用清單的', async () => {
    await addVenues(db, '網管', ['台北木柵']);
    await setJoinSettings(db, '網管', { open: true });
    const a = await submitJoin(db, base(null, { venueText: '台北木柵' }), ip());
    expect((await db.select().from(t.joinReg).where(eq(t.joinReg.id, a.id)))[0].venueId).toBe(await venueId('台北木柵'));

    const b = await submitJoin(db, base(null, { venueText: '新竹 竹北', headPhone: '0966111222', leaders: [{ sameAsHead: true, noEmail: true }] }), ip());
    expect(await msg(decideReg(db, '網管', b.id, 'approved'))).toContain('先指定團練場');
    await setRegVenue(db, '網管', b.id, { newName: '新竹竹北' });
    await decideReg(db, '網管', b.id, 'approved');
    const s = await joinAdminState(db);
    const reg = s.regs.find((r) => r.id === b.id)!;
    expect(reg).toMatchObject({ venueName: '新竹竹北', venueText: '新竹 竹北', status: 'approved', decidedBy: '網管' });
    expect(s.venues.find((v) => v.name === '新竹竹北')).toMatchObject({ regs: 1, approved: 1, leaders: 1 });
    expect(await msg(submitJoin(db, base(null, { venueText: '', headPhone: '0977000111' }), ip()))).toContain('選擇團練場');
  });

  it('退回必填原因；可改回待審；只能刪已退回的；後台可修改揪團人', async () => {
    await addVenues(db, '網管', ['台北木柵']);
    await setJoinSettings(db, '網管', { open: true });
    const r = await submitJoin(db, base(await venueId('台北木柵')), ip());
    expect(await msg(decideReg(db, '網管', r.id, 'rejected', ' '))).toContain('原因');
    expect(await msg(deleteReg(db, '網管', r.id))).toContain('已退回');

    const [l] = await db.select().from(t.joinLeader).where(eq(t.joinLeader.regId, r.id));
    await editReg(db, '網管', r.id, { headName: '王小明', headPhone: '0912345678', note: '老師確認過', leaders: [
      { id: l.id, name: '王小明', phone: '0912345678', email: 'new@example.com' },
      { name: '林助理', phone: '0988123456', noEmail: true },
    ] });
    const ls = await db.select().from(t.joinLeader).where(eq(t.joinLeader.regId, r.id));
    expect(ls.map((x) => [x.name, x.email, x.sameAsHead])).toEqual([['王小明', 'new@example.com', true], ['林助理', '', false]]);
    expect(ls[0].code).toBe(l.code); // 原本那位的連結代碼不變

    await decideReg(db, '網管', r.id, 'rejected', '測試');
    await decideReg(db, '網管', r.id, 'pending');
    expect((await joinAdminState(db)).regs[0]).toMatchObject({ status: 'pending', reason: '', decidedAt: null });
    await decideReg(db, '網管', r.id, 'rejected', '測試');
    await deleteReg(db, '網管', r.id);
    expect(await db.select().from(t.joinLeader)).toHaveLength(0);
  });

  it('備份包含揪團資料；沒有這些資料表的舊備份照樣能還原', async () => {
    await addVenues(db, '網管', ['台北木柵']);
    await setJoinSettings(db, '網管', { open: true });
    await submitJoin(db, base(await venueId('台北木柵')), ip());
    const b = await exportAll(db);
    expect(b.tables.join_reg).toHaveLength(1);
    const db2 = await createPgliteDb();
    await importAll(db2, b);
    expect(await db2.select().from(t.joinLeader)).toHaveLength(1);

    const old = { ...b, tables: { ...b.tables } };
    delete old.tables.join_venue; delete old.tables.join_reg; delete old.tables.join_leader;
    const db3 = await createPgliteDb();
    await importAll(db3, old);
    expect(await db3.select().from(t.joinReg)).toHaveLength(0);
    // 還原後流水號接續，可以繼續登記
    await addVenues(db3, '網管', ['台北木柵']);
    const v3 = (await db3.select().from(t.joinVenue))[0].id;
    expect((await submitJoin(db3, base(v3), ip())).id).toBeGreaterThan(0);
  });
});
