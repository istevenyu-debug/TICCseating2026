/**
 * 資料表結構，對應規格書第 10 節。
 * 金額一律為整數新台幣；時間一律 timestamptz。
 */
import {
  pgTable, serial, integer, text, boolean, timestamp, primaryKey, uniqueIndex, index, jsonb, doublePrecision,
} from 'drizzle-orm/pg-core';

/** 發布到購票頁的開放設定快照：後台勾選後按「發布」才寫入，購票端只看這份 */
export interface Published {
  open: boolean;
  zoneIds: number[];
  comboIds: number[];
  at: string; // ISO 時間
}

/** 場館座位模板（與場次無關，固定不變） */
export const venueSeat = pgTable('venue_seat', {
  id: text('id').primaryKey(), // 例：'3-15'、'V-7'、'W-H11'
  section: text('section').notNull(), // WL 左側區 / L 左區 / C 中區 / R 右區 / WR 右側區 / VL VC VR VIP排 / W 輪椅席
  rowNo: integer('row_no'), // 1–12；VIP 排為 0；輪椅席為 null
  seatNo: text('seat_no').notNull(), // 座號（輪椅席為 H1–H16）
  seatType: text('seat_type').notNull(), // normal / vip / wheelchair
  block: text('block').notNull(), // L2 左側區 / L1 左區 / C0 中區 / R1 右區 / R2 右側區
  code: text('code').notNull(), // 座位編號：排-席次-區，例 03-15-L1、V-07-C0、WC-H11-L2
  x: integer('x').notNull(), // 實體座標：欄
  y: integer('y').notNull(), // 實體座標：列
  entrance: text('entrance').notNull().default('2M 入口'),
  floor: text('floor').notNull().default('2M'), // 樓層：2M（第 1–12 排）／3F（第 13–27 排）
});

/** 場次 */
export const event = pgTable('event', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  showAt: timestamp('show_at', { withTimezone: true }).notNull(),
  vipInstalled: boolean('vip_installed').notNull().default(false),
  saleOpen: boolean('sale_open').notNull().default(false),
  saleStart: timestamp('sale_start', { withTimezone: true }),
  saleEnd: timestamp('sale_end', { withTimezone: true }),
  maxPerOrder: integer('max_per_order').notNull().default(21),
  holdMinutes: integer('hold_minutes').notNull().default(1440), // 新流程：選位暫存 24 小時，買方看不到倒數
  payHours: integer('pay_hours').notNull().default(48),
  preorderOpen: boolean('preorder_open').notNull().default(false), // 公開預購頁是否開放
  payFirst: boolean('pay_first').notNull().default(true), // 先匯款再給連結：購票頁不填匯款資料、不逾期取消
  bankName: text('bank_name').notNull().default(''),
  bankAccount: text('bank_account').notNull().default(''),
  accountName: text('account_name').notNull().default(''),
  published: jsonb('published').$type<Published>(),
  publicSaleStart: timestamp('public_sale_start', { withTimezone: true }), // 公開連結開始時間；未設定時同 saleStart
  publicPerPhone: integer('public_per_phone').notNull().default(0), // 公開連結每支手機上限，0 = 不限
  invTaxType: text('inv_tax_type').notNull().default('1'), // 發票課稅別：1 應稅、3 免稅
  giftShow: jsonb('gift_show').$type<{ buy?: boolean; invoice?: boolean }>().notNull().default({}), // 贈品給買方看的位置；預設都不顯示（驚喜）
  invItemName: text('inv_item_name').notNull().default('入場券'), // 發票品名（前面會加演出名稱）
  vipNotifyDays: integer('vip_notify_days').notNull().default(3), // 招待：演出前幾天寄出劃位資料
});

/** 票種（票區）：名稱、票價、座位底色由主辦方自訂；open 為後台勾選的開放狀態（發布後生效） */
export const priceZone = pgTable('price_zone', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  name: text('name').notNull().default(''),
  color: text('color').notNull(), // #rrggbb
  price: integer('price').notNull().default(0),
  open: boolean('open').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  floor: text('floor').notNull().default('2M'), // 票種屬於哪一層，不能跨層使用
});

/** 席位用途類別 */
export const seatUsage = pgTable('seat_usage', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  sellable: boolean('sellable').notNull(),
});

/** 場次庫存：每個場次每個座位一列。status：free / held / pending / sold */
export const eventSeat = pgTable('event_seat', {
  eventId: integer('event_id').notNull().references(() => event.id),
  seatId: text('seat_id').notNull().references(() => venueSeat.id),
  zoneId: integer('zone_id').notNull().references(() => priceZone.id),
  usageId: integer('usage_id').notNull().references(() => seatUsage.id),
  status: text('status').notNull().default('free'),
  orderId: integer('order_id'),
  holdUntil: timestamp('hold_until', { withTimezone: true }),
  version: integer('version').notNull().default(0),
  bundle: text('bundle'), // 連座：同一個值的座位必須整組一起訂（例：贈票區左右兩位一組）
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.seatId] }),
  byOrder: index('event_seat_order_idx').on(t.orderId),
}));

/** 購票方式：單張購票（isSingle）或組合票。組合票內容見 combo_item，價格為套票價 */
export const combo = pgTable('combo', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  name: text('name').notNull().default(''),
  isSingle: boolean('is_single').notNull().default(false),
  price: integer('price').notNull().default(0), // 套票價；單張購票不使用
  limitSets: integer('limit_sets').notNull().default(0), // 0 = 不限量
  active: boolean('active').notNull().default(true), // 後台勾選的開放狀態（發布後生效）
  sort: integer('sort').notNull().default(0),
  autoHolders: boolean('auto_holders').notNull().default(false), // 持票人自動編號：本名、本名02…；證末4碼+01、02…
  description: text('description').notNull().default(''), // 預購單上的「方案內容」說明；空白則自動產生
  floor: text('floor').notNull().default('2M'), // 購票方式屬於哪一層，不能跨層使用
  hidden: boolean('hidden').notNull().default(false),
  gifts: jsonb('gifts').$type<{ giftId: number; qty: number }[]>().notNull().default([]), // 每份送的贈品（不是座位） // 隱藏方案：公開認購頁與其他買方看不到，只有登入後台的人員能代填
});

/** 組合票內容：哪個票種、幾張。例：買一A送二B = (A,1) + (B,2) */
export const comboItem = pgTable('combo_item', {
  comboId: integer('combo_id').notNull().references(() => combo.id, { onDelete: 'cascade' }),
  zoneId: integer('zone_id').notNull().references(() => priceZone.id),
  qty: integer('qty').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.comboId, t.zoneId] }) }));

/** 贈品項目（每場活動自己的清單；之後接庫存就在這裡加欄位） */
export const giftItem = pgTable('gift_item', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default(''),
  unit: text('unit').notNull().default('個'),
  sort: integer('sort').notNull().default(0),
});

/** 專屬購票連結 */
export const inviteLink = pgTable('invite_link', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  quota: integer('quota').notNull(), // 專屬連結可購張數，0 = 不限
  note: text('note').notNull().default(''), // 來帳備註（例：末五碼、金額），主辦方對帳用
  referrer: text('referrer').notNull().default(''), // 招待的推薦人（「無」＝沒有推薦人）
  kind: text('kind').notNull().default('personal'), // personal 專屬連結 / public 公開連結
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'), // active / disabled
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  floor: text('floor').notNull().default('2M'), // 連結綁樓層：只看得到、選得到這一層
}, (t) => ({ code: uniqueIndex('invite_link_code_idx').on(t.code) }));

/** 訂單。status：held / pending / paid / cancelled / expired */
export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  orderNo: text('order_no'),
  eventId: integer('event_id').notNull().references(() => event.id),
  linkId: integer('link_id').notNull().references(() => inviteLink.id),
  comboId: integer('combo_id').notNull().references(() => combo.id),
  sets: integer('sets').notNull().default(1), // 組合票買了幾組
  status: text('status').notNull(),
  amount: integer('amount').notNull(),
  buyerName: text('buyer_name'),
  buyerPhone: text('buyer_phone'),
  buyerEmail: text('buyer_email'),
  holdUntil: timestamp('hold_until', { withTimezone: true }),
  payDueAt: timestamp('pay_due_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  closedReason: text('closed_reason'),
  seenAt: timestamp('seen_at', { withTimezone: true }), // 後台已看過（新訂單提示用）
  visitorId: text('visitor_id'), // 公開連結：區分同一連結的不同訪客（瀏覽器）
  vip: boolean('vip').notNull().default(false), // 招待（未付費，由主管安排）
  notifyMode: text('notify_mode').notNull().default(''), // 招待寄送方式：scheduled 演出前自動寄／now 已立即寄／none 不寄（紙本）
}, (t) => ({
  orderNo: uniqueIndex('orders_order_no_idx').on(t.orderNo),
  byLink: index('orders_link_idx').on(t.linkId),
}));

/** 訂單座位與實名 */
export const orderSeat = pgTable('order_seat', {
  orderId: integer('order_id').notNull().references(() => orders.id),
  seatId: text('seat_id').notNull().references(() => venueSeat.id),
  unitPrice: integer('unit_price').notNull(),
  holderName: text('holder_name'),
  holderId4: text('holder_id4'),
}, (t) => ({ pk: primaryKey({ columns: [t.orderId, t.seatId] }) }));

/** 匯款回報與到帳確認 */
export const payment = pgTable('payment', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  reportedLast5: text('reported_last5').notNull(),
  reportedAmount: integer('reported_amount').notNull(),
  reportedAt: text('reported_at').notNull(),
  confirmedDate: text('confirmed_date'),
  confirmedAmount: integer('confirmed_amount'),
  confirmedBy: text('confirmed_by'),
  note: text('note'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (t) => ({ byOrder: uniqueIndex('payment_order_idx').on(t.orderId) }));

/** 通知紀錄（實際發送由第二段串接簡訊與 Email 服務商） */
export const notification = pgTable('notification', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id'),
  linkId: integer('link_id'),
  channel: text('channel').notNull(), // sms / email
  template: text('template').notNull(),
  recipient: text('recipient').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('queued'), // queued 待寄 / sent 已寄出 / failed 失敗 / simulated 未設定寄送（只存紀錄）
  error: text('error'), // 失敗原因
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  sendAfter: timestamp('send_after', { withTimezone: true }), // 排程：這個時間以後才寄（招待演出前寄出）
});

/** 預購單：公開預購頁送出（選購內容＋匯款資料），後台確認收訖後自動建立專屬劃位連結並寄 Email */
export interface PreorderItem { kind: 'combo' | 'zone'; id: number; name: string; price: number; qty: number }
export const preorder = pgTable('preorder', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  no: text('no').notNull(),
  items: jsonb('items').$type<PreorderItem[]>().notNull(),
  amount: integer('amount').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  paidAmount: integer('paid_amount').notNull(),
  last5: text('last5').notNull(),
  status: text('status').notNull().default('submitted'), // submitted 待確認 / confirmed 已收訖 / cancelled 已取消
  linkId: integer('link_id').references(() => inviteLink.id),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedBy: text('confirmed_by'),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  viewToken: text('view_token'), // 訂購人裝置用來查進度、收推播的隨機碼
  source: text('source').notNull().default('web'), // web 本站預購頁／form Google 表單
  formId: text('form_id'), // Google 表單回覆編號（避免重複匯入）
  answers: jsonb('answers').$type<{ q: string; a: string }[]>().notNull().default([]), // Google 表單原始回答
  lineName: text('line_name').notNull().default(''),
  waitlist: boolean('waitlist').notNull().default(false), // 候補（名額已滿時登記）；老大按「轉正取」才排進依序劃位 // 買方自填的 LINE 顯示名稱（選填）
  // 老大核對：已匯款、已入 LINE 群（群名清單）；勾了不會寄任何東西
  paidOkAt: timestamp('paid_ok_at', { withTimezone: true }),
  paidOkBy: text('paid_ok_by'),
  lineOk: jsonb('line_ok').$type<string[]>().notNull().default([]),
  // 已發出劃位的項目（'combo:3'、'zone:5'）。null＝舊資料，全部可劃
  released: jsonb('released').$type<string[]>(),
  // 電子發票開立方式：member 綠界會員載具（Email）／mobile 手機條碼／cert 自然人憑證／donate 捐贈／company 公司統編
  invType: text('inv_type').notNull().default('member'),
  invCode: text('inv_code').notNull().default(''), // 手機條碼、憑證號碼、愛心碼或統編
  invTitle: text('inv_title').notNull().default(''), // 公司抬頭
}, (t) => ({ no: uniqueIndex('preorder_no_idx').on(t.no), viewToken: uniqueIndex('preorder_view_token_idx').on(t.viewToken), formId: uniqueIndex('preorder_form_id_idx').on(t.formId) }));

/** 驗票門口：每個門一條驗票連結（token），工作人員用手機打開即可掃描，可停用 */
export const gate = pgTable('gate', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  name: text('name').notNull(),
  token: text('token').notNull(),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ token: uniqueIndex('gate_token_idx').on(t.token) }));

/** 入場紀錄：每張票（序號）只能一筆 */
export const checkin = pgTable('checkin', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  serial: text('serial').notNull(),
  orderId: integer('order_id').notNull(),
  seatId: text('seat_id').notNull(),
  gateId: integer('gate_id'),
  manual: boolean('manual').notNull().default(false), // 手動輸入序號或搜尋入場（非掃描）
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ serial: uniqueIndex('checkin_serial_idx').on(t.eventId, t.serial) }));

/** 手機推播訂閱：消費者在購票頁按「開啟通知」後建立 */
export const pushSub = pgTable('push_sub', {
  id: serial('id').primaryKey(),
  linkId: integer('link_id').references(() => inviteLink.id, { onDelete: 'cascade' }),
  preorderId: integer('preorder_id').references(() => preorder.id, { onDelete: 'cascade' }), // 預購單送出後、尚未收款時訂閱的
  visitorId: text('visitor_id'), // 公開連結：哪一位訪客
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ endpoint: uniqueIndex('push_sub_endpoint_idx').on(t.endpoint) }));

/** 系統設定（通知寄送帳號等）。密碼類只寫不讀，不回傳到後台畫面 */
export const appSetting = pgTable('app_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
});

/** 操作紀錄 */
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  actor: text('actor').notNull(), // 'system'、'link:<code>' 或後台帳號
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: text('detail'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

/** 後台帳號 */
export const adminUser = pgTable('admin_user', {
  id: serial('id').primaryKey(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(), // scrypt
  displayName: text('display_name').notNull().default(''),
  role: text('role').notNull().default('admin'), // admin / staff
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ username: uniqueIndex('admin_user_username_idx').on(t.username) }));

/** 電子發票（綠界）：一筆訂單（收款）一張。status：pending 待開／issued 已開立／failed 開立失敗／void 已作廢 */
export const invoice = pgTable('invoice', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').references(() => orders.id, { onDelete: 'set null' }),
  orderNo: text('order_no').notNull(),
  env: text('env').notNull(), // test 測試環境 / prod 正式
  relateNumber: text('relate_number').notNull(),
  status: text('status').notNull(), // issued 已開立 / failed 開立失敗 / void 已作廢
  invoiceNo: text('invoice_no').notNull().default(''),
  invoiceDate: text('invoice_date').notNull().default(''),
  randomNumber: text('random_number').notNull().default(''),
  amount: integer('amount').notNull(),
  buyer: text('buyer').notNull().default(''), // 開給誰／存到哪（顯示用）
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  preorderId: integer('preorder_id').references(() => preorder.id, { onDelete: 'set null' }), // 一筆訂單（收款）一張
  checks: jsonb('checks').$type<string[]>().notNull().default([]), // 電腦核對發現的異常
  issuedBy: text('issued_by'),
}, (t) => ({ order: index('invoice_order_idx').on(t.orderId), preorder: index('invoice_preorder_idx').on(t.preorderId) }));

/** 網銀入帳（後台上傳明細）：只存後五碼，不存完整帳號；key 用來避免重複匯入 */
export const bankTx = pgTable('bank_tx', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  at: timestamp('at', { withTimezone: true }).notNull(),
  amount: integer('amount').notNull(),
  last5: text('last5').notNull().default(''),
  memo: text('memo').notNull().default(''),
  key: text('key').notNull(),
  ignored: boolean('ignored').notNull().default(false), // 不是認購款（後台按「略過」）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull().default(''),
}, (t) => ({ key: uniqueIndex('bank_tx_key_idx').on(t.eventId, t.key) }));

/**
 * 三樓信用卡訂單：買方按「前往付款」時建立（pending），綠界回報成功才變 paid，並建立 preorder（source=card）與劃位連結。
 * status：pending 付款中／paid 已付款／failed 付款失敗／expired 逾時未付／refunding 刷退中／refunded 已退票
 */
export const cardOrder = pgTable('card_order', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  tradeNo: text('trade_no').notNull(), // 傳給綠界的 MerchantTradeNo（永不重複）
  token: text('token').notNull(), // 買方回到結果頁用的隨機碼
  env: text('env').notNull(), // test 綠界測試環境／prod 正式
  status: text('status').notNull().default('pending'),
  items: jsonb('items').$type<PreorderItem[]>().notNull(),
  amount: integer('amount').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  invType: text('inv_type').notNull().default('member'),
  invCode: text('inv_code').notNull().default(''),
  invTitle: text('inv_title').notNull().default(''),
  preorderId: integer('preorder_id'),
  linkId: integer('link_id'),
  gwTradeNo: text('gw_trade_no').notNull().default(''), // 綠界交易編號
  gwAuthNo: text('gw_auth_no').notNull().default(''), // 信用卡授權單號（gwsr），查關帳狀態用
  paidVia: text('paid_via').notNull().default(''), // 哪一道保險先收到：return／result／query／admin
  note: text('note').notNull().default(''),
  flagged: boolean('flagged').notNull().default(false), // 需要人工處理（金額不符、超賣、刷退後作廢失敗）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reserveUntil: timestamp('reserve_until', { withTimezone: true }).notNull(), // 付款中先佔名額到這個時間
  lastQueryAt: timestamp('last_query_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  refundAmount: integer('refund_amount').notNull().default(0),
  refundFee: integer('refund_fee').notNull().default(0),
  refundBy: text('refund_by'),
}, (t) => ({ tradeNo: uniqueIndex('card_order_trade_no_idx').on(t.tradeNo), token: uniqueIndex('card_order_token_idx').on(t.token), byStatus: index('card_order_status_idx').on(t.status) }));

/* ---------- 揪團贈票（銀區買十送一）：團練場、揪團登記 ---------- */

/** 團練場清單（後台維護；登記表從這裡選）。code 給第二階段的團練場回報連結用 */
export const joinVenue = pgTable('join_venue', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  active: boolean('active').notNull().default(true), // false：登記表不顯示（已登記的不受影響）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ code: uniqueIndex('join_venue_code_idx').on(t.code) }));

/** 揪團登記：一份登記＝一位負責人（底下可有多位揪團人） */
export const joinReg = pgTable('join_reg', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  venueId: integer('venue_id').references(() => joinVenue.id, { onDelete: 'set null' }),
  venueText: text('venue_text').notNull().default(''), // 選「其他」時自己填的團練場名稱
  headName: text('head_name').notNull(),
  headPhone: text('head_phone').notNull(),
  email: text('email').notNull().default(''), // 負責人 Email：回報連結、劃位連結、通知都寄到這裡
  reportCode: text('report_code'), // 團練場回報連結（負責人轉給志工）
  pickCode: text('pick_code'), // 負責人劃位連結（綁 Email，請勿轉傳）
  linksSentAt: timestamp('links_sent_at', { withTimezone: true }), // 回報連結信寄出時間
  pickSentAt: timestamp('pick_sent_at', { withTimezone: true }), // 劃位連結信寄出時間（劃位序鎖定後才寄）
  status: text('status').notNull().default('pending'), // pending 待審核 / approved 已核准 / rejected 已退回
  reason: text('reason').notNull().default(''), // 退回原因
  note: text('note').notNull().default(''), // 後台備註
  ip: text('ip').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: text('decided_by'),
}, (t) => ({ byStatus: index('join_reg_status_idx').on(t.status), report: uniqueIndex('join_reg_report_idx').on(t.reportCode), pick: uniqueIndex('join_reg_pick_idx').on(t.pickCode) }));

/** （舊）揪團人：11/10 改為「志工不登記」後不再使用，保留資料表以免舊資料遺失 */
export const joinLeader = pgTable('join_leader', {
  id: serial('id').primaryKey(),
  regId: integer('reg_id').notNull().references(() => joinReg.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull().default(''),
  noEmail: boolean('no_email').notNull().default(false), // 沒有 Email：後台改用 LINE 傳連結
  sameAsHead: boolean('same_as_head').notNull().default(false),
  code: text('code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ code: uniqueIndex('join_leader_code_idx').on(t.code), byPhone: index('join_leader_phone_idx').on(t.phone) }));

/** 年代銷售名單（後台上傳；回報時當下核對） */
export const joinEra = pgTable('join_era', {
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  orderNo: text('order_no').notNull(),
  qty: integer('qty').notNull(),
  status: text('status').notNull().default('sold'), // sold 已售 / refunded 已退
  soldAt: timestamp('sold_at', { withTimezone: true }), // 年代售出時間（用來排除回報之後才賣出的同後四碼訂單）
  otherQty: integer('other_qty').notNull().default(0), // 同一訂單裡不算贈票的票（非銀區、票價不符）
  otherNote: text('other_note').notNull().default(''), // 例：4樓 2 張、售價 1000 1 張
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.eventId, t.orderNo] }) }));

/** 年代售出明細：逐張票（樓層、排、號、票價），給全場銷售統計、三樓座位圖標示已售 */
export const joinEraTicket = pgTable('join_era_ticket', {
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  ticketNo: text('ticket_no').notNull(), // 例：ER2611120000109-3
  orderNo: text('order_no').notNull(),
  floor: text('floor').notNull().default(''), // 年代的「區樓」原文，例：3樓
  rowNo: text('row_no').notNull().default(''), // 例：13排
  seatNo: text('seat_no').notNull().default(''), // 例：33號
  price: integer('price').notNull().default(0), // 售價
  status: text('status').notNull().default('sold'), // sold / refunded
  soldAt: timestamp('sold_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.eventId, t.ticketNo] }) }));

/** 志工回報的年代訂單（同一訂單全場只能報一次） */
export const joinReport = pgTable('join_report', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  regId: integer('reg_id').notNull().references(() => joinReg.id, { onDelete: 'cascade' }),
  key: text('key').notNull().default(''), // 志工輸入的（後 4 碼以上的數字，或完整訂單編號）
  orderNo: text('order_no'), // 對到的完整訂單編號；還沒對到（待核對、需補完整編號）時是 null
  buyDate: text('buy_date'), // 只輸入後幾碼時的購買日期 YYMMDD（預設回報當天，訂單編號 ER+YYMMDD+流水號）
  qty: integer('qty').notNull(),
  reporter: text('reporter').notNull().default(''), // 填寫人（志工名字）
  device: text('device').notNull().default(''), // 送出的手機（共用連結：只有同一支手機能刪除、補編號）
  // 先收後核：pending 待核對 / ok 已核對 / mismatch 張數不符 / refunded 已退票 / ambiguous 後四碼對到多筆，需補完整編號
  // outside 非銀區（不計贈票）/ early 回報早於年代售出時間
  status: text('status').notNull().default('pending'),
  note: text('note').notNull().default(''), // 核對說明（給志工、負責人、後台看）
  eraQty: integer('era_qty'), // 核對時年代名單上的張數
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ order: uniqueIndex('join_report_order_idx').on(t.eventId, t.orderNo), byReg: index('join_report_reg_idx').on(t.regId) }));

/** 劃位序：團練場每滿 10 張取得一個。pos 是目前排隊位置（延後時會變），no 是最初序號 */
export const joinSlot = pgTable('join_slot', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  regId: integer('reg_id').notNull().references(() => joinReg.id, { onDelete: 'cascade' }),
  no: integer('no').notNull(),
  pos: doublePrecision('pos').notNull(),
  status: text('status').notNull().default('wait'), // wait 排隊 / turn 輪到 / done 已選位 / void 取消
  round: integer('round').notNull().default(1), // 第幾輪鎖定的
  extraMin: integer('extra_min').notNull().default(0), // 後台多給的分鐘（輪到這一次）
  draft: text('draft').notNull().default(''), // 選位中已點選的座位（JSON：seats、repName、repPhone），時間到時先存這些
  voidReason: text('void_reason').notNull().default(''), // 取消原因；'refund'＝自動模式：已核對張數減少（退票），移到退票區
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  misses: integer('misses').notNull().default(0),
  turnAt: timestamp('turn_at', { withTimezone: true }),
  seenAt: timestamp('seen_at', { withTimezone: true }), // 輪到後負責人有打開頁面
  soonMailed: boolean('soon_mailed').notNull().default(false),
  turnMailed: boolean('turn_mailed').notNull().default(false),
  seatId: text('seat_id'),
  repName: text('rep_name').notNull().default(''), // 領票代表
  repPhone: text('rep_phone').notNull().default(''),
  pickedAt: timestamp('picked_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }), // 已送年代：之後只有後台能改
  earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ no: uniqueIndex('join_slot_no_idx').on(t.eventId, t.no), seat: uniqueIndex('join_slot_seat_idx').on(t.eventId, t.seatId), byReg: index('join_slot_reg_idx').on(t.regId) }));
