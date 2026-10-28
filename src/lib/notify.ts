/**
 * 通知寄送：Email（SMTP，例如 Gmail）與簡訊（三竹 Mitake）。
 *
 * 各處只把通知寫進 notification 資料表（status = queued），由這裡負責真正寄出：
 * - 有動作時（消費者送出、後台操作）立即寄一次；另每 30 秒補寄一次。
 * - 失敗會重試，共 3 次；仍失敗則標為 failed 並記錄原因，後台可重寄。
 * - 未設定寄送帳號的管道標為 simulated（只存紀錄），後台會提示。
 *
 * 寄送帳號存在 app_setting 資料表，由後台「通知設定」填寫；也可用環境變數設定（優先）。
 * 密碼類設定只寫不讀，不會回傳到後台畫面。
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { getVapid, removeSubs, siteOrigin, targetsOf, webPushSend, type PushSender } from './push';

export interface EmailConfig { host: string; port: number; user: string; pass: string; fromName: string }
export interface SmsConfig { url: string; user: string; pass: string }
export interface NotifyConfig { email: EmailConfig | null; sms: SmsConfig | null }

export const DEFAULT_MITAKE_URL = 'https://smsapi.mitake.com.tw/api/mtk/SmSend';
const MAX_ATTEMPTS = 3;

const KEYS = ['email.host', 'email.port', 'email.user', 'email.pass', 'email.fromName', 'sms.url', 'sms.user', 'sms.pass'] as const;
type Key = (typeof KEYS)[number];
const ENV: Record<Key, string> = {
  'email.host': 'SMTP_HOST', 'email.port': 'SMTP_PORT', 'email.user': 'SMTP_USER', 'email.pass': 'SMTP_PASS', 'email.fromName': 'MAIL_FROM_NAME',
  'sms.url': 'MITAKE_API_URL', 'sms.user': 'MITAKE_USERNAME', 'sms.pass': 'MITAKE_PASSWORD',
};

async function readSettings(db: Db): Promise<Record<Key, string>> {
  const rows = await db.select().from(t.appSetting).where(inArray(t.appSetting.key, [...KEYS]));
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Record<Key, string>>;
  return Object.fromEntries(KEYS.map((k) => [k, (process.env[ENV[k]] ?? m[k] ?? '').trim()])) as Record<Key, string>;
}

export async function getNotifyConfig(db: Db): Promise<NotifyConfig> {
  const s = await readSettings(db);
  const email = s['email.user'] && s['email.pass']
    ? { host: s['email.host'] || 'smtp.gmail.com', port: parseInt(s['email.port']) || 465, user: s['email.user'], pass: s['email.pass'], fromName: s['email.fromName'] }
    : null;
  const sms = s['sms.user'] && s['sms.pass'] ? { url: s['sms.url'] || DEFAULT_MITAKE_URL, user: s['sms.user'], pass: s['sms.pass'] } : null;
  return { email, sms };
}

/** 給後台畫面：不含密碼 */
export async function publicNotifyConfig(db: Db) {
  const s = await readSettings(db);
  return {
    email: { host: s['email.host'] || 'smtp.gmail.com', port: parseInt(s['email.port']) || 465, user: s['email.user'], fromName: s['email.fromName'],
      passSet: !!s['email.pass'], ready: !!(s['email.user'] && s['email.pass']) },
    sms: { url: s['sms.url'] || DEFAULT_MITAKE_URL, user: s['sms.user'], passSet: !!s['sms.pass'], ready: !!(s['sms.user'] && s['sms.pass']) },
  };
}

/** 儲存設定；密碼欄位留空代表不變更 */
export async function saveNotifyConfig(db: Db, actor: string, v: Partial<Record<Key, string>>) {
  for (const k of KEYS) {
    const val = v[k];
    if (val === undefined) continue;
    if (k.endsWith('.pass') && val === '') continue;
    await db.insert(t.appSetting).values({ key: k, value: val.trim() })
      .onConflictDoUpdate({ target: t.appSetting.key, set: { value: val.trim() } });
  }
  await db.insert(t.auditLog).values({
    actor, action: 'notify_settings', target: 'app_setting',
    detail: JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.endsWith('.pass') ? (x ? '（已變更）' : '（未變更）') : x]))),
  });
}

/* ---------- 實際寄送 ---------- */

const SUBJECT: Record<string, string> = {
  invite: '您的專屬購票連結',
  order_received: '已收到您的訂購資料',
  order_confirmed: '劃位成功通知',
  order_cancelled: '訂單取消通知',
  order_expired: '訂單逾期取消通知',
  preorder_received: '已收到您的訂單',
  preorder_link: '已收到款項：您的專屬劃位連結',
  preorder_cancelled: '訂單取消通知',
  test: '測試信',
};

export interface MailExtra { html?: string; attachments?: { filename: string; content: Buffer; cid: string }[] }

export interface Senders {
  email: (cfg: EmailConfig, to: string, subject: string, text: string, extra?: MailExtra) => Promise<void>;
  sms: (cfg: SmsConfig, phone: string, text: string) => Promise<void>;
  push?: PushSender;
}

async function smtpSend(cfg: EmailConfig, to: string, subject: string, text: string, extra?: MailExtra) {
  const nodemailer = (await import('nodemailer')).default;
  const tr = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  try {
    await tr.sendMail({ from: cfg.fromName ? { name: cfg.fromName, address: cfg.user } : cfg.user, to, subject, text, html: extra?.html, attachments: extra?.attachments });
  } catch (e) {
    const m = String((e as Error).message ?? e);
    if (/535|Username and Password not accepted|Invalid login|BadCredentials/i.test(m)) {
      throw new Error('Email 帳號或應用程式密碼錯誤（Gmail 需使用「應用程式密碼」，不是登入密碼）');
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ESOCKET|timeout/i.test(m)) throw new Error(`連不到寄信伺服器 ${cfg.host}:${cfg.port}（${m.slice(0, 80)}）`);
    if (/recipient|5\.1\.1|address/i.test(m)) throw new Error(`收件信箱有誤：${to}`);
    throw new Error(`寄信失敗：${m.slice(0, 160)}`);
  }
}

const MITAKE_ERR: Record<string, string> = {
  '*': '三竹系統錯誤', a: '簡訊暫時無法發送', b: '簡訊暫時無法發送', c: '未填三竹帳號', d: '未填三竹密碼',
  e: '三竹帳號或密碼錯誤', f: '三竹帳號已過期', h: '三竹帳號已停用', k: '連線來源 IP 未授權（請向三竹申請開通此 IP）',
  m: '三竹要求變更密碼', n: '三竹密碼已過期', p: '三竹帳號沒有 API 權限', r: '三竹服務暫停', s: '三竹點數不足或計費失敗',
  t: '簡訊已過期', u: '簡訊內容空白', v: '手機號碼無效', '5': '簡訊內容有誤', '6': '手機號碼錯誤', '7': '簡訊已停用', '8': '傳送逾時',
};

export async function mitakeSend(cfg: SmsConfig, phone: string, text: string) {
  const u = new URL(cfg.url);
  u.searchParams.set('CharsetURL', 'UTF8');
  const body = new URLSearchParams({ username: cfg.user, password: cfg.pass, dstaddr: phone.replace(/\D/g, ''), smbody: text });
  let res: Response;
  try {
    res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`連不到三竹簡訊伺服器（${String((e as Error).message ?? e).slice(0, 80)}）`);
  }
  const out = await res.text();
  if (!res.ok) throw new Error(`三竹回應 HTTP ${res.status}：${out.slice(0, 120)}`);
  const code = out.match(/statuscode=(\S)/)?.[1];
  if (!code) throw new Error(`三竹回應無法辨識：${out.slice(0, 120)}`);
  if (!['0', '1', '2', '3', '4'].includes(code)) throw new Error(`${MITAKE_ERR[code] ?? '簡訊發送失敗'}（代碼 ${code}）`);
}

const realSenders: Senders = { email: smtpSend, sms: mitakeSend, push: webPushSend };

let running: Promise<void> | null = null;

/** 寄出所有待寄通知。同一時間只會有一個在跑。 */
export function dispatchQueued(db: Db, senders: Senders = realSenders, now = () => new Date()): Promise<void> {
  if (running) return running;
  running = (async () => {
    try {
      for (let round = 0; round < 10; round++) {
        const rows = await db.select().from(t.notification).where(eq(t.notification.status, 'queued')).orderBy(asc(t.notification.id)).limit(20);
        if (!rows.length) return;
        const cfg = await getNotifyConfig(db);
        for (const n of rows) await deliverOne(db, n, cfg, senders, now());
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

async function deliverOne(db: Db, n: typeof t.notification.$inferSelect, cfg: NotifyConfig, senders: Senders, now: Date) {
  const set = (v: Partial<typeof t.notification.$inferInsert>) =>
    db.update(t.notification).set(v).where(and(eq(t.notification.id, n.id), eq(t.notification.status, 'queued')));
  if (n.channel === 'push') return deliverPush(db, n, senders, now, set);
  if (!n.recipient.trim()) return set({ status: 'failed', error: '沒有收件人' });
  const isSms = n.channel === 'sms';
  const c = isSms ? cfg.sms : cfg.email;
  if (!c) return set({ status: 'simulated', error: isSms ? '尚未設定簡訊帳號，只存紀錄' : '尚未設定 Email 寄件帳號，只存紀錄' });
  try {
    if (isSms) await senders.sms(c as SmsConfig, n.recipient, n.content);
    else await senders.email(c as EmailConfig, n.recipient, SUBJECT[n.template] ?? '通知', n.content,
      n.template === 'order_confirmed' && n.orderId ? await ticketMail(db, n.orderId, n.content) : undefined);
    await set({ status: 'sent', sentAt: now, error: null, attempts: n.attempts + 1 });
  } catch (e) {
    const attempts = n.attempts + 1;
    const msg = String((e as Error).message ?? e).slice(0, 300);
    await set(attempts >= MAX_ATTEMPTS ? { status: 'failed', error: msg, attempts } : { error: msg, attempts });
  }
}

const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const maskBase = (n: string) => (n.length <= 1 ? n : n.length === 2 ? `${n[0]}○` : `${n[0]}${'○'.repeat(n.length - 2)}${n[n.length - 1]}`);
/** 王大明 → 王○明；自動編號的「王大明02」→「王○明02」 */
const maskName = (n: string) => { const m = n.match(/^(.*?)(\d+)$/); return m && m[1] ? maskBase(m[1]) + m[2] : maskBase(n); };

/** 劃位成功 Email：每張票一個 QR code（內嵌圖片，與入場券、購票頁的序號相同） */
export async function ticketMail(db: Db, orderId: number, text: string): Promise<MailExtra> {
  const { ticketData } = await import('./admin');
  const QR = (await import('qrcode')).default;
  const { event, tickets } = await ticketData(db, [orderId]);
  const attachments: NonNullable<MailExtra['attachments']> = [];
  const cards: string[] = [];
  for (const [i, tk] of tickets.entries()) {
    const cid = `qr${i}@ticket`;
    attachments.push({ filename: `${tk.serial}.png`, content: await QR.toBuffer(`TICC|${tk.serial}`, { type: 'png', margin: 1, width: 220 }), cid });
    cards.push(`<table role="presentation" style="border:1px solid #d6dce8;border-radius:10px;margin:0 0 12px;width:100%;max-width:520px"><tr>
      <td style="padding:12px;width:140px"><img src="cid:${cid}" width="130" height="130" alt="入場 QR code ${esc(tk.serial)}" style="display:block"></td>
      <td style="padding:12px 12px 12px 0;font:14px/1.6 sans-serif;color:#18213a">
        <div style="font-size:18px;font-weight:700">${esc(tk.label)}</div>
        <div>座位編號 ${esc(tk.code)}・${esc(tk.zoneName)}</div>
        <div>持票人 ${esc(maskName(tk.holderName))}（${tk.holderId4.length > 4 ? '證號' : '證末4碼'} ${esc(tk.holderId4)}）</div>
        ${tk.entrance ? `<div>${esc(tk.entrance)}</div>` : ''}
        <div style="color:#5b6579;font-family:monospace">序號 ${esc(tk.serial)}</div>
      </td></tr></table>`);
  }
  const when = event.showAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const html = `<div style="font:15px/1.7 sans-serif;color:#18213a;max-width:560px">
    <h2 style="margin:0 0 4px">🎉 劃位成功</h2>
    <div style="color:#5b6579;margin-bottom:12px">${esc(event.name)}・${esc(when)}・台北國際會議中心 大會堂</div>
    <p style="margin:0 0 14px">${esc(text)}</p>
    <p style="margin:0 0 10px"><b>入場時請出示以下 QR code 與身分證件</b>（每張票一個，可截圖保存）：</p>
    ${cards.join('')}
    <p style="color:#5b6579;font-size:13px">每個 QR code 只能入場一次，請勿轉傳給他人。</p></div>`;
  return { html, attachments };
}

const PUSH_TITLE: Record<string, string> = {
  order_confirmed: '🎉 劃位成功', order_cancelled: '訂單已取消', order_expired: '訂單已逾期取消', order_received: '已收到訂購資料',
};

/** App 推播：推到訂購人手機（購票頁按過「開啟通知」的那支） */
async function deliverPush(db: Db, n: typeof t.notification.$inferSelect, senders: Senders, now: Date,
  set: (v: Partial<typeof t.notification.$inferInsert>) => Promise<unknown>) {
  const { subs, code } = await targetsOf(db, n.orderId, n.linkId);
  if (!subs.length) return set({ status: 'simulated', error: '訂購人未開啟手機通知；訊息已顯示在他的購票頁' });
  const send = senders.push ?? webPushSend;
  const vapid = await getVapid(db);
  const origin = await siteOrigin(db);
  const payload = { title: PUSH_TITLE[n.template] ?? '主辦方通知', body: n.content, url: `${origin}/t/${code}` };
  const gone: number[] = [];
  let ok = 0; let lastErr = '';
  for (const s of subs) {
    try { await send(s, payload, vapid); ok++; } catch (e) {
      const m = String((e as Error).message ?? e);
      if (m === 'GONE') gone.push(s.id); else lastErr = m;
    }
  }
  await removeSubs(db, gone);
  if (ok) return set({ status: 'sent', sentAt: now, error: null, attempts: n.attempts + 1, recipient: `${ok} 支手機` });
  if (!lastErr) return set({ status: 'simulated', error: '訂購人已關閉手機通知；訊息已顯示在他的購票頁' });
  const attempts = n.attempts + 1;
  return set(attempts >= MAX_ATTEMPTS ? { status: 'failed', error: lastErr, attempts } : { error: lastErr, attempts });
}

/** 重寄：失敗或未設定時只存紀錄的通知，改回待寄並立即寄送 */
export async function resendNotification(db: Db, actor: string, id: number) {
  const [n] = await db.select().from(t.notification).where(eq(t.notification.id, id));
  if (!n) throw new BookingError('NOT_FOUND', '找不到這則通知');
  await db.update(t.notification).set({ status: 'queued', attempts: 0, error: null }).where(eq(t.notification.id, id));
  await db.insert(t.auditLog).values({ actor, action: 'notify_resend', target: `notification:${id}`, detail: null });
  await dispatchQueued(db);
  const [after] = await db.select().from(t.notification).where(eq(t.notification.id, id));
  return { status: after.status, error: after.error };
}

/** 測試寄送：直接寄，不寫入通知紀錄；失敗時把原因丟回後台 */
export async function sendTest(db: Db, channel: 'sms' | 'email', to: string, senders: Senders = realSenders) {
  const cfg = await getNotifyConfig(db);
  const text = '這是劃位系統的測試訊息。收到代表通知設定正確。';
  if (channel === 'sms') {
    if (!cfg.sms) throw new BookingError('INVALID', '請先填寫並儲存三竹帳號與密碼。');
    if (!/^09\d{8}$/.test(to.replace(/\D/g, ''))) throw new BookingError('INVALID', '手機應為 09 開頭的 10 位數字');
    await senders.sms(cfg.sms, to, text).catch((e) => { throw new BookingError('SEND_FAILED', String(e.message ?? e)); });
  } else {
    if (!cfg.email) throw new BookingError('INVALID', '請先填寫並儲存寄件 Email 與應用程式密碼。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) throw new BookingError('INVALID', '收件 Email 格式不正確');
    await senders.email(cfg.email, to.trim(), SUBJECT.test, text).catch((e) => { throw new BookingError('SEND_FAILED', String(e.message ?? e)); });
  }
}

/** 後台通知紀錄 */
export async function listNotifications(db: Db, limit = 100) {
  const rows = await db.select().from(t.notification).orderBy(desc(t.notification.id)).limit(limit);
  return rows.map((n) => ({
    id: n.id, orderId: n.orderId, channel: n.channel, template: n.template, recipient: n.recipient, content: n.content,
    status: n.status, error: n.error, attempts: n.attempts, createdAt: n.createdAt.toISOString(), sentAt: n.sentAt?.toISOString() ?? null,
  }));
}

/** 背景補寄：每 30 秒一次（每個伺服器行程只啟動一個） */
export function startDispatcher(db: Db) {
  const g = globalThis as unknown as { __ticcDispatch?: NodeJS.Timeout };
  if (g.__ticcDispatch) return;
  g.__ticcDispatch = setInterval(() => { dispatchQueued(db).catch(() => undefined); }, 30_000);
  g.__ticcDispatch.unref?.();
}
