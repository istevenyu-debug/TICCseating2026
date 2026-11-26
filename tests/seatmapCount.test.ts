import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { countSeatmap } from '@/lib/seatmapCount';

/** 2026-11-26 使用者傳的年代座位圖截圖（4F、5F，最上面還多 3 排 3F），轉成 RGBA */
const W = 1023, H = 393;
const img = new Uint8Array(gunzipSync(readFileSync(`${__dirname}/fixtures/era-seatmap-4f5f-1023x393.rgba.gz`)));

describe('年代座位圖計數', () => {
  it('實際截圖：4F 748 席已售 602、5F 686 席已售 239（多拍到的 3F 排自動排除）', () => {
    const r = countSeatmap(img, W, H);
    expect(r).toMatchObject({ ok: true, floors: [{ key: '4F', total: 748, sold: 602 }, { key: '5F', total: 686, sold: 239 }] });
  });
  it('手機高解析度截圖（放大 2 倍）結果一樣', () => {
    const W2 = W * 2, H2 = H * 2, big = new Uint8Array(W2 * H2 * 4);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
      const si = ((y >> 1) * W + (x >> 1)) * 4, di = (y * W2 + x) * 4;
      big[di] = img[si]; big[di + 1] = img[si + 1]; big[di + 2] = img[si + 2]; big[di + 3] = 255;
    }
    expect(countSeatmap(big, W2, H2)).toMatchObject({ ok: true, floors: [{ key: '4F', sold: 602 }, { key: '5F', sold: 239 }] });
  });
  it('總席數不對（例如年代改了可賣席數、或截圖切掉一排）就不接受', () => {
    expect(countSeatmap(img, W, H, [{ key: '4F', total: 740 }, { key: '5F', total: 686 }])).toMatchObject({ ok: false });
    // 把最下面 30 像素塗白（切掉 5F 最後幾排）
    const cut = img.slice();
    cut.fill(255, (H - 30) * W * 4);
    expect(countSeatmap(cut, W, H)).toMatchObject({ ok: false });
  });
  it('不是座位圖', () => {
    const blank = new Uint8Array(W * H * 4).fill(255);
    expect(countSeatmap(blank, W, H)).toMatchObject({ ok: false });
  });
});

describe('存座位圖計數（後台）', () => {
  it('對得上總席數才存；銷售總覽 4F／5F 改用最近一次；可刪掉最近一次', async () => {
    const { createPgliteDb } = await import('@/db/client');
    const { createEvent, seedVenue } = await import('@/db/seed');
    const { addSeatmap, salesOverview, undoSeatmap } = await import('@/lib/sales');
    const db = await createPgliteDb();
    await seedVenue(db);
    await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00') });
    const now = new Date('2026-11-26T10:00:00+08:00');
    const floors = [{ key: '4F', total: 748, sold: 602 }, { key: '5F', total: 686, sold: 239 }];
    await expect(addSeatmap(db, 'admin', { statAt: '2026-11-26T01:33:00.000Z', floors: [{ key: '4F', total: 740, sold: 600 }, floors[1]] }, now)).rejects.toThrow(/對不上/);
    await expect(addSeatmap(db, 'admin', { statAt: '2026-11-27T01:33:00.000Z', floors }, now)).rejects.toThrow(/未來/);
    await addSeatmap(db, 'admin', { statAt: '2026-11-26T01:33:00.000Z', floors, thumb: 'data:image/jpeg;base64,AAAA' }, now);
    const s = (await salesOverview(db, now))!;
    expect(s.hall.find((h) => h.key === '4F')).toMatchObject({ by: '年代', total: 748, sold: 602, left: 146 });
    expect(s.hall.find((h) => h.key === '5F')).toMatchObject({ sold: 239, left: 447 });
    expect(s.hall.find((h) => h.key === '4F')!.note).toMatch(/座位圖 11\/26.*09:33/);
    expect(s.seatmaps[0].thumb).toBeTruthy();
    await undoSeatmap(db, 'admin');
    const s2 = (await salesOverview(db, now))!;
    expect(s2.hall.find((h) => h.key === '4F')).toMatchObject({ by: '年代', sold: 0 });
  });
});

describe('銷售總覽：不列入的方案', () => {
  it('按「不列入」後方案列不顯示、可恢復', async () => {
    const { createPgliteDb } = await import('@/db/client');
    const { createEvent, seedVenue, createLink } = await import('@/db/seed');
    const A = await import('@/lib/admin');
    const { salesOverview, setPlanHidden } = await import('@/lib/sales');
    const db = await createPgliteDb();
    await seedVenue(db);
    const ev = await createEvent(db, { name: '測試', showAt: new Date('2026-12-09T19:30:00+08:00') });
    await createLink(db, { eventId: ev.id, code: 'AAA111', name: '甲', phone: '0911111111', quota: 0, expiresAt: new Date('2026-12-09T23:59:59+08:00') });
    await A.publish(db, 'admin');
    const s1 = (await salesOverview(db))!;
    expect(s1.twoM.plans.length).toBeGreaterThan(0);
    const p = s1.twoM.plans[0];
    await setPlanHidden(db, 'admin', p.id, true);
    const s2 = (await salesOverview(db))!;
    expect(s2.twoM.plans.find((x) => x.id === p.id)).toBeUndefined();
    expect(s2.hiddenPlans).toEqual([{ id: p.id, name: p.name }]);
    expect(s2.hall.find((h) => h.key === '2M')).toEqual(s1.hall.find((h) => h.key === '2M'));
    await setPlanHidden(db, 'admin', p.id, false);
    expect((await salesOverview(db))!.twoM.plans.find((x) => x.id === p.id)).toBeTruthy();
  });
});
