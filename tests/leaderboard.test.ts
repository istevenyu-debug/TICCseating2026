import { expect, it } from 'vitest';
import { leaderboard } from '@/lib/leaderboard';

const o = (name: string, qty: number, extra: Partial<{ status: string; paidOkAt: string | null; seq: number; id: number }> = {}) => ({
  name, status: extra.status ?? 'confirmed', paidOkAt: extra.paidOkAt === undefined ? '2026-11-01' : extra.paidOkAt, seq: extra.seq ?? 1,
  items: [{ kind: 'combo', id: extra.id ?? 7, qty }],
});

it('依組數排名；同名合併；同組數同名次；只算已匯款與選定方案', () => {
  const rows = leaderboard([
    o('王大明', 1, { seq: 3 }), o('王 大明', 1, { seq: 9 }),
    o('陳小華', 2, { seq: 5 }), o('林一', 1, { seq: 1 }),
    o('未匯款', 5, { paidOkAt: null }), o('已取消', 5, { status: 'cancelled' }), o('別的方案', 5, { id: 8 }),
  ], [7]);
  expect(rows).toEqual([
    { rank: 1, name: '王大明', sets: 2 },
    { rank: 1, name: '陳小華', sets: 2 },
    { rank: 3, name: '林一', sets: 1 },
  ]);
  expect(leaderboard([o('未匯款', 5, { paidOkAt: null })], [7], false)).toEqual([{ rank: 1, name: '未匯款', sets: 5 }]);
});
