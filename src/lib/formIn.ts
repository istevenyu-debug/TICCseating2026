/**
 * Google 表單報名 → 後台「四、表單／收款」。
 *
 * 老闆的 Google 表單裡裝一小段 Apps Script（後台有可複製的程式碼），每有人送出、以及每 5 分鐘，
 * 會把表單回覆送到 /api/form-in?key=…。這裡把每筆回覆變成一張「待確認」訂單（來源：表單），
 * 已匯入過的（同一個回覆編號）不會重複。
 * 表單沒有數量：確認收訖時由後台選擇內容與數量，系統再自動寄出劃位連結。
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { normalizePhone } from './validation';

const KEY = 'form.key';

export async function getFormKey(db: Db) {
  const [r] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY));
  if (r?.value) return r.value;
  const value = randomBytes(12).toString('hex');
  await db.insert(t.appSetting).values({ key: KEY, value }).onConflictDoNothing();
  const [again] = await db.select().from(t.appSetting).where(eq(t.appSetting.key, KEY));
  return again.value;
}

const body = z.object({
  list: z.array(z.object({
    id: z.string().min(1).max(200),
    at: z.string().max(40).optional(),
    email: z.string().max(200).optional().default(''),
    answers: z.array(z.object({ q: z.string().max(500), a: z.string().max(3000) })).max(60),
  })).max(500),
});

/** 依題目文字對應欄位（不靠題目順序，老闆改題目順序也沒關係） */
const RULES: [keyof Picked, RegExp][] = [
  ['skip', /個資|同意|隱私|LINE/i],
  ['inv', /發票|二聯|三聯/],
  ['company', /公司|統編|抬頭/],
  ['last5', /後\s*5\s*碼|後五碼|末五碼|末\s*5\s*碼|帳號/],
  ['email', /mail|信箱/i],
  ['phone', /電話|手機|phone/i],
  ['name', /姓名|名字|name/i],
];
interface Picked { name: string; phone: string; email: string; last5: string; inv: string; company: string; skip: string }

export function pick(answers: { q: string; a: string }[], respondentEmail = ''): Picked {
  const p: Picked = { name: '', phone: '', email: '', last5: '', inv: '', company: '', skip: '' };
  for (const { q, a } of answers) {
    const hit = RULES.find(([, re]) => re.test(q));
    if (!hit || hit[0] === 'skip') continue;
    const k = hit[0];
    p[k] = p[k] ? `${p[k]}；${a.trim()}` : a.trim();
  }
  if (!p.email) p.email = respondentEmail.trim();
  return p;
}

/** 收到表單回覆：新的建立成「待確認」訂單，舊的略過 */
export async function ingestForm(db: Db, raw: unknown, now = new Date()) {
  const b = body.safeParse(raw);
  if (!b.success) throw new BookingError('INVALID', b.error.issues[0]?.message ?? '資料格式不正確');
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  const ids = b.data.list.map((x) => x.id);
  const have = new Set(ids.length ? (await db.select({ f: t.preorder.formId }).from(t.preorder).where(inArray(t.preorder.formId, ids))).map((r) => r.f) : []);
  let added = 0;
  for (const r of b.data.list) {
    if (have.has(r.id)) continue;
    const p = pick(r.answers, r.email);
    const phone = normalizePhone(p.phone).replace(/[()（）]/g, '').replace(/^\+?886/, '0').slice(0, 30);
    const company = /三聯/.test(p.inv) || (!!p.company && !/二聯/.test(p.inv));
    const ubn = (p.company.match(/\d{8}/) ?? [''])[0];
    const title = p.company.replace(/\d{8}/, '').replace(/[，,、:：\s／/]+$/g, '').replace(/^[，,、:：\s／/]+/g, '').trim();
    const at = r.at && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at) : now;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t.preorder).where(and(eq(t.preorder.eventId, ev.id), eq(t.preorder.source, 'form')));
      const no = `F${String(n + 1 + attempt).padStart(4, '0')}`;
      try {
        await db.insert(t.preorder).values({
          eventId: ev.id, no, items: [], amount: 0, name: p.name || '（未填姓名）', phone, email: p.email,
          paidAmount: 0, last5: p.last5, createdAt: at, source: 'form', formId: r.id, answers: r.answers,
          invType: company ? 'company' : 'member', invCode: company ? ubn : '', invTitle: company ? title : '',
        });
        added++;
        break;
      } catch (e) {
        const m = String((e as Error).message);
        if (/form_id/.test(m)) break; // 同時送來兩次：已經有了
        if (!/unique|duplicate/i.test(m)) throw e;
      }
    }
  }
  return { received: b.data.list.length, added };
}
