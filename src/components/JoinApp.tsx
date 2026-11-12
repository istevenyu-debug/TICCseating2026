'use client';

import { useEffect, useMemo, useState } from 'react';
import JoinReportApp, { type Api, type Res } from './JoinReportApp';

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

type Menu = {
  event: { name: string; showAt: string }; reportOpen: boolean; createOpen: boolean; locked: boolean; contact: string; perSeat: number;
  groups: { id: number; name: string; head: string }[];
};
type Group = { id: number; name: string; head: string };
type Clash = { name: string; head: string; phoneTail: string; suggest: string; mine: { id: number; name: string }[] };

const KEY = 'join-group';
const DEV = 'join-device';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } },
  set: (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* 不能存也沒關係 */ } },
};
function deviceId() {
  let d = ls.get(DEV);
  if (!d) { d = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; ls.set(DEV, d); }
  return d;
}

async function req<T>(url: string, body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/**
 * 揪團回報（共用連結，不用註冊）：
 *  - 志工：打群名的幾個字 → 點選群 → 填名字 → 後 4 碼＋張數 → 送出（手機記住群與名字）
 *  - 負責人：清單沒有本群 → 建立新群（群名、姓名、手機、Email）→ 把群名告訴志工
 */
export default function JoinApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [group, setGroup] = useState<Group | null>(null);
  const [ready, setReady] = useState(false);
  const [last, setLast] = useState<Group | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', headName: '', headPhone: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [clash, setClash] = useState<Clash | null>(null);
  const [made, setMade] = useState('');
  const [suggest, setSuggest] = useState('');

  const load = () => req<Menu>('/api/join').then((r) => (r.ok ? setMenu(r.data) : setErr(r.message)));
  useEffect(() => {
    // 不直接進入上次的群：先問「繼續回報到 ○○？」，避免共用的手機、電腦帶錯群
    try { const g = JSON.parse(ls.get(KEY) || 'null') as Group | null; if (g?.id) setLast(g); } catch { /* 忽略 */ }
    setReady(true); load();
  }, []);

  const choose = (g: Group | null) => { ls.set(KEY, g ? JSON.stringify(g) : ''); setLast(g ?? last); setGroup(g); setPick(null); setClash(null); setQ(''); if (!g) load(); window.scrollTo(0, 0); };

  const api = useMemo<Api | null>(() => {
    if (!group) return null;
    const dev = deviceId();
    return {
      load: () => req(`/api/join/g/${group.id}?d=${encodeURIComponent(dev)}`),
      send: (b) => req('/api/join', { groupId: group.id, device: dev, ...b }),
      del: (id, reporter) => req(`/api/join/g/${group.id}`, { action: 'delete', reportId: id, device: dev, reporter }),
      fix: (id, orderNo, reporter) => req(`/api/join/g/${group.id}`, { action: 'fix', reportId: id, device: dev, orderNo, reporter }),
    };
  }, [group]);

  async function create(name = f.name) {
    const g = { ...f, name };
    if (!g.name.trim() || !g.headName.trim() || !g.headPhone.trim() || !emailOk(g.email)) { setErr('請填寫群名稱、負責人姓名、手機與正確的 Email'); return; }
    setBusy(true); setErr('');
    const r = await req<{ group?: Group; created?: boolean; clash?: Clash }>('/api/join', { group: g, createOnly: true, device: deviceId() });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    if (r.data.clash) { setClash(r.data.clash); return; }
    if (r.data.group) { setMade(r.data.created ? r.data.group.name : ''); setSuggest(g.headName.trim()); setCreating(false); choose(r.data.group); }
  }

  if (!ready) return null;

  if (group && api) {
    const bar = (
      <div style={{ marginTop: 10, background: '#eef1f7', borderRadius: 10, padding: '8px 12px' }}>
        {made === group.name && <div className="small" style={{ color: 'var(--ok)', fontWeight: 700, marginBottom: 4 }}>✓ 已建立「{group.name}」。請把群名告訴志工：打開同一條連結、點選「{group.name}」就能回報。</div>}
        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          <span>回報到：<b style={{ fontSize: '1.1em' }}>{group.name}</b> <span className="small muted">（負責人 {group.head}）</span></span>
          <button type="button" className="linkbtn small" onClick={() => { setMade(''); setSuggest(''); choose(null); }}>換一群</button>
        </div>
      </div>
    );
    return <JoinReportApp key={group.id} api={api} bar={bar} suggestName={suggest || undefined} />;
  }

  if (err && !menu) return <main className="wrap join"><div className="card"><p className="note err">{err}</p></div></main>;
  if (!menu) return <main className="wrap join"><div className="card muted">載入中…</div></main>;

  const qq = q.replace(/\s/g, '').toLowerCase();
  const hits = qq ? menu.groups.filter((g) => g.name.replace(/\s/g, '').toLowerCase().includes(qq)).slice(0, 30) : [];
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setClash(null); };

  return (
    <main className="wrap join">
      <div className="card">
        <h1 style={{ margin: '0 0 4px' }}>揪團回報・買 {menu.perSeat} 送 1</h1>
        <div className="muted">{menu.event.name}・{fmtDate(menu.event.showAt)}</div>
        <a href="/join/board" className="small" style={{ display: 'inline-block', marginTop: 6 }}>📊 看即時看板（回報動態、劃位排序）</a>
      </div>
      <div className="note" style={{ margin: '12px 0' }}>
        <b>志工：</b>在下面打群名的幾個字，點選您的群，再填訂單編號後 4 碼與張數。<br />
        <b>負責人：</b>清單上還沒有本群，請先「建立新群」（約 1 分鐘），再把群名告訴志工。<br />
        <span className="small">一群一位負責人；每 {menu.perSeat} 張核對通過＝1 個劃位序。有疑義請洽 {menu.contact}</span>
      </div>
      {menu.locked && <div className="note">回報已截止，劃位序已確定。</div>}

      {!creating && (
        <div className="card">
          {last && menu.groups.some((g) => g.id === last.id) && (
            <div className="note" style={{ marginTop: 0, marginBottom: 14 }}>
              這支手機上次回報到「<b>{menu.groups.find((g) => g.id === last.id)!.name}</b>」（負責人 {menu.groups.find((g) => g.id === last.id)!.head}）
              <button type="button" className="btn pri" style={{ width: '100%', marginTop: 8, padding: 12 }} onClick={() => choose(menu.groups.find((g) => g.id === last.id)!)}>繼續回報到這一群</button>
              <button type="button" className="linkbtn small" style={{ marginTop: 6 }} onClick={() => { ls.set(KEY, ''); setLast(null); }}>不是，我要選別的群</button>
            </div>
          )}
          <h2 style={{ marginTop: 0 }}>回報到哪一群？</h2>
          <input value={q} placeholder="打群名的幾個字，例：大安" onChange={(e) => { setQ(e.target.value); setPick(null); }} autoFocus />
          {qq && !hits.length && <p className="small muted">找不到「{q}」。{menu.createOpen && '如果是新的群，請負責人按下面「建立新群」。'}</p>}
          {hits.length > 0 && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {hits.map((g) => (
                <button key={g.id} type="button" className="btn" style={{ textAlign: 'left', padding: '10px 12px', background: pick?.id === g.id ? '#fff1d6' : undefined }} onClick={() => setPick(g)}>
                  <b>{g.name}</b> <span className="small muted">負責人 {g.head}</span>
                </button>
              ))}
            </div>
          )}
          {pick && (
            <div className="note" style={{ marginTop: 10 }}>
              回報到「<b>{pick.name}</b>」（負責人 {pick.head}）？
              <button type="button" className="btn pri" style={{ width: '100%', marginTop: 8, padding: 12 }} onClick={() => choose(pick)}>確定，開始回報</button>
            </div>
          )}
          {menu.createOpen && <button type="button" className="btn" style={{ width: '100%', marginTop: 16 }} onClick={() => { setCreating(true); setErr(''); setF({ ...f, name: q.trim() }); }}>＋ 建立新群（負責人）</button>}
        </div>
      )}

      {creating && (
        <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); create(); }}>
          <h2 style={{ marginTop: 0 }}>建立新群</h2>
          <p className="small muted" style={{ marginTop: 0 }}>由負責人填寫，每群只填一次。劃位連結與輪號通知會寄到這個 Email。</p>
          <div className="fields">
            <label className="f">群名稱<input value={f.name} maxLength={30} placeholder="例：台北大安1" onChange={(e) => set('name', e.target.value)} /></label>
            <label className="f">負責人姓名<input value={f.headName} maxLength={30} autoComplete="name" onChange={(e) => set('headName', e.target.value)} /></label>
            <label className="f">手機<input value={f.headPhone} inputMode="tel" autoComplete="tel" placeholder="0912-345-678" onChange={(e) => set('headPhone', e.target.value)} /></label>
            <label className="f">Email<input value={f.email} inputMode="email" autoComplete="email" onChange={(e) => set('email', e.target.value)} /></label>
          </div>
          {clash && (
            <div className="note err" style={{ marginTop: 10 }}>
              「<b>{clash.name}</b>」已由 {clash.head}（手機 …{clash.phoneTail}）建立。
              {clash.mine.length > 0 && <div style={{ marginTop: 8 }}>{clash.mine.map((m) => (
                <button key={m.id} type="button" className="btn pri" style={{ width: '100%', marginTop: 6 }} onClick={() => { setCreating(false); setSuggest(f.headName.trim()); choose({ id: m.id, name: m.name, head: f.headName.slice(0, 1) + '○○' }); }}>您的群是「{m.name}」，改回報到這一群</button>
              ))}</div>}
              <div style={{ marginTop: 8 }}>・<b>是同一群</b>：請回上一頁，從清單點選「{clash.name}」。</div>
              <div>・<b>不同群</b>：<button type="button" className="btn pri small" disabled={busy} onClick={() => { setF({ ...f, name: clash.suggest }); create(clash.suggest); }}>改用「{clash.suggest}」建立</button></div>
            </div>
          )}
          {err && <p className="note err">{err}</p>}
          <button className="btn pri" style={{ width: '100%', marginTop: 12, padding: 12 }} disabled={busy}>{busy ? '建立中…' : '建立群'}</button>
          <button type="button" className="linkbtn" style={{ marginTop: 10 }} onClick={() => { setCreating(false); setClash(null); setErr(''); }}>← 回上一頁</button>
          <p className="small muted">資料僅用於本活動贈票聯絡</p>
        </form>
      )}
      {err && !creating && <p className="note err">{err}</p>}
    </main>
  );
}
