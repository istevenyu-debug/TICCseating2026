/**
 * 揪團贈票：不用註冊（11/13）。
 * 一條共用連結 /join：負責人第一次送出（或按「只建群」）就建立「群」；志工從清單點選群回報。
 * 群＝join_reg（已核准、群名放在 venue_text）。同名不同負責人手機 → 請加序號（台北大安2）。
 * 所有送出排隊一個一個處理，同時建同名群、同時報同一筆訂單都不會重複。
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import * as t from '@/db/schema';
import { BookingError } from './booking';
import { clean, email, ev0, getJoinSettings, mailHead, newCode, personName, phone, rateLimit } from './join';
import { deleteOwnReport, fixOwnReport, isLocked, reportPage, submitReport } from './joinQueue';

/* ---------- 一個一個處理 ---------- */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/* ---------- 群名 ---------- */
const half = (s: string) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
export const normGroupName = (s: string) => clean(half(String(s ?? '')));
/** 比對用：去空白、英文小寫 */
export const groupKey = (s: string) => normGroupName(s).replace(/\s/g, '').toLowerCase();
const stemOf = (name: string) => normGroupName(name).replace(/[-_ ]?\d+$/, '');
export const maskName = (n: string) => (n ? n[0] + '○'.repeat(Math.max(1, Math.min(2, n.length - 1))) : '');
const tail3 = (p: string) => p.slice(-3);

/** 下一個沒人用的序號名稱：台北大安 → 台北大安2、台北大安1 → 台北大安2 */
export function nextFreeName(name: string, taken: Set<string>) {
  const stem = stemOf(name);
  for (let i = 2; i < 1000; i++) { const n = `${stem}${i}`; if (!taken.has(groupKey(n))) return n; }
  return `${stem}${Date.now() % 10000}`;
}

type Reg = typeof t.joinReg.$inferSelect;
const nameOf = (r: Reg, vs: Map<number, string>) => (r.venueId ? vs.get(r.venueId) ?? r.venueText : r.venueText);

async function groupsOf(db: Db, eventId: number) {
  const regs = await db.select().from(t.joinReg).where(and(eq(t.joinReg.eventId, eventId), eq(t.joinReg.status, 'approved'))).orderBy(asc(t.joinReg.id));
  const vs = new Map((await db.select().from(t.joinVenue).where(eq(t.joinVenue.eventId, eventId))).map((v) => [v.id, v.name]));
  return regs.map((r) => ({ reg: r, name: nameOf(r, vs) }));
}

/** 公開頁：群清單（只有群名與遮蔽的負責人姓名）與開關 */
export async function groupMenu(db: Db, now = new Date()) {
  const ev = await ev0(db);
  const s = await getJoinSettings(db);
  const locked = await isLocked(db, ev.id);
  const gs = await groupsOf(db, ev.id);
  return {
    event: { name: ev.name, showAt: ev.showAt.toISOString() },
    reportOpen: s.reportOpen && !locked, createOpen: (s.open || s.reportOpen) && !locked, locked, contact: s.contact, perSeat: s.perSeat,
    today: now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }),
    groups: gs.map((g) => ({ id: g.reg.id, name: g.name, head: maskName(g.reg.headName) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
  };
}

const groupFields = z.object({
  name: z.string().transform(normGroupName).pipe(z.string().min(1, '請填寫群名稱').max(30, '群名稱最多 30 字')),
  headName: personName,
  headPhone: phone,
  email,
});
export const groupInput = z.object({
  groupId: z.number().int().positive().optional(),
  group: groupFields.optional(),
  createOnly: z.boolean().optional(),
  device: z.string().max(64).default(''),
  reporter: z.string().optional(),
  buyDate: z.string().optional(),
  rows: z.array(z.object({ orderNo: z.union([z.string(), z.number()]), qty: z.union([z.string(), z.number()]) })).optional(),
});

export type Clash = { name: string; head: string; phoneTail: string; suggest: string; mine: { id: number; name: string }[] };

/**
 * 共用連結送出：選好的群（groupId）或新群資料（group）＋訂單。
 * 新群：同名同手機＝同一群；同名不同手機＝回傳 clash（不存），請他改用序號或點選清單的群。
 */
export async function groupSubmit(db: Db, raw: unknown, ip = '', now = new Date(), base = '') {
  const p = groupInput.safeParse(raw);
  if (!p.success) throw new BookingError('INVALID', p.error.issues[0]?.message ?? '資料不完整');
  const x = p.data;
  if (!x.groupId && !x.group) throw new BookingError('INVALID', '請選擇要回報到哪一群，或建立新群');
  rateLimit(`dev:${x.device || ip}`, now.getTime(), 60);
  return serial(async () => {
    const ev = await ev0(db);
    const s = await getJoinSettings(db);
    if (await isLocked(db, ev.id)) throw new BookingError('SALE_CLOSED', `回報已經截止。有疑義請洽${s.contact}`);
    let reg: Reg | undefined;
    let created = false;
    const gs = await groupsOf(db, ev.id);
    if (x.groupId) {
      reg = gs.find((g) => g.reg.id === x.groupId)?.reg;
      if (!reg) throw new BookingError('NOT_FOUND', '找不到這個群（可能已改名或合併），請重新選擇');
    } else {
      const g = x.group!;
      const same = gs.find((y) => groupKey(y.name) === groupKey(g.name));
      if (same && same.reg.headPhone === g.headPhone) reg = same.reg;
      else if (same) {
        const taken = new Set(gs.map((y) => groupKey(y.name)));
        const stem = groupKey(stemOf(g.name));
        const clash: Clash = {
          name: same.name, head: maskName(same.reg.headName), phoneTail: tail3(same.reg.headPhone), suggest: nextFreeName(same.name, taken),
          mine: gs.filter((y) => y.reg.headPhone === g.headPhone && groupKey(y.name).startsWith(stem)).map((y) => ({ id: y.reg.id, name: y.name })),
        };
        return { clash };
      } else {
        if (!s.open && !s.reportOpen) throw new BookingError('SALE_CLOSED', '揪團回報目前尚未開放。');
        [reg] = await db.insert(t.joinReg).values({
          eventId: ev.id, venueId: null, venueText: g.name, headName: g.headName, headPhone: g.headPhone, email: g.email, ip,
          status: 'approved', reportCode: newCode(), pickCode: newCode(12), decidedAt: now, decidedBy: '自動（建群）', createdAt: now,
        }).returning();
        created = true;
        await db.insert(t.auditLog).values({ actor: 'public', action: 'join_group_create', target: `join_reg:${reg.id}`, detail: g.name });
        await mailHead(db, reg, 'join_group', `【${ev.name}】${g.headName} 您好，揪團群「${g.name}」已建立。`
          + `請把群名「${g.name}」告訴協助回報的志工：志工打開揪團回報連結${base ? `（${base}/join）` : ''}，點選「${g.name}」，填訂單編號後 4 碼與張數就可以回報。`
          + `每 ${s.perSeat} 張核對通過＝1 個劃位序；回報截止後，劃位連結會寄到這個信箱。${base ? `即時看板：${base}/join/board 。` : ''}有疑義請洽${s.contact}`);
      }
    }
    const group = { id: reg.id, name: gs.find((y) => y.reg.id === reg!.id)?.name ?? x.group?.name ?? '', head: maskName(reg.headName) };
    if (x.createOnly) return { group, created };
    if (!s.reportOpen) throw new BookingError('SALE_CLOSED', created ? `已建立「${group.name}」。回報還沒開放，開放後再填訂單。` : '回報目前沒有開放。');
    const res = await submitReport(db, reg.reportCode!, { reporter: x.reporter ?? '', buyDate: x.buyDate, rows: x.rows ?? [] }, ip, now, base, x.device);
    return { group, created, ...res };
  });
}

/** 公開頁：某一群的合計與回報紀錄（訂單只顯示後 4 碼；別支手機送的，志工名字遮蔽） */
export async function groupPage(db: Db, id: number, device = '') {
  const [reg] = await db.select().from(t.joinReg).where(and(eq(t.joinReg.id, Number(id) || 0), eq(t.joinReg.status, 'approved')));
  if (!reg?.reportCode) throw new BookingError('NOT_FOUND', '找不到這個群（可能已改名或合併），請重新選擇');
  const pg = await reportPage(db, reg.reportCode);
  const devs = new Map((await db.select({ id: t.joinReport.id, device: t.joinReport.device }).from(t.joinReport).where(eq(t.joinReport.regId, reg.id))).map((r) => [r.id, r.device]));
  return {
    ...pg, headName: maskName(reg.headName),
    list: pg.list.map((r) => {
      const mine = !!device && devs.get(r.id) === device;
      const no = r.orderNo ?? r.key;
      return { ...r, orderNo: mine ? r.orderNo : null, key: mine ? r.key : no.slice(-4), reporter: mine ? r.reporter : maskName(r.reporter), mine };
    }),
  };
}

async function ownByDevice(db: Db, groupId: number, reportId: number, device: string) {
  const [r] = await db.select().from(t.joinReport).where(and(eq(t.joinReport.id, Number(reportId) || 0), eq(t.joinReport.regId, Number(groupId) || 0)));
  if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
  if (!device || r.device !== device) throw new BookingError('FORBIDDEN', '只有送出這筆的手機可以修改。請聯絡負責人或主辦方。');
  const [reg] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, r.regId));
  return reg.reportCode!;
}
export async function groupDelete(db: Db, groupId: number, reportId: number, device: string, who = '') {
  return serial(async () => deleteOwnReport(db, await ownByDevice(db, groupId, reportId, device), reportId, who));
}
export async function groupFix(db: Db, groupId: number, reportId: number, device: string, full: string, who = '') {
  return serial(async () => fixOwnReport(db, await ownByDevice(db, groupId, reportId, device), reportId, full, who));
}

/* ---------- 後台：改群名、合併、移動回報 ---------- */

async function notLocked(db: Db, eventId: number) {
  if (await isLocked(db, eventId)) throw new BookingError('INVALID', '劃位序已鎖定，不能再改群。要改請先解除鎖定。');
}

export async function renameGroup(db: Db, actor: string, id: number, name: string) {
  const n = normGroupName(name);
  if (!n || n.length > 30) throw new BookingError('INVALID', '群名稱 1–30 字');
  return serial(async () => {
    const [r] = await db.select().from(t.joinReg).where(eq(t.joinReg.id, id));
    if (!r) throw new BookingError('NOT_FOUND', '找不到這個群');
    const gs = await groupsOf(db, r.eventId);
    const dup = gs.find((g) => g.reg.id !== id && groupKey(g.name) === groupKey(n));
    if (dup) throw new BookingError('INVALID', `「${dup.name}」已經有了。要合在一起請用「合併」。`);
    await db.update(t.joinReg).set({ venueId: null, venueText: n }).where(eq(t.joinReg.id, id));
    await db.insert(t.auditLog).values({ actor, action: 'join_group_rename', target: `join_reg:${id}`, detail: n });
    return true;
  });
}

/** 合併：from 的回報全部移到 into，from 變成「已退回（合併）」 */
export async function mergeGroups(db: Db, actor: string, fromId: number, intoId: number) {
  if (fromId === intoId) throw new BookingError('INVALID', '請選另一個群');
  return serial(async () => {
    const rs = await db.select().from(t.joinReg).where(inArray(t.joinReg.id, [fromId, intoId]));
    const from = rs.find((r) => r.id === fromId), into = rs.find((r) => r.id === intoId);
    if (!from || !into || into.status !== 'approved') throw new BookingError('NOT_FOUND', '找不到這個群');
    await notLocked(db, from.eventId);
    const moved = await db.update(t.joinReport).set({ regId: intoId }).where(eq(t.joinReport.regId, fromId)).returning({ id: t.joinReport.id });
    await db.update(t.joinReg).set({ status: 'rejected', reason: `已合併到第 ${intoId} 號` }).where(eq(t.joinReg.id, fromId));
    await db.insert(t.auditLog).values({ actor, action: 'join_group_merge', target: `join_reg:${fromId}`, detail: `→ ${intoId}（${moved.length} 筆回報）` });
    return { moved: moved.length };
  });
}

export async function moveReport(db: Db, actor: string, reportId: number, toId: number) {
  return serial(async () => {
    const [r] = await db.select().from(t.joinReport).where(eq(t.joinReport.id, reportId));
    if (!r) throw new BookingError('NOT_FOUND', '找不到這筆回報');
    await notLocked(db, r.eventId);
    const [to] = await db.select().from(t.joinReg).where(and(eq(t.joinReg.id, toId), eq(t.joinReg.status, 'approved')));
    if (!to) throw new BookingError('NOT_FOUND', '找不到這個群');
    await db.update(t.joinReport).set({ regId: toId }).where(eq(t.joinReport.id, reportId));
    await db.insert(t.auditLog).values({ actor, action: 'join_report_move', target: `join_report:${reportId}`, detail: `${r.regId} → ${toId}` });
    return true;
  });
}
