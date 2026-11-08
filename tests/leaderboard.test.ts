import { expect, it } from 'vitest';
import { leaderboard } from '@/lib/leaderboard';

const o = (name: string, qty: number, extra: Partial<{ status: string; paidOkAt: string | null; seq: number; id: number }> = {}) => ({
  name, status: extra.status ?? 'confirmed', paidOkAt: extra.paidOkAt === undefined ? '2026-11-01' : extra.paidOkAt, seq: extra.seq ?? 1,
  items: [{ kind: 'combo', id: extra.id ?? 7, qty }],
});

it('依組數排名；同組數筆數少的在前；同名合併；只算已匯款與選定方案', () => {
  const rows = leaderboard([
    o('王大明', 1, { seq: 3 }), o('王 大明', 1, { seq: 9 }), // 2 組、2 筆
    o('陳小華', 2, { seq: 5 }), // 2 組、1 筆 → 排在王大明前面
    o('林一', 1, { seq: 1 }), o('張三', 1, { seq: 2 }), // 1 組、1 筆，同名次，先登記的在前
    o('未匯款', 5, { paidOkAt: null }), o('已取消', 5, { status: 'cancelled' }), o('別的方案', 5, { id: 8 }),
  ], [7]);
  expect(rows).toEqual([
    { rank: 1, name: '陳小華', sets: 2, orders: 1 },
    { rank: 2, name: '王大明', sets: 2, orders: 2 },
    { rank: 3, name: '林一', sets: 1, orders: 1 },
    { rank: 3, name: '張三', sets: 1, orders: 1 },
  ]);
  expect(leaderboard([o('未匯款', 5, { paidOkAt: null })], [7], false)).toEqual([{ rank: 1, name: '未匯款', sets: 5, orders: 1 }]);
});
