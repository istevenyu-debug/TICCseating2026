'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtDate } from './JoinApp';
import SeatMap from './SeatMap';

type MapProps = Parameters<typeof SeatMap>[0];
type Line = { k: string; at: string; group: string; qty: number; orders: number; ok: number; pending: number; bad: number; total: number; nos: number[]; cnt?: number };
type Board = {
  event: { name: string; showAt: string }; now: string; reportOpen: boolean; locked: boolean; auto?: boolean; started?: boolean; round?: number; perSeat: number; contact: string;
  stats: { groups: number; verified: number; pending: number; slots: number; giftSeats: number; giftFree: number; canGive?: number };
  era?: { sold: number; cap: number; left: number; at: string | null };
  feed: Line[]; more: boolean;
  order: { no: number; group: string; status: string; seat: string; n?: number }[];
  live: {
    pickOpen: boolean; paused: boolean; inHours: boolean; hourFrom: string; hourTo: string;
    current: { nos: number[]; group: string; deadline: string | null } | null;
    next: { no: number; group: string }[]; recent: { no: number; group: string; seat: string; at: string }[]; done: number;
  };
  seats?: MapProps['seats']; zones?: MapProps['zones'];
};
type Tab = 'feed' | 'order' | 'live';

const hm = (iso: string, now: string) => {
  const d = new Date(iso), n = new Date(now);
  const day = (x: Date) => x.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
  const time = d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
  return day(d) === day(n) ? time : `${day(d)} ${time}`;
};
const ORDER_ST: Record<string, [string, string]> = { provisional: ['待截止', 'var(--muted)'], wait: ['排隊中', 'var(--muted)'], turn: ['選位中', 'var(--red)'], done: ['已選位', 'var(--ok)'] };

/** 揪團即時看板（公開）：回報動態、劃位排序、劃位現況。每幾秒自動更新 */
export default function JoinBoardApp() {
  const [tab, setTab] = useState<Tab>('feed');
  const [b, setB] = useState<Board | null>(null);
  const [extra, setExtra] = useState<Line[]>([]);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const qRef = useRef(q);
  qRef.current = q;

  async function load(t: Tab = tab) {
    try {
      const r = await fetch(`/api/join/board?tab=${t}&q=${encodeURIComponent(qRef.current.trim())}`, { cache: 'no-store' }).then((x) => x.json());
      if (!r.ok) { setErr(r.message); return; }
      const d = r.data as Board;
      const keys = d.feed.map((x) => x.k);
      if (seen.current) setFresh(new Set(keys.filter((k) => !seen.current!.has(k))));
      seen.current = new Set([...(seen.current ?? []), ...keys]);
      setB(d); setErr('');
      if (!extra.length) setMore(d.more);
    } catch { setErr('網路連線異常，稍後自動重試'); }
  }

  useEffect(() => {
    // 劃位進行中預設看「劃位現況」
    fetch('/api/join/board?tab=feed', { cache: 'no-store' }).then((x) => x.json()).then((r) => {
      if (r.ok && (r.data as Board).live.pickOpen) { setTab('live'); load('live'); } else load('feed');
    }).catch(() => load('feed'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ms = tab === 'live' ? 5000 : 10000;
    const id = setInterval(() => { if (!document.hidden) load(); }, ms);
    const c = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { clearInterval(id); clearInterval(c); };
  }, [tab, extra.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const id = setTimeout(() => { setExtra([]); seen.current = null; load(); }, 350); return () => clearTimeout(id); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMore() {
    const last = [...(b?.feed ?? []), ...extra].at(-1);
    if (!last) return;
    const r = await fetch(`/api/join/board?tab=feed&q=${encodeURIComponent(q.trim())}&before=${encodeURIComponent(last.at)}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
    if (r?.ok) { setExtra([...extra, ...(r.data as Board).feed]); setMore((r.data as Board).more); }
  }

  if (!b) return <main className="wrap join"><div className="card muted">{err || '載入中…'}</div></main>;

  const qq = q.replace(/\s/g, '').toLowerCase();
  const hit = (g: string) => !!qq && g.replace(/\s/g, '').toLowerCase().includes(qq);
  const feed = [...b.feed, ...extra.filter((x) => !b.feed.some((y) => y.k === x.k))];
  const left = b.live.current?.deadline ? Math.max(0, Math.round((new Date(b.live.current.deadline).getTime() - Date.now()) / 1000)) : null;
  void tick;

  return (
    <main className="wrap join">
      <style>{`
        @keyframes jbIn { from { opacity: 0; transform: translateY(-12px); background: #fff1d6; } 40% { background: #fff1d6; } to { opacity: 1; transform: none; } }
        .jb-line { display: grid; grid-template-columns: 52px 1fr auto; gap: 4px 10px; align-items: baseline; padding: 10px 4px; border-bottom: 1px solid #ecebe5; }
        .jb-line.new { animation: jbIn 1.6s ease-out; }
        .jb-line.me { background: #eef6f1; }
        .jb-chip { display: inline-block; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 1px 8px; margin-right: 4px; }
        .jb-tabs { display: flex; gap: 6px; margin: 12px 0; }
        .jb-tabs button { flex: 1; padding: 10px 4px; border-radius: 10px; border: 1px solid #d9d6cc; background: #fff; font-weight: 700; }
        .jb-tabs button.on { background: #1f2a44; color: #fff; border-color: #1f2a44; }
      `}</style>
      <div className="card">
        <h1 style={{ margin: '0 0 4px' }}>揪團即時看板・買 {b.perSeat} 送 1</h1>
        <div className="muted">{b.event.name}・{fmtDate(b.event.showAt)}</div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
          <div className="stat"><b>{b.stats.groups}</b><span>群</span></div>
          <div className="stat"><b style={{ color: 'var(--ok)' }}>{b.stats.verified}</b><span>張已核對</span></div>
          <div className="stat"><b style={{ color: 'var(--warn)' }}>{b.stats.pending}</b><span>張待核對</span></div>
          <div className="stat"><b>{b.stats.slots}</b><span>{b.locked || b.auto ? '個劃位序' : '個預計劃位序'}</span></div>
          {b.stats.giftSeats > 0 && <div className="stat"><b>{b.stats.giftFree}</b><span>席贈席還空著</span></div>}
          {b.stats.giftSeats > 0 && b.stats.canGive !== undefined && <div className="stat"><b style={{ color: 'var(--ok)' }}>{b.stats.canGive}</b><span>還可以給的劃位序</span></div>}
          {b.era && b.era.cap > 0 && b.era.at && <div className="stat"><b style={{ color: 'var(--red)' }}>{b.era.left}</b><span>年代銀區尚餘（共 {b.era.cap} 席，已售 {b.era.sold}）</span></div>}
        </div>
      </div>

      <div className="jb-tabs">
        {([['feed', '回報動態'], ['order', '劃位排序'], ['live', '劃位現況']] as [Tab, string][]).map(([k, n]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => { setTab(k); load(k); }}>{n}</button>
        ))}
      </div>
      <input value={q} placeholder="🔍 找我的群（打群名的幾個字）" onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      {err && <p className="note err small">{err}</p>}

      {tab === 'feed' && (
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>{!b.auto && (b.round ?? 1) > 1 && <b>第 {b.round} 輪　</b>}{b.reportOpen ? '回報中，最新的在最上面，每 10 秒自動更新。' : b.locked ? '回報已截止，劃位序已確定。' : '回報目前沒有開放。'}每 {b.perSeat} 張核對通過＝1 個劃位序。</p>
          {!feed.length && <p className="muted">{q ? '找不到這個群的回報。' : '還沒有回報。'}</p>}
          {feed.map((x) => (
            <div key={x.k} className={`jb-line${fresh.has(x.k) ? ' new' : ''}${hit(x.group) ? ' me' : ''}`}>
              <span className="small muted">{hm(x.at, b.now)}</span>
              <span><b>{x.group}</b><br />
                {x.ok > 0 && <span className="jb-chip" style={{ background: '#e1f2e9', color: '#1e6b4a' }}>已核對 {x.ok}</span>}
                {x.pending > 0 && <span className="jb-chip" style={{ background: '#fbe2b0', color: '#8a5a12' }}>待核對 {x.pending}</span>}
                {x.bad > 0 && <span className="jb-chip" style={{ background: '#f8dcd8', color: '#a3342a' }}>需修正 {x.bad}</span>}
                {x.nos.length > 0 && <span style={{ fontWeight: 700, color: 'var(--ok)' }}>🎉 第 {x.nos.join('、')} 號</span>}
                {(x.cnt ?? 0) > 0 && <span style={{ fontWeight: 700, color: 'var(--ok)' }}>🎉 +{x.cnt} 個劃位序</span>}
              </span>
              <span style={{ textAlign: 'right' }}><b style={{ fontSize: '1.15em' }}>+{x.qty} 張</b><br /><span className="small muted">累計 {x.total} 張</span></span>
            </div>
          ))}
          {more && <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} onClick={loadMore}>看更多</button>}
        </div>
      )}

      {tab === 'order' && (
        <div className="card">
          <p className="small muted" style={{ marginTop: 0 }}>{b.auto ? '核對通過就給號（依回報時間），號碼不會再變。輪到時依順序一個一個選位。' : b.locked ? '劃位序已確定。輪到時依號碼一個一個選位。' : `依回報時間排列，只算核對通過的票。${b.started ? '前幾輪已確定的號碼照舊；' : ''}本輪先顯示各群預計幾個，號碼在回報截止後才確定。`}</p>
          {!b.order.length && <p className="muted">還沒有劃位序。</p>}
          <div className="tbl"><table><tbody>
            {b.order.filter((x) => !qq || hit(x.group)).map((x) => (
              <tr key={x.no ? `n${x.no}` : `g${x.group}`} style={{ background: hit(x.group) ? '#eef6f1' : undefined }}>
                <td style={{ width: 70 }}><b>{x.no ? `第 ${x.no} 號` : `預計 ${x.n ?? 1} 個`}</b></td><td>{x.group}</td>
                <td style={{ textAlign: 'right', color: ORDER_ST[x.status]?.[1], fontWeight: 700 }}>{x.seat || ORDER_ST[x.status]?.[0]}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      {tab === 'live' && (
        <>
          <div className="card" style={{ borderTop: '4px solid var(--red)', textAlign: 'center' }}>
            {!b.started ? <p className="muted" style={{ margin: 0 }}>回報截止、劃位序確定後才開始劃位。</p>
              : !b.live.pickOpen ? <p className="muted" style={{ margin: 0 }}>劃位還沒開始。</p>
                : b.live.paused ? <p style={{ margin: 0 }}>劃位暫停中，請稍候。</p>
                  : !b.live.inHours ? <p style={{ margin: 0 }}>劃位時段為 {b.live.hourFrom}–{b.live.hourTo}，時段外暫停。</p>
                    : b.live.current ? (
                      <>
                        <div className="small muted">正在選位</div>
                        <div style={{ fontSize: 28, fontWeight: 900, margin: '4px 0' }}>第 {b.live.current.nos.join('、')} 號</div>
                        <div style={{ fontSize: 22, fontWeight: 700 }}>{b.live.current.group}</div>
                        {left !== null && <div className="small muted" style={{ marginTop: 4 }}>剩 {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</div>}
                      </>
                    ) : <p style={{ margin: 0 }}>{b.live.done ? '全部選位完成 🎉' : '等待下一位…'}</p>}
          </div>
          {b.live.next.length > 0 && (
            <div className="card"><b>接下來</b>
              {b.live.next.map((x) => <div key={x.no} style={{ padding: '4px 0', background: hit(x.group) ? '#eef6f1' : undefined }}>第 {x.no} 號　{x.group}</div>)}
            </div>
          )}
          {b.live.recent.length > 0 && (
            <div className="card"><b>剛選好</b>
              {b.live.recent.map((x) => <div key={x.no} className="small" style={{ padding: '3px 0' }}>{hm(x.at, b.now)}　第 {x.no} 號 {x.group} → <b>{x.seat}</b></div>)}
            </div>
          )}
          {b.seats && b.zones && (
            <div className="card">
              <b>三樓贈席</b> <span className="small muted">黃色＝還空著，灰色＝已選或不開放</span>
              <SeatMap seats={b.seats} zones={b.zones} vipInstalled={false} floor="3F" view selected={new Set()} onToggle={() => undefined} locked />
            </div>
          )}
        </>
      )}
      <p className="small muted" style={{ textAlign: 'center' }}>只顯示群名稱，不顯示個人資料。有疑義請洽 {b.contact}。<a href="/join">回報連結</a></p>
    </main>
  );
}
