# 大會堂前區劃位系統

台北國際會議中心大會堂第 1–12 排的劃位系統，供主辦方自用。消費者透過專屬連結選位並以銀行匯款付款，主辦方人工確認到帳，之後印製實名紙本入場券。

需求依據：《大會堂前區劃位系統 需求規格書（MVP）》。

## 開發進度

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| 第一段 | 座位模板、資料庫、購票端選位、20 分鐘暫存、實名與匯款資料送出、逾時釋放 | 完成 |
| 第二段 | 後台：登入權限、席位用途、票區定價、組合票、開放設定、專屬連結、確認到帳、簡訊與 Email 發送、手機驗證碼 | 未開始 |
| 第三段 | 紙本入場券 PDF、QR 驗票頁、上線部署 | 未開始 |

## 技術架構

- Next.js 14（App Router、TypeScript）：購票端、後台、API 同一個專案
- PostgreSQL + Drizzle ORM
  - 正式環境：設定 `DATABASE_URL` 連線 PostgreSQL
  - 本機開發與測試：未設定時自動使用 PGlite（WASM 版 PostgreSQL），資料存放在 `.data/pglite`
- 啟動時自動執行 `drizzle/` 內的資料庫 migration

## 本機執行

```bash
npm install
npm run db:seed     # 建立示範場次與測試連結 DEMO26、DEMO27
npm run dev         # http://localhost:3000/t/DEMO26
npm test            # 執行訂位流程測試
```

## 目錄

```
src/lib/layout.ts      座位模板（第 1–12 排、VIP 排、側區、輪椅席的座號與座標）
src/lib/booking.ts     訂位核心：查詢、暫存、放棄、送出、逾時釋放
src/lib/pricing.ts     組合票規則與計價（前後端共用）
src/lib/validation.ts  送出資料的欄位驗證
src/db/schema.ts       資料表結構
src/db/seed.ts         建立場次、連結、保留席的函式
src/app/t/[code]/      購票端頁面
src/app/api/t/[code]/  購票端 API：state、hold、release、submit
tests/                 訂位流程測試
```

## 重要規則

- **防止一位兩賣**：暫存時以「只在座位仍為 free 才更新」的條件式 UPDATE 搶位。實際搶到的座位數少於要求數量時，整筆交易回滾。測試 `兩人同時搶同一座位，只有一人成功` 驗證這點。
- **兩段保留時間**：選位暫存（預設 20 分鐘），送出資料後等待對帳（預設 48 小時）。逾時由每次請求觸發清理；第二段會加上每分鐘的排程。
- **張數上限**：每筆訂單上限，以及每個連結跨訂單累計的可購張數。

## 上線前待辦

- 側區每排座位數與輪椅席位置：目前依示意圖判讀，須與台北國際會議中心的正式座位清冊核對（`src/lib/layout.ts`）
- 連結開啟時的手機驗證碼（第二段）
- 簡訊與 Email 服務商串接（第二段；目前通知只寫入 `notification` 資料表）
