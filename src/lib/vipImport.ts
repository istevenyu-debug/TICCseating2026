/**
 * VIP／公益名單 Excel 批次匯入（2026-11-27）
 *
 * 欄位（表頭那一列，順序不拘）：席號｜姓名職稱｜單位｜類別｜email｜推薦人。沒有資料就空白。
 * - 席號：VIP-1（VIP 排 1 號）、1排34號、第1排34號、01-34；一格多席用「、」或逗號分開。
 * - 姓名職稱空白的列＝還沒排人，略過。
 * - 類別空白：VIP 排＝VIP，其他＝公益。表裡出現新的類別會自動加進類別清單。
 * - VIP：每人一筆，不寄 QR（人工給）。
 * - 公益（及 VIP 以外的類別）：同類別、同單位合成一筆，QR 信寄給這個單位第一個有 Email 的人；沒填單位的自己一筆。
 * - 匯入時一律不寄，匯入後另按「寄出」（先列收件人核對）。
 * - 同一座位已是同名的 VIP／公益＝已匯入過，略過（可重複上傳同一份檔案）。
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { seatLabel } from './layout';
import { getVipCats, setVipCats } from './checkinBoard';
import { createVip, listVips, setVipMode } from './vip';

export const IMPORT_HEAD = ['席號', '姓名職稱', '單位', '類別', 'email', '推薦人'] as const;
export const IMPORT_NOTE = 'Excel 匯入';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 全形轉半形、去空白 */
export function half(s: string) {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ').trim();
}

/** 席號 → 座位代號（venue_seat.id）；看不懂回傳 null */
export function parseSeat(text: string): string | null {
  const s = half(text).replace(/\s+/g, '').toUpperCase();
  let m = s.match(/^VIP(?:排)?-?(\d{1,3})號?$/);
  if (m) return `V-${Number(m[1])}`;
  m = s.match(/^第?(\d{1,2})排-?第?(\d{1,3})號?$/) ?? s.match(/^(\d{1,2})-(\d{1,3})$/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  return null;
}
/** 座位 → 席號文字（與匯入格式相同） */
export function seatText(s: { rowNo: number | null; seatNo: string; seatType: string }) {
  if (s.seatType === 'vip' || s.rowNo === 0) return `VIP-${s.seatNo}`;
  if (s.seatType === 'wheelchair') return seatLabel(s);
  return `${s.rowNo}排${s.seatNo}號`;
}

type Raw = { line: number; seat: string; name: string; org: string; cat: string; email: string; referrer: string };

/** 讀 Excel 第一個有「席號」「姓名」表頭的工作表 */
export async function readSheet(b64: string): Promise<Raw[]> {
  const X = await import('xlsx');
  let wb;
  try { wb = X.read(Buffer.from(b64, 'base64'), { type: 'buffer' }); } catch { throw new BookingError('INVALID', '讀不到這個檔案，請用 Excel（.xlsx）格式。'); }
  for (const name of wb.SheetNames) {
    const aoa = X.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false });
    for (let h = 0; h < Math.min(aoa.length, 15); h++) {
      const head = (aoa[h] ?? []).map((c) => half(String(c ?? '')).replace(/\s+/g, '').toLowerCase());
      const col = (re: RegExp) => head.findIndex((x) => re.test(x));
      const c = { seat: col(/席號|座位/), name: col(/姓名/), org: col(/單位|公司|機構/), cat: col(/類別/), email: col(/e-?mail|信箱|電子郵件/), ref: col(/推薦/) };
      if (c.seat < 0 || c.name < 0 || c.seat === c.name) continue;
      const get = (r: unknown[], i: number) => (i < 0 ? '' : half(String(r[i] ?? '')));
      return aoa.slice(h + 1).map((r, i) => ({
        line: h + i + 2, seat: get(r, c.seat), name: get(r, c.name).replace(/\s+/g, ' '), org: get(r, c.org), cat: get(r, c.cat).toUpperCase() === 'VIP' ? 'VIP' : get(r, c.cat),
        email: get(r, c.email).replace(/\s+/g, ''), referrer: get(r, c.ref),
      })).filter((r) => r.seat || r.name || r.org || r.email);
    }
  }
  throw new BookingError('INVALID', '找不到表頭。第一列要有「席號」「姓名職稱」等欄位（可下載範本對照）。');
}

export type PreviewRow = { line: number; seat: string; seats: string[]; name: string; org: string; cat: string; email: string; referrer: string; status: 'ok' | 'skip' | 'err'; reason: string; group: string };
export type PreviewGroup = { key: string; cat: string; org: string; send: boolean; to: { name: string; email: string } | null; holders: { seatId: string; label: string; name: string }[]; referrer: string };

/** 檢查每一列、分組；不寫入 */
export async function previewImport(db: Db, b64: string) {
  const raws = await readSheet(b64);
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) throw new BookingError('NO_EVENT', '目前沒有場次');
  const allIds = [...new Set(raws.flatMap((r) => r.seat.split(/[、,，;；\n]/).map((x) => parseSeat(x)).filter((x): x is string => !!x)))];
  const info = allIds.length ? await db.select({
    id: t.venueSeat.id, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType,
    status: t.eventSeat.status, orderId: t.eventSeat.orderId, usage: t.seatUsage.code,
  }).from(t.venueSeat).innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.venueSeat.id), eq(t.eventSeat.eventId, ev.id)))
    .innerJoin(t.seatUsage, eq(t.seatUsage.id, t.eventSeat.usageId)).where(inArray(t.venueSeat.id, allIds)) : [];
  const orderIds = [...new Set(info.map((s) => s.orderId).filter((x): x is number => !!x))];
  const owners = orderIds.length ? await db.select({ id: t.orders.id, orderNo: t.orders.orderNo, vip: t.orders.vip, status: t.orders.status }).from(t.orders).where(inArray(t.orders.id, orderIds)) : [];
  const holders = orderIds.length ? await db.select({ orderId: t.orderSeat.orderId, seatId: t.orderSeat.seatId, name: t.orderSeat.holderName }).from(t.orderSeat).where(inArray(t.orderSeat.orderId, orderIds)) : [];
  const count = new Map<string, number>();
  for (const r of raws) if (r.name) for (const x of r.seat.split(/[、,，;；\n]/)) { const id = parseSeat(x); if (id) count.set(id, (count.get(id) ?? 0) + 1); }

  const rows: PreviewRow[] = raws.map((r) => {
    const base = { line: r.line, seat: r.seat, seats: [] as string[], name: r.name, org: r.org, cat: r.cat, email: r.email, referrer: r.referrer, group: '' };
    if (!r.name) return { ...base, status: 'skip', reason: '沒有姓名，略過' };
    if (!r.seat) return { ...base, status: 'err', reason: '沒有席號' };
    const parts = r.seat.split(/[、,，;；\n]/).map((x) => x.trim()).filter(Boolean);
    const ids = parts.map(parseSeat);
    if (ids.some((x) => !x)) return { ...base, status: 'err', reason: `看不懂席號「${parts[ids.findIndex((x) => !x)]}」（例：VIP-1、1排34號）` };
    const seats = [...new Set(ids as string[])];
    const missing = seats.filter((id) => !info.find((s) => s.id === id));
    if (missing.length) return { ...base, seats, status: 'err', reason: `沒有這個座位：${missing.join('、')}` };
    const labels = seats.map((id) => seatText(info.find((s) => s.id === id)!));
    if (seats.some((id) => (count.get(id) ?? 0) > 1)) return { ...base, seats, seat: labels.join('、'), status: 'err', reason: '表內有其他列也用這個座位' };
    if (r.email && !EMAIL.test(r.email)) return { ...base, seats, seat: labels.join('、'), status: 'err', reason: 'Email 格式不對' };
    const cat = r.cat || (seats.every((id) => info.find((s) => s.id === id)!.seatType === 'vip') ? 'VIP' : '公益');
    if (cat.length > 10) return { ...base, seats, seat: labels.join('、'), status: 'err', reason: '類別最多 10 個字' };
    // 已匯入過（同座位、同名、VIP／公益）→ 略過
    const done = seats.every((id) => { const s = info.find((x) => x.id === id)!; const o = owners.find((x) => x.id === s.orderId);
      return s.status === 'sold' && o?.vip && o.status === 'paid' && holders.find((h) => h.orderId === o.id && h.seatId === id)?.name === r.name; });
    if (done) return { ...base, seats, seat: labels.join('、'), cat, status: 'skip', reason: '已匯入過，略過' };
    const bad = seats.map((id) => info.find((x) => x.id === id)!).filter((s) => s.status !== 'free' || ['join-gift', 'era-sold'].includes(s.usage));
    if (bad.length) {
      const s = bad[0]; const o = owners.find((x) => x.id === s.orderId);
      return { ...base, seats, seat: labels.join('、'), cat, status: 'err', reason: s.usage === 'era-sold' ? `${seatText(s)} 是年代售出` : s.usage === 'join-gift' ? `${seatText(s)} 是揪團贈席` : `${seatText(s)} 已有人（${o?.orderNo ?? '劃位中'}）` };
    }
    return { ...base, seats, seat: labels.join('、'), cat, status: 'ok', reason: '' };
  });

  // 分組：VIP 每人一筆；其他類別同類別＋同單位一筆（沒單位自己一筆）
  const groups: PreviewGroup[] = [];
  for (const r of rows.filter((x) => x.status === 'ok')) {
    const key = r.cat === 'VIP' || !r.org ? `${r.cat}#${r.line}` : `${r.cat}|${r.org}`;
    r.group = key;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, cat: r.cat, org: r.org, send: r.cat !== 'VIP', to: null, holders: [], referrer: '' }; groups.push(g); }
    for (const id of r.seats) g.holders.push({ seatId: id, label: seatText(info.find((s) => s.id === id)!), name: r.name });
    if (!g.to && r.email) g.to = { name: r.name, email: r.email };
    if (!g.referrer && r.referrer) g.referrer = r.referrer;
  }
  return {
    rows, groups,
    count: { ok: rows.filter((r) => r.status === 'ok').length, skip: rows.filter((r) => r.status === 'skip').length, err: rows.filter((r) => r.status === 'err').length,
      seats: groups.reduce((a, g) => a + g.holders.length, 0), groups: groups.length, mail: groups.filter((g) => g.send && g.to).length, noMail: groups.filter((g) => g.send && !g.to).length },
  };
}

/** 匯入：重新檢查後，只建立沒問題的列；一律不寄 */
export async function runImport(db: Db, actor: string, b64: string, now = new Date()) {
  const p = await previewImport(db, b64);
  if (!p.groups.length) throw new BookingError('INVALID', '沒有可以匯入的列');
  const cats = await getVipCats(db);
  const add = [...new Set(p.groups.map((g) => g.cat))].filter((c) => !cats.includes(c));
  if (add.length) await setVipCats(db, actor, [...cats, ...add].join('、'));
  const when = now.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16);
  const done: { key: string; orderNo: string; seats: number }[] = [];
  const failed: { key: string; label: string; reason: string }[] = [];
  for (const g of p.groups) {
    const first = g.to ?? { name: g.holders[0].name, email: '' };
    try {
      const r = await createVip(db, actor, {
        name: first.name, phone: '', email: first.email, seatIds: g.holders.map((h) => h.seatId), holders: g.holders.map((h) => h.name),
        mode: 'none', cat: g.cat, org: g.org, referrer: g.referrer, note: `${IMPORT_NOTE} ${when}`,
      });
      done.push({ key: g.key, orderNo: r.orderNo, seats: g.holders.length });
    } catch (e) {
      failed.push({ key: g.key, label: `${g.org || first.name}（${g.holders.map((h) => h.label).join('、')}）`, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  await db.insert(t.auditLog).values({ actor, action: 'vip_import', target: 'vip', detail: JSON.stringify({ groups: done.length, seats: done.reduce((a, x) => a + x.seats, 0), failed: failed.length, newCats: add }) });
  return { done, failed, newCats: add };
}

/** 匯入的、VIP 以外、有 Email、還沒寄過、寄送方式「不寄」的：等著按「寄出」 */
export async function pendingImportMails(db: Db) {
  const v = await listVips(db);
  return v.list.filter((x) => x.status === 'paid' && x.cat !== 'VIP' && x.note.startsWith(IMPORT_NOTE) && x.mode === 'none' && !x.sentAt && x.email)
    .map((x) => ({ id: x.id, name: x.name, email: x.email, org: x.org, cat: x.cat, seats: x.seats.length }));
}
/** 寄出：改成「立即寄」（實際寄送由呼叫端 deliver） */
export async function sendImportMails(db: Db, actor: string, ids: number[], base?: string) {
  const ok = new Set((await pendingImportMails(db)).map((x) => x.id));
  const go = ids.filter((id) => ok.has(id));
  for (const id of go) await setVipMode(db, actor, id, 'now', base);
  return go;
}

/** 座位貼名單：VIP 排、VIP 類別、尊榮席（票種名稱含「尊榮」），依座位排序 */
export async function stickerRows(db: Db) {
  const [ev] = await db.select().from(t.event).orderBy(t.event.id).limit(1);
  if (!ev) return [];
  const rows = await db.select({
    seatId: t.orderSeat.seatId, holder: t.orderSeat.holderName, rowNo: t.venueSeat.rowNo, seatNo: t.venueSeat.seatNo, seatType: t.venueSeat.seatType, x: t.venueSeat.x, y: t.venueSeat.y,
    vip: t.orders.vip, cat: t.orders.vipCat, org: t.orders.vipOrg, buyer: t.orders.buyerName, orderNo: t.orders.orderNo, zone: t.priceZone.name,
  }).from(t.orderSeat).innerJoin(t.orders, eq(t.orders.id, t.orderSeat.orderId)).innerJoin(t.venueSeat, eq(t.venueSeat.id, t.orderSeat.seatId))
    .innerJoin(t.eventSeat, and(eq(t.eventSeat.seatId, t.orderSeat.seatId), eq(t.eventSeat.eventId, ev.id))).innerJoin(t.priceZone, eq(t.priceZone.id, t.eventSeat.zoneId))
    .where(and(eq(t.orders.eventId, ev.id), eq(t.orders.status, 'paid')));
  return rows.filter((r) => r.seatType === 'vip' || (r.vip && r.cat === 'VIP') || /尊榮/.test(r.zone))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((r) => ({
      seat: seatText(r), name: r.holder ?? '', org: r.vip ? r.org : '', kind: r.vip ? (r.cat || '招待') : r.zone, buyer: r.vip ? '' : (r.buyer ?? ''), orderNo: r.orderNo ?? '',
    }));
}
