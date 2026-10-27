/**
 * 資料表結構，對應規格書第 10 節。
 * 金額一律為整數新台幣；時間一律 timestamptz。
 */
import {
  pgTable, serial, integer, text, boolean, timestamp, primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

/** 場館座位模板（與場次無關，固定不變） */
export const venueSeat = pgTable('venue_seat', {
  id: text('id').primaryKey(), // 例：'3-15'、'V-7'、'W-H11'
  section: text('section').notNull(), // WL 左側區 / L 左區 / C 中區 / R 右區 / WR 右側區 / VL VC VR VIP排 / W 輪椅席
  rowNo: integer('row_no'), // 1–12；VIP 排為 0；輪椅席為 null
  seatNo: text('seat_no').notNull(), // 座號（輪椅席為 H1–H16）
  seatType: text('seat_type').notNull(), // normal / vip / wheelchair
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
  maxPerOrder: integer('max_per_order').notNull().default(6),
  holdMinutes: integer('hold_minutes').notNull().default(20),
  payHours: integer('pay_hours').notNull().default(48),
  bankName: text('bank_name').notNull().default(''),
  bankAccount: text('bank_account').notNull().default(''),
  accountName: text('account_name').notNull().default(''),
});

/** 票區 */
export const priceZone = pgTable('price_zone', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  price: integer('price').notNull(),
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
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.seatId] }),
  byOrder: index('event_seat_order_idx').on(t.orderId),
}));

/** 組合票。qty = 0 代表單張購票 */
export const combo = pgTable('combo', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  qty: integer('qty').notNull(),
  discountPct: integer('discount_pct').notNull().default(100),
  sameZone: boolean('same_zone').notNull().default(false),
  limitSets: integer('limit_sets').notNull().default(0), // 0 = 不限量
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

/** 專屬購票連結 */
export const inviteLink = pgTable('invite_link', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => event.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  quota: integer('quota').notNull(),
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
  status: text('status').notNull().default('queued'), // queued / sent / failed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
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
