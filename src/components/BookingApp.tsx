'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookingState } from '@/lib/booking';
import { calcAmount, comboDesc, comboProblem, comboSets } from '@/lib/pricing';
import { autoHolders, phoneProblem } from '@/lib/validation';
import { bundleIndex } from '@/lib/bundle';
import PushCard from './PushCard';
import TicketQR from './TicketQR';
import SeatMap from './SeatMap';

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; code: string; message: string; detail: unknown };

/** 訪客代碼：公開連結用來區分不同的購票者（存在這台裝置的瀏覽器） */
let memVisitor = '';
function visitorId(): string {
  try {
    const v = localStorage.getItem('ticc_vid');
    if (v) return v;
  } catch { /* 無痕或封鎖儲存時改用記憶體 */ }
  if (!memVisitor) {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    memVisitor = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  try { localStorage.setItem('ticc_vid', memVisitor); } catch { /* 忽略 */ }
  return memVisitor;
}

async function api<T>(url: string, body?: unknown): Promise<ApiOk<T> | ApiErr> {
  try {
    const vid = visitorId();
    const res = await fetch(url, body === undefined
      ? { cache: 'no-store', headers: { 'x-visitor': vid } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-visitor': vid }, body: JSON.stringify(body) });
    return await res.json();
  } catch {
    return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。', detail: null };
  }
}

const money = (n: number) => `NT$${n.toLocaleString('en-US')}`;
/** 會在頁面最上方跳出的訊息 */
const ALERT: Record<string, { title: string; kind: 'ok' | 'err' }> = {
  order_confirmed: { title: '🎉 劃位成功！', kind: 'ok' },
  order_cancelled: { title: '訂單已取消', kind: 'err' },
  order_expired: { title: '訂單已逾期取消', kind: 'err' },
};
const STATUS_LABEL: Record<string, string> = { pending: '待確認到帳', paid: '劃位成功', cancelled: '已取消', expired: '逾時取消' };
const SALE_LABEL: Record<string, string> = { closed: '目前未開放訂購。', not_started: '尚未開始訂購。', ended: '訂購已截止。' };

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface Form {
  name: string; phone: string; email: string;
  holders: Record<string, { name: string; id4: string }>;
  idBase: string;
  last5: string; amount: string; time: string; agree: boolean;
}

export default function BookingApp({ code }: { code: string }) {
  const [st, setSt] = useState<BookingState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [combo, setCombo] = useState<number>(0); // 0 = 預設單張購票
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [lastOrder, setLastOrder] = useState<string | null>(null);
  const [review, setReview] = useState(false); // 送出前確認畫面
  const [, tick] = useState(0);
  const offset = useRef(0); // 伺服器時間 − 本機時間
  // 主辦方發來的重要訊息（劃位成功、取消）：看過的最大通知編號存在這支手機，未看過的顯示在頁面最上方
  const seenKey = `ticc-seen-${code}`;
  const [seen, setSeen] = useState<number>(() => { try { return Number(localStorage.getItem(seenKey)) || 0; } catch { return 0; } });

  const load = useCallback(async () => {
    const r = await api<BookingState>(`/api/t/${encodeURIComponent(code)}/state`);
    if (!r.ok) {
      if (['LINK_NOT_FOUND', 'LINK_DISABLED', 'LINK_EXPIRED'].includes(r.code)) setFatal(r.message);
      else setMsg({ kind: 'err', text: r.message });
      return null;
    }
    offset.current = Date.parse(r.data.now) - Date.now();
    setSt(r.data);
    return r.data;
  }, [code]);

  useEffect(() => { load(); }, [load]);

  const held = st?.held ?? null;

  // 暫存狀態同步：有暫存時以伺服器的座位為準
  useEffect(() => {
    if (!st) return;
    if (held) {
      setSel(new Set(held.seatIds));
      setCombo(held.comboId);
      setForm((f) => f ?? {
        name: st.link.name, phone: '', email: '', idBase: '',
        holders: Object.fromEntries(held.seatIds.map((id, i) => [id, { name: i === 0 ? st.link.name : '', id4: '' }])),
        last5: '', amount: String(held.amount), time: '', agree: false,
      });
    } else {
      setForm(null);
      // 移除已被他人取走的勾選
      setSel((prev) => {
        const free = new Set(st.seats.filter((s) => s.status === 'free').map((s) => s.id));
        const next = new Set([...prev].filter((id) => free.has(id)));
        return next.size === prev.size ? prev : next;
      });
    }
  }, [st, held]);

  // 輪詢座位狀態；暫存中每秒更新倒數
  useEffect(() => {
    const poll = setInterval(load, held ? 30_000 : 10_000);
    const t = held ? setInterval(() => tick((n) => n + 1), 1000) : undefined;
    return () => { clearInterval(poll); if (t) clearInterval(t); };
  }, [load, held]);

  const remain = held ? Date.parse(held.holdUntil) - (Date.now() + offset.current) : 0;
  useEffect(() => {
    if (held && remain <= 0) {
      setMsg({ kind: 'err', text: `暫存已超過 ${st?.event.holdMinutes ?? 20} 分鐘，座位已釋放，請重新選位。` });
      setSel(new Set());
      load();
    }
  }, [held, remain <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const alerts = (st?.inbox ?? []).filter((n) => n.id > seen && ALERT[n.template]);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = alerts.length ? `(${alerts.length}) ${base}` : base;
  }, [alerts.length]);
  const markSeen = () => {
    const max = Math.max(seen, ...(st?.inbox ?? []).map((n) => n.id));
    setSeen(max);
    try { localStorage.setItem(seenKey, String(max)); } catch { /* 無痕模式 */ }
  };

  const seatById = useMemo(() => Object.fromEntries((st?.seats ?? []).map((s) => [s.id, s])), [st]);
  const zoneBy = useMemo(() => Object.fromEntries((st?.zones ?? []).map((z) => [z.id, z])), [st]);

  if (fatal) {
    return <main className="wrap"><div className="card"><h1>無法開啟購票頁</h1><p className="note err">{fatal}</p></div></main>;
  }
  if (!st) return <main className="wrap"><div className="card muted">座位載入中…</div></main>;

  const ids = [...sel].filter((id) => seatById[id]);
  const zonesSel = ids.map((id) => seatById[id].zoneId);
  const prices = zonesSel.map((z) => zoneBy[z]?.price ?? 0);
  const zoneName = (id: number) => zoneBy[id]?.name ?? '未開放票種';
  const cur = st.combos.find((c) => c.id === combo) ?? st.combos.find((c) => c.isSingle) ?? st.combos[0];
  const giftZones = new Set(st.zones.filter((z) => z.price === 0).map((z) => z.id));
  const curProblem = cur ? comboProblem(cur, zonesSel, cur.usedSets, zoneName, giftZones) : '目前沒有開放的購票方式';
  const sets = cur && !cur.isSingle ? comboSets(cur, zonesSel) : 1;
  const amount = held ? held.amount : cur ? calcAmount(prices, cur, sets) : 0;
  const open = st.sale === 'open';
  // 先選購票方式：只開放這個方式用得到的票種座位（單張購票不含贈票）
  const allowed = new Set(cur && !cur.isSingle ? cur.items.map((i) => i.zoneId) : st.zones.filter((z) => !giftZones.has(z.id)).map((z) => z.id));
  const need = cur && !cur.isSingle ? (() => {
    const cnt = (z: number) => zonesSel.filter((x) => x === z).length;
    const want = Math.max(1, ...cur.items.map((i) => Math.ceil(cnt(i.zoneId) / i.qty)));
    return cur.items.map((i) => ({ name: zoneName(i.zoneId), have: cnt(i.zoneId), want: i.qty * want }));
  })() : null;
  const pickCombo = (id: number) => {
    setCombo(id); setMsg(null);
    const c = st.combos.find((x) => x.id === id);
    const ok = new Set(c && !c.isSingle ? c.items.map((i) => i.zoneId) : st.zones.filter((z) => !giftZones.has(z.id)).map((z) => z.id));
    setSel((p) => new Set([...p].filter((sid) => seatById[sid] && ok.has(seatById[sid].zoneId))));
  };
  const heldAuto = !!held && !!st.combos.find((c) => c.id === held.comboId)?.autoHolders;
  const autoList = held && form && heldAuto ? autoHolders(form.name, form.idBase, held.seatIds.length) : [];

  const bidx = bundleIndex(st.seats);
  function toggle(id: string) {
    setMsg(null);
    const members = bidx.membersOf(id, seatById[id]?.bundle); // 連座：整組一起選或取消
    setSel((prev) => {
      const next = new Set(prev);
      if (members.some((m) => next.has(m))) { members.forEach((m) => next.delete(m)); return next; }
      if (members.some((m) => seatById[m]?.status !== 'free')) {
        setMsg({ kind: 'err', text: '這組連座中有座位已被訂走，請改選其他座位。' });
        return prev;
      }
      if (next.size + members.length > st!.canBuy) {
        setMsg({ kind: 'err', text: st!.canBuy > 0 ? `此連結最多可再訂 ${st!.canBuy} 張${members.length > 1 ? `（這組連座為 ${members.length} 位）` : ''}。` : '此連結的可訂張數已用完。' });
        return prev;
      }
      members.forEach((m) => next.add(m));
      return next;
    });
  }

  async function doHold() {
    setBusy(true); setMsg(null);
    const r = await api<{ orderId: number }>(`/api/t/${code}/hold`, { seatIds: ids, comboId: cur?.id });
    setBusy(false);
    if (!r.ok) {
      if (r.code === 'SEAT_TAKEN' && Array.isArray(r.detail)) {
        const gone = new Set(r.detail as string[]);
        setSel((p) => new Set([...p].filter((x) => !gone.has(x))));
      }
      setMsg({ kind: 'err', text: r.message });
    }
    await load();
  }

  async function doRelease() {
    setBusy(true);
    await api(`/api/t/${code}/release`, {});
    setBusy(false); setSel(new Set()); setCombo(0); setForm(null); setMsg(null);
    await load();
  }

  /** 按「送出」：先檢查，再顯示確認畫面 */
  function doReview(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !held) return;
    const bad = (text: string, id: string) => { setMsg({ kind: 'err', text }); document.getElementById(id)?.focus(); };
    if (!form.name.trim()) return bad('請填寫購票人姓名', 'b-name');
    const pp = form.phone.trim() ? phoneProblem(form.phone) : '請填寫手機';
    if (pp) return bad(pp, 'b-phone');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return bad('Email 格式不正確，劃位成功與入場 QR code 會寄到這個信箱', 'b-email');
    if (heldAuto && !/^[0-9A-Za-z]{4}$/.test(form.idBase.trim())) return bad('請填寫購票人身分證末 4 碼（4 個英數字）', 'b-idbase');
    if (!heldAuto) {
      for (const id of held.seatIds) {
        const h = form.holders[id];
        if (!h?.name.trim()) return bad(`請填寫 ${seatById[id]?.label ?? id} 的持票人姓名`, `h-n-${id}`);
        if (!/^[0-9A-Za-z]{4}$/.test(h.id4.trim())) return bad(`${seatById[id]?.label ?? id} 的身分證末 4 碼應為 4 個英數字`, `h-i-${id}`);
      }
    }
    if (!st!.event.payFirst) {
      if (!/^\d{5}$/.test(form.last5.trim())) return bad('匯款帳號末 5 碼應為 5 位數字', 't-last5');
      if (!form.time) return bad('請填寫匯款時間', 't-time');
    }
    if (!form.agree) return bad('請勾選同意個資蒐集', 't-agree');
    setMsg(null); setReview(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function doSubmit() {
    if (!form || !held) return;
    setBusy(true); setMsg(null);
    const r = await api<{ orderNo: string; amountMismatch: boolean }>(`/api/t/${code}/submit`, {
      orderId: held.orderId,
      buyer: { name: form.name, phone: form.phone, email: form.email },
      holders: heldAuto
        ? held.seatIds.map((id, i) => ({ seatId: id, ...autoList[i] }))
        : held.seatIds.map((id) => ({ seatId: id, ...form.holders[id] })),
      ...(heldAuto ? { idBase: form.idBase.trim().toUpperCase() } : {}),
      ...(st!.event.payFirst ? {} : { transfer: { last5: form.last5, amount: Number(form.amount.replace(/[^\d]/g, '')) || 0, time: form.time.replace('T', ' ') } }),
      agree: form.agree,
    });
    setBusy(false);
    if (!r.ok) { setReview(false); setMsg({ kind: 'err', text: r.message }); if (r.code.startsWith('HOLD')) await load(); return; }
    setLastOrder(r.data.orderNo); setReview(false);
    setMsg({ kind: 'ok', text: st!.event.payFirst
      ? `劃位資料已送出（訂單 ${r.data.orderNo}）。主辦方確認後，會寄出劃位成功通知與入場 QR code 到 ${form.email.trim()}。`
      : `訂購資料已送出（訂單 ${r.data.orderNo}）。主辦方確認到帳後，會以簡訊及 Email 通知劃位結果。${r.data.amountMismatch ? '提醒：您填寫的匯款金額與應付金額不同，主辦方會再與您確認。' : ''}` });
    setSel(new Set()); setCombo(0); setForm(null);
    await load();
  }

  const upd = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const updHolder = (id: string, patch: Partial<{ name: string; id4: string }>) =>
    setForm((f) => (f ? { ...f, holders: { ...f.holders, [id]: { ...f.holders[id], ...patch } } } : f));

  return (
    <main className="wrap">
      <div className="card">
        <h1>{st.event.name}</h1>
        <div className="muted">{fmtDate(st.event.showAt)}・台北國際會議中心 大會堂</div>
        <div className="small" style={{ marginTop: 6 }}>
          {st.link.kind === 'public'
            ? <>歡迎訂購。每筆訂單最多 <b>{st.event.maxPerOrder}</b> 張{st.link.perPhone ? `，每支手機最多 ${st.link.perPhone} 張` : ''}。</>
            : <>{st.link.name} 您好，{st.link.quota ? <>此專屬連結可訂購 <b>{st.link.quota}</b> 張（已訂 {st.link.used} 張）</> : <>此專屬連結張數不限（每筆最多 {st.event.maxPerOrder} 張）</>}，有效至 {fmtDate(st.link.expiresAt)}。</>}
        </div>
      </div>
      {alerts.length > 0 && (() => {
        const n = alerts[0];
        const a = ALERT[n.template];
        return (
          <div className={`alertbox ${a.kind}`} role="alert">
            <div className="alertbox-title">{a.title}</div>
            <div className="small">{n.content}</div>
            {alerts.length > 1 && <div className="small muted">另有 {alerts.length - 1} 則新訊息，見下方「我收到的通知」。</div>}
            <div className="row" style={{ marginTop: 10 }}>
              {a.kind === 'ok' && <button className="btn pri" onClick={() => { markSeen(); document.getElementById('my-orders')?.scrollIntoView({ behavior: 'smooth' }); }}>查看入場 QR code</button>}
              <button className="btn" onClick={markSeen}>知道了</button>
            </div>
          </div>
        );
      })()}
      {(st.orders.some((o) => o.status === 'pending') || !!held) && <PushCard code={code} api={api} compact={false} />}
      {!open && <div className="note err">{st.sale === 'not_started' && st.startsAt ? `尚未開始訂購，將於 ${fmtDate(st.startsAt)} 開放。現在可以先看座位。` : SALE_LABEL[st.sale]}</div>}

      {!held && (
        <div className="card">
          <h2>第一步：選擇購票方式</h2>
          <div className="combos">
            {st.combos.map((c) => {
              const soldOut = c.limitSets > 0 && c.usedSets >= c.limitSets;
              const desc = c.isSingle ? '依各票種票價計算'
                : `每組 ${comboDesc(c, zoneName)}・套票價 ${money(c.price)}${c.limitSets ? `・限量 ${c.limitSets} 組（剩 ${Math.max(0, c.limitSets - c.usedSets)}）` : ''}`;
              return (
                <label key={c.id} className={`combo${soldOut ? ' dis' : ''}`}>
                  <input type="radio" name="combo" value={c.id} checked={cur?.id === c.id} disabled={soldOut} onChange={() => pickCombo(c.id)} />
                  <span><b>{c.name}</b><br /><span className="small muted">{desc}{soldOut ? '｜已售完' : ''}</span></span>
                </label>
              );
            })}
          </div>
          {need && <p className="small" style={{ margin: '8px 0 0' }}>第二步：在座位圖上選 {need.map((n) => `${n.name} ${n.want} 位`).join('＋')}（目前 {need.map((n) => `${n.name} ${n.have}/${n.want}`).join('、')}）。連座按一下會選整組。可以選多組。</p>}
          {cur?.isSingle && <p className="small muted" style={{ margin: '8px 0 0' }}>第二步：在座位圖上點選座位。</p>}
        </div>
      )}

      <div className="grid2">
        <SeatMap seats={st.seats} zones={st.zones} vipInstalled={st.event.vipInstalled} selected={sel} onToggle={toggle} locked={!!held || !open}
          allowed={held ? undefined : allowed} />

        <div className="side">
          {msg && <div className={`note ${msg.kind}`} role="status">{msg.text}</div>}

          {!held && (
            <div className="card">
              <h2>已選座位 <span className="small muted">{ids.length} / {st.canBuy} 張</span></h2>
              {ids.length ? (
                <div className="sellist">
                  {ids.map((id) => (
                    <div className="selitem" key={id}>
                      <span>{seatById[id].label} <span className="mono small muted">{seatById[id].code}</span> <span className="muted small">{zoneBy[seatById[id].zoneId]?.name}</span></span>
                      <span className="row">
                        <span className="mono small">{money(zoneBy[seatById[id].zoneId]?.price ?? 0)}</span>
                        <button aria-label={`取消 ${seatById[id].label}`} onClick={() => toggle(id)}>×</button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">先在上方選購票方式，再在座位圖上按一下勾選座位（出現紅框），再按一下取消。可選的座位會亮起，其他座位變淡。</p>
              )}
              <h3>{cur?.name}</h3>
              <div className="total">
                <span className="muted">
                  {cur && !cur.isSingle && ids.length ? <>原價 {money(prices.reduce((a, b) => a + b, 0))}{sets > 0 ? <>　{cur.name} {sets} 組 × {money(cur.price)}</> : ''}<br /></> : ''}應付金額
                </span>
                <b>{money(ids.length && (cur?.isSingle || sets > 0) ? amount : 0)}</b>
              </div>
              {ids.length > 0 && curProblem && <div className="note err" style={{ marginTop: 8 }}>還不能暫存：{curProblem}</div>}
              {!open && <div className="note err" style={{ marginTop: 8 }}>目前不能訂購，請見頁面上方說明。</div>}
              <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={!open || busy || !ids.length || !!curProblem} onClick={doHold}>
                {busy ? '處理中…' : `暫存座位（保留 ${st.event.holdMinutes} 分鐘）`}
              </button>
            </div>
          )}

          {held && form && (
            <div className="card">
              <h2>座位暫存中 <span className="timer">{mmss(remain)}</span></h2>
              <p className="small muted" style={{ margin: '0 0 8px' }}>{st.event.payFirst ? '請在時間內填好資料並送出，逾時座位會自動釋放。' : '請在時間內完成匯款並送出資料，逾時座位會自動釋放。'}</p>
              <div className="sellist">
                {held.seatIds.map((id) => (
                  <div className="selitem" key={id}><span>{seatById[id]?.label ?? id} <span className="mono small muted">{seatById[id]?.code}</span></span><span className="small muted">{zoneBy[seatById[id]?.zoneId]?.name}</span></div>
                ))}
              </div>
              <div className="total"><span className="muted">{st.combos.find((c) => c.id === held.comboId)?.name}</span><b>{money(held.amount)}</b></div>

              {!st.event.payFirst && <>
              <h3>匯款帳戶</h3>
              <div className="bank">
                <span className="muted">銀行</span><span>{st.event.bankName}</span>
                <span className="muted">帳號</span><span className="mono">{st.event.bankAccount}</span>
                <span className="muted">戶名</span><span>{st.event.accountName}</span>
                <span className="muted">金額</span><span className="mono">{money(held.amount)}</span>
              </div>
              <button className="btn small" type="button" style={{ marginTop: 6 }}
                onClick={() => navigator.clipboard?.writeText(st.event.bankAccount.replace(/-/g, '')).then(() => setMsg({ kind: 'ok', text: '已複製帳號' }), () => undefined)}>
                複製帳號
              </button>
              </>}

              {review && (
                <div className="review">
                  <h3>請確認您的資料</h3>
                  <p className="small" style={{ margin: '0 0 8px' }}>送出後就不能自行修改。劃位成功通知與入場 QR code 會寄到下面的 Email，請確認正確。</p>
                  <div className="bank">
                    <span className="muted">姓名</span><span><b>{form.name.trim()}</b></span>
                    <span className="muted">手機</span><span className="mono"><b>{form.phone.replace(/\D/g, '').replace(/^(\d{4})(\d{3})(\d{3})$/, '$1-$2-$3')}</b></span>
                    <span className="muted">Email</span><span className="mono"><b>{form.email.trim()}</b></span>
                    <span className="muted">購票方式</span><span>{st.combos.find((c) => c.id === held.comboId)?.name}・{money(held.amount)}</span>
                  </div>
                  <h3>座位與持票人（{held.seatIds.length} 張）</h3>
                  <div className="sellist">
                    {held.seatIds.map((id, i) => {
                      const h = heldAuto ? autoList[i] : form.holders[id];
                      return <div className="selitem" key={id}><span>{seatById[id]?.label ?? id} <span className="mono small muted">{seatById[id]?.code}</span></span><span className="small">{h?.name}・{(h?.id4 ?? '').toUpperCase()}</span></div>;
                    })}
                  </div>
                  {msg?.kind === 'err' && <div className="note err" style={{ marginTop: 10 }}>{msg.text}</div>}
                  <div className="row" style={{ marginTop: 12 }}>
                    <button className="btn pri" style={{ flex: 1 }} disabled={busy} onClick={doSubmit}>{busy ? '送出中…' : '資料正確，確認送出'}</button>
                    <button className="btn" disabled={busy} onClick={() => setReview(false)}>返回修改</button>
                  </div>
                </div>
              )}

              <form onSubmit={doReview} noValidate style={review ? { display: 'none' } : undefined}>
                <h3>購票人資料</h3>
                <div className="fields">
                  <label className="f">姓名<input id="b-name" value={form.name} onChange={(e) => upd({ name: e.target.value })} autoComplete="name" /></label>
                  <label className="f">手機<input id="b-phone" value={form.phone} maxLength={13} aria-invalid={!!phoneProblem(form.phone)} style={phoneProblem(form.phone) ? { borderColor: 'var(--red)' } : undefined}
                    onChange={(e) => upd({ phone: e.target.value })} inputMode="tel" placeholder={st.link.kind === 'public' ? '09xxxxxxxx' : `09xxxxx${st.link.phoneTail}`} autoComplete="tel" />
                    {phoneProblem(form.phone) && <span className="small" style={{ color: 'var(--red)' }}>{phoneProblem(form.phone)}</span>}</label>
                </div>
                <label className="f" style={{ marginTop: 8 }}>Email<input id="b-email" type="email" value={form.email} onChange={(e) => upd({ email: e.target.value })} autoComplete="email" /></label>

                <h3>持票人實名（每張一位）</h3>
                {heldAuto ? (
                  <>
                    <label className="f">購票人身分證末 4 碼<input id="b-idbase" value={form.idBase} maxLength={4} autoCapitalize="characters" onChange={(e) => upd({ idBase: e.target.value })} /></label>
                    <p className="small muted" style={{ margin: '6px 0' }}>此購票方式的持票人由系統自動編號：第 1 張為購票人本名，之後依序為「姓名02、姓名03…」，證號為末 4 碼加序號。</p>
                    <div className="sellist">
                      {held.seatIds.map((id, i) => (
                        <div className="selitem" key={id}>
                          <span>{seatById[id]?.label ?? id}</span>
                          <span className="mono small">{autoList[i]?.name || '（請先填姓名）'}・{form.idBase.trim().length === 4 ? autoList[i]?.id4 : '（請填證末 4 碼）'}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : held.seatIds.map((id) => (
                  <div className="fields" key={id} style={{ marginBottom: 6 }}>
                    <label className="f">{seatById[id]?.label ?? id} 姓名<input id={`h-n-${id}`} value={form.holders[id]?.name ?? ''} onChange={(e) => updHolder(id, { name: e.target.value })} /></label>
                    <label className="f">身分證末 4 碼<input id={`h-i-${id}`} value={form.holders[id]?.id4 ?? ''} maxLength={4} onChange={(e) => updHolder(id, { id4: e.target.value })} /></label>
                  </div>
                ))}

                {!st.event.payFirst && <>
                <h3>匯款資訊</h3>
                <div className="fields">
                  <label className="f">匯出帳號末 5 碼<input id="t-last5" value={form.last5} maxLength={5} inputMode="numeric" onChange={(e) => upd({ last5: e.target.value })} /></label>
                  <label className="f">匯款金額<input id="t-amt" value={form.amount} inputMode="numeric" onChange={(e) => upd({ amount: e.target.value })} /></label>
                </div>
                <label className="f" style={{ marginTop: 8 }}>匯款時間<input id="t-time" type="datetime-local" value={form.time} onChange={(e) => upd({ time: e.target.value })} /></label>
                </>}
                <label className="check" style={{ marginTop: 10 }}>
                  <input id="t-agree" type="checkbox" checked={form.agree} onChange={(e) => upd({ agree: e.target.checked })} />
                  我同意主辦方為售票及實名入場核對之目的，蒐集與處理上述個人資料。
                </label>
                {msg?.kind === 'err' && <div className="note err" style={{ marginTop: 10 }}>{msg.text}</div>}
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn pri" type="submit" style={{ flex: 1 }} disabled={busy}>下一步：確認資料</button>
                  <button className="btn" type="button" disabled={busy} onClick={doRelease}>放棄座位</button>
                </div>
              </form>
            </div>
          )}

          <div className="card" id="my-orders">
            <h2>我的訂單</h2>
            {st.orders.length ? st.orders.map((o) => (
              <div key={o.orderNo} className="note" style={{ marginBottom: 6, outline: o.orderNo === lastOrder ? '1px solid var(--ok)' : undefined }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b className="mono">{o.orderNo}</b><span className={`pill p-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
                </div>
                <div className="small">{o.comboName}{o.sets > 1 ? ` ${o.sets} 組` : ''}・{money(o.amount)}{o.status === 'pending' ? (st.event.payFirst ? '・主辦方確認後會寄出劃位成功通知與 QR code' : o.payDueAt ? `・請於 ${fmtDate(o.payDueAt)} 前完成匯款確認` : '') : ''}</div>
                {o.status !== 'paid' && <div className="small">{o.seats.map((s) => `${s.label}（${s.code}）`).join('、')}</div>}
                {o.status === 'paid' && (
                  <div className="eticket">
                    <div className="small"><b>劃位成功</b>。入場時請出示下方 QR code 與身分證件。</div>
                    <div className="small muted">購票人：{o.buyerName}・{o.buyerPhone}・{o.buyerEmail}</div>
                    {o.seats.map((s) => (
                      <div key={s.code} className="etk">
                        {s.serial && <TicketQR serial={s.serial} size={104} />}
                        <div className="small">
                          <div className="etk-seat">{s.label}</div>
                          <div className="mono">座位編號 {s.code}</div>
                          <div>{s.zoneName}</div>
                          <div>持票人 {s.holder}（{(s.holderId4 ?? '').length > 4 ? '證號' : '證末4碼'} {s.holderId4}）</div>
                          <div className="mono muted">序號 {s.serial}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )) : <p className="small muted" style={{ margin: 0 }}>尚無訂單。送出訂購資料後會顯示在這裡。</p>}
          </div>

          <div className="card">
            <h2>我收到的通知</h2>
            {st.inbox.length ? st.inbox.map((n, i) => (
              <div key={i} className="note" style={{ marginBottom: 6 }}>
                <div className="small muted">{fmtDate(n.at)}</div>
                <div className="small">{n.content}</div>
              </div>
            )) : <p className="small muted" style={{ margin: 0 }}>尚無通知。主辦方確認到帳後，劃位成功訊息會出現在這裡，同時以簡訊及 Email 寄給您。</p>}
          </div>
        </div>
      </div>
    </main>
  );
}
