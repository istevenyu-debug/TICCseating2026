/** 器材位：保留：攝影、不開放（設備/視線），或用途名稱有「攝影／器材／設備」（2026-11-28：VIP／公益不能安排） */
export const isGearUsage = (u: { code: string; name: string }) => ['hold-photo', 'closed'].includes(u.code) || /攝影|器材|設備/.test(u.name);
