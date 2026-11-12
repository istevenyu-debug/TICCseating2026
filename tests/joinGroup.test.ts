import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { ensureFloor3 } from '@/lib/floor';
import { setJoinSettings } from '@/lib/join';
import { groupDelete, groupFix, groupMenu, groupPage, groupSubmit, mergeGroups, moveReport, nextFreeName, groupKey, renameGroup } from '@/lib/joinGroup';
import { joinAdminState, lockSlots, uploadEra } from '@/lib/joinQueue';

let db: Db;
const BASE = 'https://ticket.example.com';
const N = new Date('2026-11-13T10:00:00+08:00');
let n = 0;
const ip = () => `10.1.0.${++n}`;
const msg = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return (e as Error).message; } };
const head = (name: string, headPhone: string, headName = '王小明') => ({ name, headName, headPhone, email: `${headPhone}@example.com` });
type R = Awaited<ReturnType<typeof groupSubmit>>;
const gid = (r: R) => ('group' in r && r.group ? r.group.id : 0);

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
});

describe('揪團回報：共用連結、不用註冊', () => {
  it('負責人「只建群」：開放建群才可以；自動生效、寄確認信；清單只有群名與遮蔽姓名', async () => {
    expect(await msg(groupSubmit(db, { group: head('台北大安1', '0912000001'), createOnly: true, device: 'd1' }, ip(), N, BASE))).toContain('尚未開放');
    await setJoinSettings(db, '網管', { open: true });
    const r = await groupSubmit(db, { group: head(' 台北大安１ ', '0912-000-001'), createOnly: true, device: 'd1' }, ip(), N, BASE);
    expect(r).toMatchObject({ created: true, group: { name: '台北大安1', head: '王○○' } });
    const m = await groupMenu(db, N);
    expect(m.groups).toEqual([{ id: gid(r), name: '台北大安1', head: '王○○' }]);
    expect(m.reportOpen).toBe(false);
    const [mail] = await db.select().from(t.notification).where(eq(t.notification.template, 'join_group'));
    expect(mail.content).toContain('台北大安1');
    expect(mail.content).toContain(`${BASE}/join`);
    // 回報還沒開放：只能建群
    expect(await msg(groupSubmit(db, { groupId: gid(r), device: 'd2', reporter: '志工', rows: [{ orderNo: '0109', qty: 6 }] }, ip(), N, BASE))).toContain('沒有開放');
  });

  it('同名同手機＝同一群；同名不同手機＝不存，提供下一個序號與「您的群」', async () => {
    await setJoinSettings(db, '網管', { open: true, reportOpen: true });
    const a = await groupSubmit(db, { group: head('台北群', '0912000001'), createOnly: true, device: 'a' }, ip(), N, BASE);
    expect((await groupSubmit(db, { group: head('台北群', '0912000001', '王'), createOnly: true, device: 'a2' }, ip(), N, BASE))).toMatchObject({ created: false, group: { id: gid(a) } });
    const b = await groupSubmit(db, { group: head('台北群', '0922000002', '陳大文'), createOnly: true, device: 'b' }, ip(), N, BASE);
    expect(b).toEqual({ clash: { name: '台北群', head: '王○○', phoneTail: '001', suggest: '台北群2', mine: [] } });
    const b2 = await groupSubmit(db, { group: head('台北群2', '0922000002', '陳大文'), createOnly: true, device: 'b' }, ip(), N, BASE);
    expect(b2).toMatchObject({ created: true, group: { name: '台北群2', head: '陳○○' } });
    // 陳的志工又打「台北群」：提示他的群是台北群2；林來了拿到 3
    expect((await groupSubmit(db, { group: head('台北群', '0922000002'), createOnly: true }, ip(), N, BASE))).toMatchObject({ clash: { suggest: '台北群3', mine: [{ id: gid(b2), name: '台北群2' }] } });
    expect((await groupSubmit(db, { group: head('台北 群', '0933000003'), createOnly: true }, ip(), N, BASE))).toMatchObject({ clash: { suggest: '台北群3' } });
    expect(nextFreeName('台北大安1', new Set([groupKey('台北大安1'), groupKey('台北大安2')]))).toBe('台北大安3');
  });

  it('志工點選群回報（後 4 碼＋今天）；10 人同時送出不重複建群、同一筆只算一次；只有自己手機能刪', async () => {
    await setJoinSettings(db, '網管', { open: true, reportOpen: true, perSeat: 6 });
    await uploadEra(db, '網管', [{ orderNo: 'ER2611130000109', qty: 6, status: 'sold' }]);
    // 同時：3 支不同負責人手機都要建「台北群」，另外 7 位志工報同一筆
    const all = await Promise.all([
      groupSubmit(db, { group: head('台北群', '0912000001'), createOnly: true }, ip(), N, BASE),
      groupSubmit(db, { group: head('台北群', '0922000002'), createOnly: true }, ip(), N, BASE),
      groupSubmit(db, { group: head('台北群', '0912000001'), createOnly: true }, ip(), N, BASE),
      groupSubmit(db, { group: head('台北群', '0933000003'), createOnly: true }, ip(), N, BASE),
    ]);
    expect(all.filter((r) => 'created' in r && r.created)).toHaveLength(1);
    expect(all.filter((r) => 'clash' in r)).toHaveLength(2);
    expect((await groupMenu(db, N)).groups).toHaveLength(1);
    const g = gid(all[0]);
    const sends = await Promise.all(Array.from({ length: 7 }, (_, i) =>
      groupSubmit(db, { groupId: g, device: `v${i}`, reporter: `志工${i}`, buyDate: '2026-11-13', rows: [{ orderNo: '0109', qty: 6 }] }, ip(), N, BASE)));
    expect(sends.filter((r) => 'accepted' in r && r.accepted.length === 1)).toHaveLength(1);
    const okIdx = sends.findIndex((r) => 'accepted' in r && r.accepted.length === 1);
    const pg = await groupPage(db, g, `v${okIdx}`);
    expect(pg).toMatchObject({ verified: 6, slots: [1] });
    expect(pg.list[0]).toMatchObject({ mine: true, orderNo: 'ER2611130000109', reporter: `志工${okIdx}` });
    const other = await groupPage(db, g, 'someone');
    expect(other.list[0]).toMatchObject({ mine: false, orderNo: null, key: '0109', reporter: '志○○' });
    expect(await msg(groupDelete(db, g, pg.list[0].id, 'someone'))).toContain('只有送出這筆的手機');
    expect(await msg(groupFix(db, g, pg.list[0].id, 'someone', 'ER2611130000109'))).toContain('只有送出這筆的手機');
    await groupDelete(db, g, pg.list[0].id, `v${okIdx}`);
    expect((await groupPage(db, g)).list).toHaveLength(0);
  });

  it('後台：改群名（不可撞名）、合併、移動回報；鎖定後不能合併、移動', async () => {
    await setJoinSettings(db, '網管', { open: true, reportOpen: true, perSeat: 6 });
    const a = gid(await groupSubmit(db, { group: head('木柵', '0912000001'), createOnly: true }, ip(), N, BASE));
    const b = gid(await groupSubmit(db, { group: head('台北木柵', '0922000002'), createOnly: true }, ip(), N, BASE));
    await groupSubmit(db, { groupId: a, device: 'x', reporter: '甲', buyDate: '2026-11-13', rows: [{ orderNo: '0001', qty: 3 }, { orderNo: '0002', qty: 2 }] }, ip(), N, BASE);
    expect(await msg(renameGroup(db, '網管', a, '台北 木柵'))).toContain('已經有了');
    await renameGroup(db, '網管', a, '木柵週二班');
    expect((await groupMenu(db, N)).groups.map((g) => g.name).sort()).toEqual(['台北木柵', '木柵週二班'].sort());
    const [r1] = await db.select().from(t.joinReport).where(eq(t.joinReport.key, '0001'));
    await moveReport(db, '網管', r1.id, b);
    expect(await mergeGroups(db, '網管', a, b)).toEqual({ moved: 1 });
    expect((await groupMenu(db, N)).groups.map((g) => g.name)).toEqual(['台北木柵']);
    expect((await groupPage(db, b)).list).toHaveLength(2);
    expect(await msg(groupPage(db, a))).toContain('找不到這個群');
    await uploadEra(db, '網管', [{ orderNo: 'ER2611130000001', qty: 3, status: 'sold' }, { orderNo: 'ER2611130000002', qty: 3, status: 'sold' }]);
    await groupSubmit(db, { groupId: b, device: 'y', reporter: '乙', buyDate: '2026-11-13', rows: [{ orderNo: 'ER2611130000777', qty: 1 }] }, ip(), N, BASE);
    const c = gid(await groupSubmit(db, { group: head('新竹', '0933000003'), createOnly: true }, ip(), N, BASE));
    await uploadEra(db, '網管', [{ orderNo: 'ER2611130000003', qty: 6, status: 'sold' }]);
    await groupSubmit(db, { groupId: c, device: 'z', reporter: '丙', buyDate: '2026-11-13', rows: [{ orderNo: '0003', qty: 6 }] }, ip(), N, BASE);
    await lockSlots(db, '網管');
    expect(await msg(mergeGroups(db, '網管', b, c))).toContain('已鎖定');
    expect(await msg(moveReport(db, '網管', r1.id, c))).toContain('已鎖定');
    expect(await msg(groupSubmit(db, { groupId: c, device: 'z', reporter: '丙', rows: [{ orderNo: '0004', qty: 1 }] }, ip(), N, BASE))).toContain('截止');
    expect((await joinAdminState(db, BASE, N)).totals.map((x) => x.venue).sort()).toEqual(['台北木柵', '新竹']);
  });
});
