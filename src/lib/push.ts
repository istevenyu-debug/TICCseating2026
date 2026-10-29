/**
 * 手機推播（Web Push）：消費者在購票頁按「開啟通知」後，主辦方確認到帳或取消訂單時，
 * 手機會直接跳出通知，即使購票頁已關閉。
 *
 * - 金鑰（VAPID）第一次使用時自動產生，存在 app_setting。
 * - Android 的 Chrome 直接可用；iPhone 需 iOS 16.4 以上，並先把購票頁「加入主畫面」再從主畫面開啟。
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';

export interface PushPayload { title: string; body: string; url: string }
export type PushSender = (sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload, vapid: Vapid) => Promise<void>;
export interface Vapid { publicKey: string; privateKey: string }

async function setting(db: Db, key: string) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, key));
  return r?.value ?? '';
}
async function put(db: Db, key: string, value: string) {
  await db.insert(t.appSetting).values({ key, value }).onConflictDoUpdate({ target: t.appSetting.key, set: { value } });
}

export async function getVapid(db: Db): Promise<Vapid> {
  let publicKey = await setting(db, 'push.public');
  let privateKey = await setting(db, 'push.private');
  if (!publicKey || !privateKey) {
    const wp = (await import('web-push')).default;
    ({ publicKey, privateKey } = wp.generateVAPIDKeys());
    await put(db, 'push.public', publicKey);
    await put(db, 'push.private', privateKey);
  }
  return { publicKey, privateKey };
}

/** 記下網站目前的網址（臨時通道每次啟動會變），推播點開時用 */
export async function rememberOrigin(db: Db, origin: string) {
  if (!origin) return;
  if ((await setting(db, 'site.origin')) !== origin) await put(db, 'site.origin', origin);
}
export async function siteOrigin(db: Db) {
  return (process.env.PUBLIC_BASE_URL || (await setting(db, 'site.origin'))).replace(/\/$/, '');
}

export async function saveSubscription(db: Db, linkId: number, visitorId: string | null, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  if (!/^https:\/\//.test(sub.endpoint)) throw new BookingError('INVALID', '推播訂閱資料不正確');
  await db.insert(t.pushSub).values({ linkId, visitorId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    .onConflictDoUpdate({ target: t.pushSub.endpoint, set: { linkId, visitorId, preorderId: null, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
}

/** 這則通知要推給誰：專屬連結推給整條連結的訂閱；公開連結只推給下單的那位訪客 */
export async function targetsOf(db: Db, orderId: number | null, linkId: number | null) {
  if (orderId) {
    const [o] = await db.select({ linkId: t.orders.linkId, visitorId: t.orders.visitorId, kind: t.inviteLink.kind, code: t.inviteLink.code })
      .from(t.orders).innerJoin(t.inviteLink, eq(t.inviteLink.id, t.orders.linkId)).where(eq(t.orders.id, orderId));
    if (!o) return { subs: [], code: '' };
    const subs = await db.select().from(t.pushSub).where(o.kind === 'public'
      ? and(eq(t.pushSub.linkId, o.linkId), eq(t.pushSub.visitorId, o.visitorId ?? '-'))
      : eq(t.pushSub.linkId, o.linkId));
    return { subs, code: o.code };
  }
  if (linkId) {
    const [l] = await db.select().from(t.inviteLink).where(eq(t.inviteLink.id, linkId));
    return { subs: l ? await db.select().from(t.pushSub).where(eq(t.pushSub.linkId, linkId)) : [], code: l?.code ?? '' };
  }
  return { subs: [], code: '' };
}

export const webPushSend: PushSender = async (sub, payload, vapid) => {
  const wp = (await import('web-push')).default;
  try {
    await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
      vapidDetails: { subject: 'mailto:noreply@example.com', publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 7 * 86400,
    });
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    const err = new Error(code === 404 || code === 410 ? 'GONE' : `推播失敗（${code ?? String((e as Error).message ?? e).slice(0, 80)}）`);
    throw err;
  }
};

export async function removeSubs(db: Db, ids: number[]) {
  if (ids.length) await db.delete(t.pushSub).where(inArray(t.pushSub.id, ids));
}
