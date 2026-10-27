'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookingState } from '@/lib/booking';
import { calcAmount, comboDesc, comboProblem } from '@/lib/pricing';
import SeatMap from './SeatMap';

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; code: string; message: string; detail: unknown };

async function api<T>(url: string, body?: unknown): Promise<ApiOk<T> | ApiErr> {
  try {
    const res = await fetch(url, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch {
    return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。', detail: null };
  }
}

const money = (n: number) => `NT$${n.toLocaleString('en-US')}`;
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
  const [, tick] = useState(0);
  const offset = useRef(0); // 伺服器時間 − 本機時間

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
        name: st.link.name, phone: '', email: '',
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
  const curProblem = cur ? comboProblem(cur, zonesSel, cur.usedSets, zoneName) : '目前沒有開放的購票方式';
  const amount = held ? held.amount : cur ? calcAmount(prices, cur) : 0;
  const open = st.sale === 'open';

  function toggle(id: string) {
    setMsg(null);
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= st!.canBuy) {
        setMsg({ kind: 'err', text: st!.canBuy > 0 ? `此連結最多可再訂 ${st!.canBuy} 張。` : '此連結的可訂張數已用完。' });
        return prev;
      } else next.add(id);
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

  async function doSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !held) return;
    setBusy(true); setMsg(null);
    const r = await api<{ orderNo: string; amountMismatch: boolean }>(`/api/t/${code}/submit`, {
      orderId: held.orderId,
      buyer: { name: form.name, phone: form.phone, email: form.email },
      holders: held.seatIds.map((id) => ({ seatId: id, ...form.holders[id] })),
      transfer: { last5: form.last5, amount: Number(form.amount.replace(/[^\d]/g, '')) || 0, time: form.time.replace('T', ' ') },
      agree: form.agree,
    });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: 'err', text: r.message }); if (r.code.startsWith('HOLD')) await load(); return; }
    setLastOrder(r.data.orderNo);
    setMsg({ kind: 'ok', text: `訂購資料已送出（訂單 ${r.data.orderNo}）。主辦方確認到帳後，會以簡訊及 Email 通知劃位結果。${r.data.amountMismatch ? '提醒：您填寫的匯款金額與應付金額不同，主辦方會再與您確認。' : ''}` });
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
          {st.link.name} 您好，此專屬連結可訂購 <b>{st.link.quota}</b> 張（已訂 {st.link.used} 張），有效至 {fmtDate(st.link.expiresAt)}。
        </div>
      </div>
      {!open && <div className="note err">{SALE_LABEL[st.sale]}</div>}

      <div className="grid2">
        <SeatMap seats={st.seats} zones={st.zones} vipInstalled={st.event.vipInstalled} selected={sel} onToggle={toggle} locked={!!held || !open} />

        <div className="side">
          {msg && <div className={`note ${msg.kind}`} role="status">{msg.text}</div>}

          {!held && (
            <div className="card">
              <h2>已勾選座位 <span className="small muted">{ids.length} / {st.canBuy} 張</span></h2>
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
                <p className="small muted">在座位圖上按一下勾選座位（出現紅框），再按一下取消。</p>
              )}
              <h3>購票方式</h3>
              <div className="combos">
                {st.combos.map((c) => {
                  const why = comboProblem(c, zonesSel, c.usedSets, zoneName);
                  const dis = !!why && ids.length > 0;
                  const desc = c.isSingle ? '依各票種票價計算'
                    : `${comboDesc(c, zoneName)}・套票價 ${money(c.price)}${c.limitSets ? `・限量 ${c.limitSets} 組（剩 ${Math.max(0, c.limitSets - c.usedSets)}）` : ''}`;
                  return (
                    <label key={c.id} className={`combo${dis ? ' dis' : ''}`}>
                      <input type="radio" name="combo" value={c.id} checked={cur?.id === c.id} disabled={dis} onChange={() => setCombo(c.id)} />
                      <span><b>{c.name}</b><br /><span className="small muted">{desc}{dis ? `｜${why}` : ''}</span></span>
                    </label>
                  );
                })}
              </div>
              <div className="total">
                <span className="muted">{cur && !cur.isSingle && ids.length ? `原價 ${money(prices.reduce((a, b) => a + b, 0))}　` : ''}應付金額</span>
                <b>{money(ids.length ? amount : 0)}</b>
              </div>
              <button className="btn pri" style={{ width: '100%', marginTop: 10 }} disabled={!open || busy || !ids.length || !!curProblem} onClick={doHold}>
                {busy ? '處理中…' : `暫存座位（保留 ${st.event.holdMinutes} 分鐘）`}
              </button>
            </div>
          )}

          {held && form && (
            <div className="card">
              <h2>座位暫存中 <span className="timer">{mmss(remain)}</span></h2>
              <p className="small muted" style={{ margin: '0 0 8px' }}>請在時間內完成匯款並送出資料，逾時座位會自動釋放。</p>
              <div className="sellist">
                {held.seatIds.map((id) => (
                  <div className="selitem" key={id}><span>{seatById[id]?.label ?? id} <span className="mono small muted">{seatById[id]?.code}</span></span><span className="small muted">{zoneBy[seatById[id]?.zoneId]?.name}</span></div>
                ))}
              </div>
              <div className="total"><span className="muted">{st.combos.find((c) => c.id === held.comboId)?.name}</span><b>{money(held.amount)}</b></div>

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

              <form onSubmit={doSubmit} noValidate>
                <h3>購票人資料</h3>
                <div className="fields">
                  <label className="f">姓名<input id="b-name" value={form.name} onChange={(e) => upd({ name: e.target.value })} autoComplete="name" /></label>
                  <label className="f">手機<input id="b-phone" value={form.phone} onChange={(e) => upd({ phone: e.target.value })} inputMode="tel" placeholder={`09xxxxx${st.link.phoneTail}`} autoComplete="tel" /></label>
                </div>
                <label className="f" style={{ marginTop: 8 }}>Email<input id="b-email" type="email" value={form.email} onChange={(e) => upd({ email: e.target.value })} autoComplete="email" /></label>

                <h3>持票人實名（每張一位）</h3>
                {held.seatIds.map((id) => (
                  <div className="fields" key={id} style={{ marginBottom: 6 }}>
                    <label className="f">{seatById[id]?.label ?? id} 姓名<input id={`h-n-${id}`} value={form.holders[id]?.name ?? ''} onChange={(e) => updHolder(id, { name: e.target.value })} /></label>
                    <label className="f">身分證末 4 碼<input id={`h-i-${id}`} value={form.holders[id]?.id4 ?? ''} maxLength={4} onChange={(e) => updHolder(id, { id4: e.target.value })} /></label>
                  </div>
                ))}

                <h3>匯款資訊</h3>
                <div className="fields">
                  <label className="f">匯出帳號末 5 碼<input id="t-last5" value={form.last5} maxLength={5} inputMode="numeric" onChange={(e) => upd({ last5: e.target.value })} /></label>
                  <label className="f">匯款金額<input id="t-amt" value={form.amount} inputMode="numeric" onChange={(e) => upd({ amount: e.target.value })} /></label>
                </div>
                <label className="f" style={{ marginTop: 8 }}>匯款時間<input id="t-time" type="datetime-local" value={form.time} onChange={(e) => upd({ time: e.target.value })} /></label>
                <label className="check" style={{ marginTop: 10 }}>
                  <input id="t-agree" type="checkbox" checked={form.agree} onChange={(e) => upd({ agree: e.target.checked })} />
                  我同意主辦方為售票及實名入場核對之目的，蒐集與處理上述個人資料。
                </label>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn pri" type="submit" style={{ flex: 1 }} disabled={busy}>{busy ? '送出中…' : '送出訂購資料'}</button>
                  <button className="btn" type="button" disabled={busy} onClick={doRelease}>放棄座位</button>
                </div>
              </form>
            </div>
          )}

          <div className="card">
            <h2>我的訂單</h2>
            {st.orders.length ? st.orders.map((o) => (
              <div key={o.orderNo} className="note" style={{ marginBottom: 6, outline: o.orderNo === lastOrder ? '1px solid var(--ok)' : undefined }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b className="mono">{o.orderNo}</b><span className={`pill p-${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
                </div>
                <div className="small">{o.seats.map((s) => `${s.label}（${s.code}）`).join('、')}</div>
                <div className="small muted">
                  {money(o.amount)}{o.status === 'pending' && o.payDueAt ? `・請於 ${fmtDate(o.payDueAt)} 前完成匯款確認` : ''}
                </div>
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
