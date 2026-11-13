import { describe, expect, it } from 'vitest';
import { eraRows, guessCols, orderBase, parsePrices, soldAtOf } from '@/lib/eraParse';
import { normOrderNo } from '@/lib/joinQueue';

// 年代「售出明細」UTK6120 的格式：一列一張票，最後有小計、合計列
const H = ['售出日期', '演出時間', '場地名稱', '票點名稱', '售出時間', '售出人員', '區樓', '排', '號', '訂單編號', '原價', '售價', '票種'];
const tk = (no: string, floor: string, row: string, seat: string, price = '3000') => ['11/12/26', '12/9/26', '台北國際會議中心大會堂', '40253_x', '11:36', '40253', floor, row, seat, no, '3000', price, price === '3000' ? '原價' : '折扣'];
const G = [
  H,
  tk('ER2611120000108-1', '3樓', '13排', '33號'),
  ...[1, 2, 3, 4, 5, 6].map((i) => tk(`ER2611120000109-${i}`, '3樓', '13排', `${19 + i * 2}號`)),
  tk('ER2611120000110-1', '3樓', '9排', '5號'),
  tk('ER2611120000110-2', '3樓', '14排', '5號'),
  tk('ER2611120000111-1', '2樓', '15排', '1號'),
  ['(場次)小計', '', '', '', '', '', '10 張', '', '', '', '', '30,000 元', ''],
  ['合計', '', '', '', '', '', '10 張', '', '', '', '', '30,000 元', ''],
];

describe('年代名單解析', () => {
  it('一列一張票：自動找欄位、同訂單合計、略過小計，只算銀區（3 樓 13–27 排）', () => {
    const c = guessCols(G);
    expect(c).toMatchObject({ head: 0, no: 9, qty: -1, status: -1, floor: 6, row: 7, date: 0, time: 4, price: 11 });
    const r = eraRows(G, c, true);
    const at = '2026-11-12T11:36:00+08:00';
    expect(r.rows).toEqual([
      { orderNo: 'ER2611120000108', qty: 1, status: 'sold', soldAt: at, otherQty: 0, otherNote: '' },
      { orderNo: 'ER2611120000109', qty: 6, status: 'sold', soldAt: at, otherQty: 0, otherNote: '' },
      { orderNo: 'ER2611120000110', qty: 1, status: 'sold', soldAt: at, otherQty: 1, otherNote: '3樓9排 1 張' }, // 混買：銀區 1、前排 1
      { orderNo: 'ER2611120000111', qty: 0, status: 'sold', soldAt: at, otherQty: 1, otherNote: '2樓 1 張' }, // 整筆非銀區：保留，回報時才能說明原因
    ]);
    expect(r).toMatchObject({ tickets: 8, outside: 2, outsideNote: '3樓9排 1 張、2樓 1 張', perTicket: true });
    expect(eraRows(G, c, false).tickets).toBe(10);
  });

  it('一列一筆訂單（有張數、狀態欄）照舊', () => {
    const g = [['訂單編號', '張數', '狀態'], ['T1001', '4', '已售'], ['T1002', '2', '已退']];
    const r = eraRows(g, guessCols(g), true);
    expect(r.rows).toEqual([{ orderNo: 'T1001', qty: 4, status: 'sold', soldAt: null, otherQty: 0, otherNote: '' }, { orderNo: 'T1002', qty: 2, status: 'refunded', soldAt: null, otherQty: 0, otherNote: '' }]);
  });

  it('售價：只算 3000、2550（八五折）；其他票價、4 樓不計，記下原因', () => {
    const g = [H,
      tk('ER2611130000011-1', '3樓', '15排', '1號', '2550'), tk('ER2611130000011-2', '3樓', '15排', '2號', '3000'), tk('ER2611130000011-3', '3樓', '15排', '3號', '1000'),
      tk('ER2611130000012-1', '4樓', '3排', '1號', '1000'), tk('ER2611130000012-2', '4樓', '3排', '2號', '1000'),
      tk('ER2611130000013-1', '3樓', '20排', '9號', '2700'),
    ];
    const r = eraRows(g, guessCols(g), true, parsePrices('3000, 2550'));
    expect(r.rows.map((x) => [x.orderNo, x.qty, x.otherQty, x.otherNote])).toEqual([
      ['ER2611130000011', 2, 1, '售價 1000 1 張'], ['ER2611130000012', 0, 2, '4樓 2 張'], ['ER2611130000013', 0, 1, '售價 2700 1 張'],
    ]);
    expect(r).toMatchObject({ tickets: 2, outside: 4, outsideNote: '售價 1000 1 張、4樓 2 張、售價 2700 1 張' });
    expect(parsePrices('3000，2550、3000')).toEqual([3000, 2550]);
    expect(r.list.map((x) => [x.ticketNo, x.floor, x.row, x.seat, x.price])).toEqual([
      ['ER2611130000011-1', '3樓', '15排', '1號', 2550], ['ER2611130000011-2', '3樓', '15排', '2號', 3000], ['ER2611130000011-3', '3樓', '15排', '3號', 1000],
      ['ER2611130000012-1', '4樓', '3排', '1號', 1000], ['ER2611130000012-2', '4樓', '3排', '2號', 1000], ['ER2611130000013-1', '3樓', '20排', '9號', 2700],
    ]);
  });

  it('售出時間：月/日/年 或 年/月/日，台北時間', () => {
    expect(soldAtOf('11/12/26', '11:36')).toBe('2026-11-12T11:36:00+08:00');
    expect(soldAtOf('2026/11/3', '9:05')).toBe('2026-11-03T09:05:00+08:00');
    expect(soldAtOf('2026-11-03 09:05', '')).toBe('2026-11-03T09:05:00+08:00');
    expect(soldAtOf('', '9:05')).toBeNull();
  });

  it('志工輸入票號（含 -1）也對得到訂單', () => {
    expect(orderBase('er2611120000109-3')).toBe('ER2611120000109');
    expect(normOrderNo(' ＥＲ2611120000109－1 ')).toBe('ER2611120000109');
    expect(normOrderNo('T260009')).toBe('T260009');
  });
});
