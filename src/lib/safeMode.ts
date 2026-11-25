/**
 * 測試機保護（SAFE_MODE）：雲端複本、還原測試時在 .env.local 加一行 SAFE_MODE=1。
 * - 不寄 Email（SAFE_MODE_ALLOW 列出的信箱除外，用逗號分開）、不發簡訊、不推播
 * - 不連正式綠界：電子發票、刷卡的正式環境一律擋下（模擬模式、綠界測試環境照常）
 * - 啟動程式不接正式通道（就算 .env.local 有 TUNNEL_TOKEN 也改用臨時網址）
 * - 後台、驗票頁顯示紅色「測試機」橫幅
 * 被擋的通知會標成失敗並寫明原因，不會算成已寄出。
 */
export const isSafeMode = () => process.env.SAFE_MODE === '1';

const allowList = () => (process.env.SAFE_MODE_ALLOW ?? '').split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const WHAT = { email: '寄 Email', sms: '發簡訊', push: '推播', einv: '連正式綠界開發票', card: '接受正式刷卡' } as const;

/** 測試機時擋下對外動作；Email 收件人在允許清單內才放行 */
export function safeBlock(kind: keyof typeof WHAT, to = '') {
  if (!isSafeMode()) return;
  if (kind === 'email' && to && allowList().includes(to.trim().toLowerCase())) return;
  throw new Error(`測試機（SAFE_MODE）不${WHAT[kind]}${kind === 'email' ? '：只寄給 SAFE_MODE_ALLOW 列出的信箱' : ''}`);
}
