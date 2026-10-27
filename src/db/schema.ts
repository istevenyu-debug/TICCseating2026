/**
 * 資料表結構，對應規格書第 10 節。
 * 金額一律為整數新台幣；時間一律 timestamptz。
 */
import {
  pgTable, serial, integer, text, boolean, timestamp, primaryKey, uniqueIndex, index, jsonb,
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
  holdMinutes: integer('hold_minutes').notNull().default(20),
  payHours: integer('pay_hours').notNull().default(48),
  payFirst: boolean('pay_first').notNull().default(true), // 先匯款再給連結：購票頁不填匯款資料、不逾期取消
  bankName: text('bank_name').notNull().default(''),
  bankAccount: text('bank_account').notNull().default(''),
  accountName: text('account_name').notNull().default(''),
  published: jsonb('published').$type<Published>(),
  publicSaleStart: timestamp('public_sale_start', { withTimezone: true }), // 公開連結開始時間；未設定時同 saleStart
  publicPerPhone: integer('public_per_phone').notNull().default(0), // 公開連結每支手機上限，0 = 不限
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
});

/** 組合票內容：哪個票種、幾張。例：買一A送二B = (A,1) + (B,2) */
export const comboItem = pgTable('combo_item', {
  comboId: integer('combo_id').notNull().references(() => combo.id, { onDelete: 'cascade' }),
  zoneId: integer('zone_id').notNull().references(() => priceZone.id),
  qty: integer('qty').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.comboId, t.zoneId] }) }));

/** 專屬購票連結 */
export const inviteLink = pgTable('invite_link', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  quota: integer('quota').notNull(), // 專屬連結可購張數，0 = 不限
  note: text('note').notNull().default(''), // 來帳備註（例：末五碼、金額），主辦方對帳用
  kind: text('kind').notNull().default('personal'), // personal 專屬連結 / public 公開連結
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'), // active / disabled
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
});

/** 手機推播訂閱：消費者在購票頁按「開啟通知」後建立 */
export const pushSub = pgTable('push_sub', {
  id: serial('id').primaryKey(),
  linkId: integer('link_id').notNull().references(() => inviteLink.id, { onDelete: 'cascade' }),
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
