import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, type Db } from '@/db/client';
import { createEvent, seedVenue } from '@/db/seed';
import * as t from '@/db/schema';
import { ensureFloor3 } from '@/lib/floor';
import { paintFloor3, setJoinSettings } from '@/lib/join';
import { boardData } from '@/lib/joinBoard';
import { groupSubmit } from '@/lib/joinGroup';
import { lockSlots, submitPick, tickQueue, uploadEra } from '@/lib/joinQueue';

let db: Db;
let n = 0;
const ip = () => `10.2.0.${++n}`;
const T = (h: number, m = 0) => new Date(`2026-11-13T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const mk = async (name: string, phone: string) => {
  const r = await groupSubmit(db, { group: { name, headName: `${name}負責人`, headPhone: phone, email: `${phone}@example.com` }, createOnly: true }, ip(), T(9));
  return 'group' in r && r.group ? r.group.id : 0;
};
const send = (g: number, rows: [string, number][], at: Date) =>
  groupSubmit(db, { groupId: g, device: 'd', reporter: '志工', buyDate: '2026-11-13', rows: rows.map(([orderNo, qty]) => ({ orderNo, qty })) }, ip(), at);

beforeEach(async () => {
  db = await createPgliteDb();
  await seedVenue(db);
  await createEvent(db, { name: '古儒吉大師課程', showAt: new Date('2026-12-09T19:30:00+08:00'), bankName: 'b', bankAccount: '1', accountName: 'c' });
  await ensureFloor3(db);
  await setJoinSettings(db, '網管', { open: true, reportOpen: true, perSeat: 6 });
});

describe('揪團即時看板', () => {
  it('回報動態：一次送出一行、最新置頂、累計張數、取得號碼；找我的群；看更多', async () => {
    const a = await mk('台北大安1', '0912000001');
    const b = await mk('新竹竹北', '0922000002');
    await uploadEra(db, '網管', [{ orderNo: 'ER2611130000001', qty: 4, status: 'sold' }, { orderNo: 'ER2611130000002', qty: 2, status: 'sold' }, { orderNo: 'ER2611130000003', qty: 12, status: 'sold' }]);
    await send(a, [['0001', 4]], T(10));
    await send(b, [['0003', 12]], T(10, 30));
    await send(a, [['0002', 2], ['0099', 3]], T(11));
    const d = await boardData(db, {}, T(12));
    expect(d.feed.map((x) => [x.group, x.qty, x.ok, x.pending, x.total, x.nos])).toEqual([
      ['台北大安1', 5, 2, 3, 9, [3]],
      ['新竹竹北', 12, 12, 0, 12, [1, 2]],
      ['台北大安1', 4, 4, 0, 4, []],
    ]);
    expect(d.stats).toMatchObject({ groups: 2, verified: 18, pending: 3, slots: 3 });
    expect(d.order.map((x) => [x.no, x.group, x.status])).toEqual([[1, '新竹竹北', 'provisional'], [2, '新竹竹北', 'provisional'], [3, '台北大安1', 'provisional']]);
    expect((await boardData(db, { q: '大安' }, T(12))).feed).toHaveLength(2);
    expect((await boardData(db, { before: d.feed[0].at }, T(12))).feed).toHaveLength(2);
    // 不含個資
    expect(JSON.stringify(d)).not.toMatch(/0912000001|負責人|example\.com|ER26/);
    expect(d.seats).toBeUndefined();
  });

  it('劃位現況：鎖定後顯示正在選位、接下來、剛選好的座位與座位圖', async () => {
    const a = await mk('台北大安1', '0912000001');
    await uploadEra(db, '網管', [{ orderNo: 'ER2611130000001', qty: 12, status: 'sold' }]);
    await send(a, [['0001', 12]], T(10));
    const seats = await db.select({ id: t.venueSeat.id }).from(t.venueSeat).where(eq(t.venueSeat.floor, '3F')).orderBy(t.venueSeat.y, t.venueSeat.x);
    await paintFloor3(db, '網管', 'gift', seats.slice(0, 4).map((s) => s.id));
    await lockSlots(db, '網管', T(12));
    await setJoinSettings(db, '網管', { pickOpen: true });
    const T2 = new Date('2026-11-20T10:00:00+08:00');
    await tickQueue(db, '', T2);
    let d = await boardData(db, { tab: 'live' }, T2);
    expect(d.live.current).toMatchObject({ nos: [1, 2], group: '台北大安1' });
    expect(d.seats?.filter((x) => x.status === 'free')).toHaveLength(4);
    const [reg] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, a));
    await submitPick(db, reg.pickCode!, { seatIds: [seats[0].id, seats[1].id], repName: '王', repPhone: '0912345678' }, T2);
    d = await boardData(db, { tab: 'live' }, T2);
    expect(d.live.recent).toHaveLength(2);
    expect(d.live.done).toBe(2);
    expect(d.order.every((x) => x.status === 'done' && x.seat)).toBe(true);
    expect(d.stats.giftFree).toBe(2);
    expect(d.feed[0].nos).toEqual([1, 2]);
  });
});
