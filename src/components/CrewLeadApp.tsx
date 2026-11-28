'use client';

import { useCallback, useEffect, useState } from 'react';

type Pos = { id: number; name: string; active: boolean; crewId: number | null; crewName: string; openedAt: string | null; seenAt: string | null; online: boolean; here: number; prac: number; pracAll: number; kinds: string[] };
type Crew = {
  id: number; name: string; email: string; phone: string; friend: boolean; gateId: number | null; gateName: string;
  mail: { status: string; error: string; at: string } | null; mailStale: boolean; lineAt: string | null; line: string; createdAt: string;
};
type State = { event: string; showAt: string; liveAt: string; practice: boolean; now: string; lead: { name: string; lineId: string }; joinUrl: string; practiceUrl: string; positions: Pos[]; crew: Crew[] };
type Preview = { send: { id: number; name: string; email: string; gate: string; again: boolean }[]; skipSent: number; skipNoGate: number };
type Res<T> = { ok: true; data: T } | { ok: false; message: string };
type Tab = 'join' | 'assign' | 'send' | 'day';

const tw = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (iso: string | null, now: string) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((new Date(now).getTime() - new Date(iso).getTime()) / 1000));
  return s < 60 ? '剛剛' : s < 3600 ? `${Math.round(s / 60)} 分鐘前` : tw(iso);
};
const lineShare = (text: string) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;
const C = { ok: '#0f6e56', warn: '#854f0b', bad: '#a32d2d', muted: '#6b7488', line: '#e3e7ef', soft: '#f6f3ec', ink: '#1f2a44' };

/** 驗票負責人管理頁（可加入主畫面）：招募、分配、發送、當天 */
export default function CrewLeadApp({ token }: { token: string }) {
  const url = `/api/crew/m/${encodeURIComponent(token)}`;
  const [st, setSt] = useState<State | null>(null);
  const [fatal, setFatal] = useState('');
  const [tab, setTab] = useState<Tab>('join');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [edit, setEdit] = useState<Crew | null>(null);
  const [newPos, setNewPos] = useState('');
  const [standalone, setStandalone] = useState(true);

  const load = useCallback(async () => {
    try {
      const r: Res<State> = await (await fetch(url, { cache: 'no-store' })).json();
      if (r.ok) setSt(r.data); else setFatal(r.message);
    } catch { /* 網路暫時不通：下次再試 */ }
  }, [url]);
  useEffect(() => { load(); const i = setInterval(load, tab === 'day' ? 10_000 : 20_000); return () => clearInterval(i); }, [load, tab]);
  useEffect(() => {
    try { setStandalone(window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true); } catch { /* 不支援 */ }
    try { const t = localStorage.getItem('crew-tab') as Tab | null; if (t) setTab(t); } catch { /* 不能存 */ }
  }, []);
  const go = (t: Tab) => { setTab(t); setSure(''); try { localStorage.setItem('crew-tab', t); } catch { /* 不能存 */ } };

  async function act<T = unknown>(body: unknown, ok?: string): Promise<T | null> {
    setBusy(true); setMsg(null);
    try {
      const r: Res<T> = await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (!r.ok) { setMsg({ ok: false, text: r.message }); return null; }
      if (ok) setMsg({ ok: true, text: ok });
      await load();
      return r.data;
    } catch { setMsg({ ok: false, text: '網路連線異常，請再試一次。' }); return null; } finally { setBusy(false); setSure(''); }
  }
  const twice = (key: string, fn: () => void) => { if (sure === key) fn(); else setSure(key); };

  if (fatal) return <main className="wrap" style={{ maxWidth: 520, padding: 16 }}><div className="card"><h2>無法開啟</h2><p>{fatal}</p></div></main>;
  if (!st) return <main className="wrap" style={{ maxWidth: 520, padding: 16 }}><div className="card">載入中…</div></main>;

  const assigned = st.crew.filter((c) => c.gateId);
  const free = st.crew.filter((c) => !c.gateId);
  const staffed = st.positions.filter((p) => p.crewId);
  const online = staffed.filter((p) => p.online).length;
  const posOf = (c: Crew) => st.positions.find((p) => p.id === c.gateId);
  const mailBadge = (c: Crew) => {
    if (!c.mail) return { t: '未寄信', c: C.muted };
    if (c.mailStale) return { t: '位置或連結改了，要重寄', c: C.warn };
    if (c.mail.status === 'failed') return { t: `寄送失敗：${c.mail.error}`, c: C.bad };
    if (c.mail.status === 'queued') return { t: c.mail.error ? `寄送中（${c.mail.error}）` : '寄送中', c: C.warn };
    if (c.mail.status === 'simulated') return { t: '未設定寄件信箱，信沒有寄出', c: C.bad };
    return { t: `已寄信 ${tw(c.mail.at)}`, c: C.ok };
  };
  const linkBadge = (p?: Pos) => (!p ? null : p.online ? { t: '🟢 在線', c: C.ok } : p.openedAt ? { t: `🟡 已開啟（${ago(p.seenAt, st.now)}）`, c: C.warn } : { t: '⚪ 還沒點開連結', c: C.muted });

  const tabs: [Tab, string][] = [['join', '招募'], ['assign', '分配'], ['send', '發送'], ['day', '當天']];
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '0 0 72px', minHeight: '100vh', background: C.soft }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 5, background: C.ink, color: '#fff', padding: '12px 16px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <b style={{ fontSize: 17 }}>驗票管理</b>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{st.practice ? `練習中・${tw(st.liveAt)} 起正式` : '正式驗票中'}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>{st.event}{st.lead.name ? `・負責人 ${st.lead.name}` : ''}</div>
        <nav style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginTop: 10 }}>
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => go(k)} style={{ background: 'none', border: 0, color: '#fff', padding: '8px 0 10px', fontSize: 15, borderBottom: tab === k ? '3px solid #f0c060' : '3px solid transparent', opacity: tab === k ? 1 : 0.75 }}>{label}</button>
          ))}
        </nav>
      </header>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {msg && <div className={`note ${msg.ok ? 'ok' : 'err'}`} onClick={() => setMsg(null)}>{msg.text}</div>}

        {tab === 'join' && <>
          {!standalone && (
            <div className="card" style={{ fontSize: 14 }}>
              <b>加入主畫面，像 APP 一樣使用</b>
              <div className="small muted" style={{ marginTop: 4, lineHeight: 1.7 }}>
                iPhone：Safari 下方「分享」→「加入主畫面」<br />Android：Chrome 右上「⋮」→「加到主畫面」或「安裝應用程式」
              </div>
            </div>
          )}
          <div className="card">
            <h2>志工報名連結</h2>
            <p className="small muted" style={{ marginTop: 0 }}>分享到驗票志工群組。志工填姓名、Email、手機，報名後會看到「加您 LINE 好友」的按鈕。</p>
            <div className="row">
              <a className="btn pri" href={lineShare(`【${st.event}】驗票志工報名，請填姓名、Email、手機：\n${st.joinUrl}`)}>分享到 LINE</a>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(st.joinUrl).then(() => setMsg({ ok: true, text: '已複製報名連結' }), () => undefined)}>複製連結</button>
            </div>
            {!st.lead.lineId && <p className="small" style={{ color: C.warn, marginBottom: 0 }}>還沒設定您的 LINE ID，報名完成頁不會有「加好友」按鈕。請聯絡系統管理員補上。</p>}
          </div>
          <div className="card">
            <h2>已報名 {st.crew.length} 人 <span className="small muted">已分配 {assigned.length}</span></h2>
            {!st.crew.length && <p className="small muted" style={{ margin: 0 }}>還沒有人報名。</p>}
            {st.crew.map((c) => (
              <div key={c.id} style={{ borderTop: `1px solid ${C.line}`, padding: '8px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <b>{c.name}</b>{c.gateName && <span className="pill" style={{ marginLeft: 6, color: C.ok }}>{c.gateName}</span>}
                  <div className="small muted" style={{ wordBreak: 'break-all' }}><a href={`tel:${c.phone}`}>{c.phone}</a>・{c.email}</div>
                  <div className="small" style={{ color: c.friend ? C.ok : C.muted }}>{c.friend ? '已按加好友' : '還沒按加好友'}</div>
                </div>
                <button className="btn small" onClick={() => setEdit(c)}>修改</button>
              </div>
            ))}
          </div>
          {edit && <EditCrew c={edit} busy={busy} sure={sure} twice={twice} onClose={() => setEdit(null)}
            onSave={async (v) => { if (await act({ action: 'crew.edit', crewId: edit.id, ...v }, '已更新')) setEdit(null); }}
            onRemove={async () => { if (await act({ action: 'crew.remove', crewId: edit.id }, `已移除 ${edit.name}（若已給過連結，那個位置的連結已換新）`)) setEdit(null); }} />}
        </>}

        {tab === 'assign' && <>
          <div className="card">
            <h2>位置 {st.positions.length} 個 <span className="small muted">一個位置一人、一條驗票連結</span></h2>
            {st.positions.map((p) => (
              <div key={p.id} style={{ borderTop: `1px solid ${C.line}`, padding: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <b style={{ minWidth: 72 }}>{p.name}{!p.active && <span className="small" style={{ color: C.bad }}>（停用）</span>}</b>
                <select value={p.crewId ?? ''} disabled={busy} style={{ flex: 1, maxWidth: 220 }} onChange={async (e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  const r = await act<{ renewed: boolean }>({ action: 'assign', gateId: p.id, crewId: v });
                  if (r) setMsg({ ok: true, text: r.renewed ? `已改派。${p.name} 的舊連結已失效，請到「發送」把新連結給新的人。` : '已分配，請到「發送」寄出連結' });
                }}>
                  <option value="">（未分配）</option>
                  {[...st.crew.filter((c) => c.gateId === p.id), ...free].map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
            <form className="row" style={{ marginTop: 10 }} onSubmit={async (e) => {
              e.preventDefault();
              const names = newPos.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
              if (names.length && await act({ action: 'pos.add', names }, `已新增 ${names.join('、')}`)) setNewPos('');
            }}>
              <input value={newPos} onChange={(e) => setNewPos(e.target.value)} placeholder="新增位置，例：4F右-A 4F右-B" style={{ flex: 1 }} />
              <button className="btn" disabled={busy || !newPos.trim()}>新增</button>
            </form>
            <p className="small muted" style={{ marginBottom: 0 }}>建議一門兩人：A 專門掃 QR，B 處理貴賓券、問題票。換人時，若舊的人已經拿到連結，系統會自動換新連結（舊的立即失效）。</p>
          </div>
          {!!free.length && <div className="card"><h2>還沒分配 {free.length} 人</h2><div className="small">{free.map((c) => c.name).join('、')}</div></div>}
        </>}

        {tab === 'send' && <>
          <div className="card">
            <h2>寄出驗票連結</h2>
            <p className="small muted" style={{ marginTop: 0 }}>只寄給已分配位置、還沒寄過（或位置改過）的人。按下會先列出名單給您核對。</p>
            <button className="btn pri" disabled={busy} style={{ width: '100%', padding: '11px 0', fontSize: 15 }} onClick={async () => setPreview(await act<Preview>({ action: 'mail.preview' }))}>寄出全部…</button>
            {preview && (
              <div style={{ marginTop: 10, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, background: '#fff' }}>
                {preview.send.length ? <>
                  <b>要寄 {preview.send.length} 封：</b>
                  {preview.send.map((x) => <div key={x.id} className="small" style={{ padding: '3px 0', wordBreak: 'break-all' }}>{x.gate}・{x.name}・{x.email}{x.again ? '（重寄）' : ''}</div>)}
                </> : <b>沒有要寄的信</b>}
                <div className="small muted" style={{ marginTop: 6 }}>已寄過不再寄 {preview.skipSent} 人・還沒分配不寄 {preview.skipNoGate} 人</div>
                <div className="row" style={{ marginTop: 8 }}>
                  {!!preview.send.length && <button className="btn pri" disabled={busy} onClick={async () => { const r = await act<{ sent: number }>({ action: 'mail.send', ids: preview.send.map((x) => x.id) }); if (r) { setMsg({ ok: true, text: `已寄出 ${r.sent} 封` }); setPreview(null); } }}>確定寄出這 {preview.send.length} 封</button>}
                  <button className="btn" onClick={() => setPreview(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
          <div className="card">
            <h2>每個人 <a className="small" href={st.practiceUrl} target="_blank" rel="noreferrer">練習單</a></h2>
            {!assigned.length && <p className="small muted" style={{ margin: 0 }}>先到「分配」把志工排到位置。</p>}
            {assigned.map((c) => {
              const m = mailBadge(c); const p = posOf(c); const lb = linkBadge(p);
              return (
                <div key={c.id} style={{ borderTop: `1px solid ${C.line}`, padding: '9px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span><b>{c.name}</b>・{c.gateName}</span>
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <a className="btn small pri" href={lineShare(c.line)} onClick={() => { act({ action: 'line', crewId: c.id }); }}>LINE</a>
                      <button className="btn small" disabled={busy} onClick={() => twice(`m${c.id}`, () => act({ action: 'mail.one', crewId: c.id }, `已重寄給 ${c.name}`))}>{sure === `m${c.id}` ? '確定寄？' : c.mail ? '重寄' : '寄信'}</button>
                    </span>
                  </div>
                  <div className="small" style={{ color: m.c }}>{m.t}</div>
                  <div className="small" style={{ color: c.lineAt ? C.ok : C.muted }}>{c.lineAt ? `已用 LINE 傳 ${tw(c.lineAt)}` : '還沒用 LINE 傳'}{c.friend ? '' : '・對方還沒按加好友'}</div>
                  {lb && <div className="small" style={{ color: lb.c }}>{lb.t}{p && p.pracAll ? `・練習 ${p.prac} 張` : ''}</div>}
                </div>
              );
            })}
            <p className="small muted" style={{ marginBottom: 0 }}>「LINE」會打開 LINE、訊息已寫好，選這位志工再按傳送。請一對一傳，不要傳到群組。</p>
          </div>
        </>}

        {tab === 'day' && <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 10 }}>
            <div className="card" style={{ textAlign: 'center' }}><div className="small muted">在線</div><div style={{ fontSize: 26, fontWeight: 700 }}>{online} / {staffed.length}</div></div>
            <div className="card" style={{ textAlign: 'center' }}><div className="small muted">{st.practice ? '練習張數' : '已入場'}</div><div style={{ fontSize: 26, fontWeight: 700 }}>{st.positions.reduce((a, p) => a + (st.practice ? p.prac : p.here), 0)}</div></div>
          </div>
          <div className="card">
            <h2>各位置 <span className="small muted">每 10 秒更新</span></h2>
            {st.positions.map((p) => {
              const c = st.crew.find((x) => x.id === p.crewId);
              const dot = !p.crewId ? '⚪' : p.online ? '🟢' : p.openedAt ? '🔴' : '⚪';
              return (
                <div key={p.id} style={{ borderTop: `1px solid ${C.line}`, padding: '8px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <b>{dot} {p.name}</b> {c ? c.name : <span className="muted">未分配</span>}
                    <div className="small muted">
                      {p.online ? '在線' : p.seenAt ? `離線（最後 ${ago(p.seenAt, st.now)}）` : '還沒點開連結'}
                      {st.practice ? `・練習 ${p.prac} 張` : `・已掃 ${p.here} 張`}
                      {st.practice && p.kinds.length ? `（${p.kinds.join('、')}）` : ''}
                    </div>
                    {c && <a className="small" href={`tel:${c.phone}`}>打電話 {c.phone}</a>}
                  </div>
                  <button className="btn small" disabled={busy} onClick={() => twice(`r${p.id}`, () => act({ action: 'pos.renew', gateId: p.id }, `已換新 ${p.name} 的連結，舊的立即失效。請到「發送」重寄或用 LINE 傳。`))}>{sure === `r${p.id}` ? '確定換新？' : '換新連結'}</button>
                </div>
              );
            })}
            <p className="small muted" style={{ marginBottom: 0 }}>手機遺失、連結外流時按「換新連結」。🔴＝打開過但現在離線（可能沒電、沒網路或關掉頁面），請打電話確認。</p>
          </div>
        </>}
      </div>
    </main>
  );
}

function EditCrew({ c, busy, sure, twice, onClose, onSave, onRemove }: {
  c: Crew; busy: boolean; sure: string; twice: (k: string, fn: () => void) => void; onClose: () => void;
  onSave: (v: { name: string; email: string; phone: string }) => void; onRemove: () => void;
}) {
  const [v, setV] = useState({ name: c.name, email: c.email, phone: c.phone });
  return (
    <div className="card">
      <h2>修改 {c.name} <button className="btn small" onClick={onClose}>關閉</button></h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label>姓名<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} style={{ width: '100%' }} /></label>
        <label>Email<input value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} style={{ width: '100%' }} /></label>
        <label>手機<input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} style={{ width: '100%' }} /></label>
        <div className="row">
          <button className="btn pri" disabled={busy} onClick={() => onSave(v)}>儲存</button>
          <button className="btn danger" disabled={busy} onClick={() => twice(`rm${c.id}`, onRemove)}>{sure === `rm${c.id}` ? '確定移除？再按一次' : '移除這位志工'}</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>改了 Email 要重新寄信。</p>
      </div>
    </div>
  );
}
