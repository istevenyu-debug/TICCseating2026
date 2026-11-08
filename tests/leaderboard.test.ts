import { expect, it } from 'vitest';
import { leaderboard } from '@/lib/leaderboard';

const o = (name: string, qty: number, extra: Partial<{ status: string; paidOkAt: string | null; seq: number; id: number }> = {}) => ({
  name, status: extra.status ?? 'confirmed', paidOkAt: extra.paidOkAt === undefined ? '2026-11-01' : extra.paidOkAt, seq: extra.seq ?? 1,
  items: [{ kind: 'combo', id: extra.id ?? 7, qty }],
});

it('依組數排名；同組數依姓名筆劃由少到多、同名次；同名合併；只算已匯款與選定方案', () => {
  const rows = leaderboard([
    o('陳小華', 2, { seq: 1 }), // 陳 11 劃
    o('王大明', 1, { seq: 3 }), o('王 大明', 1, { seq: 9 }), // 王 4 劃，合併成 2 組
    o('林一', 1, { seq: 1 }), o('丁二', 1, { seq: 2 }), o('歐陽娜', 1, { seq: 0 }), // 丁 2、林 8、歐 15
    o('未匯款', 5, { paidOkAt: null }), o('已取消', 5, { status: 'cancelled' }), o('別的方案', 5, { id: 8 }),
  ], [7]);
  expect(rows.map((r) => [r.rank, r.name, r.sets])).toEqual([
    [1, '王大明', 2], [1, '陳小華', 2],
    [3, '丁二', 1], [3, '林一', 1], [3, '歐陽娜', 1],
  ]);
  expect(leaderboard([o('未匯款', 5, { paidOkAt: null })], [7], false).map((r) => r.name)).toEqual(['未匯款']);
});
