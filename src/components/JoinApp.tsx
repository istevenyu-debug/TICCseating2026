'use client';

import { useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';

type Menu = { open: boolean; contact: string; event: { name: string; showAt: string }; venues: { id: number; name: string }[] };
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
type Leader = { sameAsHead: boolean; name: string; phone: string; email: string; noEmail: boolean };

const OTHER = 'other';
const MAX = 10;
const blank = (same = false): Leader => ({ sameAsHead: same, name: '', phone: '', email: '', noEmail: false });
const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

async function call<T>(body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch('/api/join', body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 揪團登記：團練場、負責人、揪團人（可同負責人、可多位）。欄位越少越好 */
export default function JoinApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [venue, setVenue] = useState('');
  const [venueText, setVenueText] = useState('');
  const [head, setHead] = useState({ name: '', phone: '' });
  const [leaders, setLeaders] = useState<Leader[]>([blank(true)]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<{ contact: string; venue: string; names: string[] } | null>(null);

  useEffect(() => { call<Menu>().then((r) => (r.ok ? setMenu(r.data) : setErr(r.message))); }, []);

  const setL = (i: number, v: Partial<Leader>) => setLeaders(leaders.map((l, k) => (k === i ? { ...l, ...v } : l)));
  const need = (bad: boolean) => (tried && bad ? 'need' : undefined);

  function problem(): string | null {
    if (!venue) return '請選擇團練場';
    if (venue === OTHER && !venueText.trim()) return '請填寫團練場名稱';
    if (!head.name.trim()) return '請填寫負責人姓名';
    if (!head.phone.trim()) return '請填寫負責人手機';
    const hp = phoneProblem(head.phone); if (hp) return `負責人${hp}`;
    for (const [i, l] of leaders.entries()) {
      const n = leaders.length > 1 ? `第 ${i + 1} 位揪團人` : '揪團人';
      if (!l.sameAsHead) {
        if (!l.name.trim()) return `請填寫${n}姓名`;
        if (!l.phone.trim()) return `請填寫${n}手機`;
        const p = phoneProblem(l.phone); if (p) return `${n}${p}`;
      }
      if (!l.noEmail && !l.email.trim()) return `請填寫${n} Email（沒有請勾「沒有 Email」）`;
      if (!l.noEmail && !emailOk(l.email)) return `${n} Email 格式不正確`;
    }
    if (!consent) return '請勾選同意提供資料';
    return null;
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    const p = problem();
    if (p) { setErr(p); return; }
    setBusy(true); setErr('');
    const r = await call<{ id: number; contact: string }>({
      venueId: venue && venue !== OTHER ? Number(venue) : null, venueText: venue === OTHER ? venueText : '',
      headName: head.name, headPhone: head.phone, leaders, consent,
    });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setDone({ contact: r.data.contact, venue: venue === OTHER ? venueText.trim() : menu?.venues.find((v) => String(v.id) === venue)?.name ?? '',
      names: leaders.map((l) => (l.sameAsHead ? head.name : l.name).trim()) });
    window.scrollTo(0, 0);
  }

  function again() {
    setDone(null); setTried(false); setErr(''); setVenue(''); setVenueText(''); setHead({ name: '', phone: '' }); setLeaders([blank(true)]); setConsent(false);
  }

  if (err && !menu) return <main className="wrap join"><div className="card"><p className="note err">{err}</p></div></main>;
  if (!menu) return <main className="wrap join"><div className="card muted">載入中…</div></main>;

  const head_ = (
    <div className="card">
      <h1 style={{ margin: '0 0 4px' }}>揪團登記</h1>
      <div className="muted">{menu.event.name}・{fmtDate(menu.event.showAt)}</div>
    </div>
  );

  if (!menu.open) return <main className="wrap join">{head_}<div className="note" style={{ textAlign: 'center', padding: 16 }}>揪團登記目前尚未開放，敬請期待。</div></main>;

  if (done) return (
    <main className="wrap join">
      {head_}
      <div className="card" style={{ borderTop: '4px solid var(--ok)' }}>
        <h2 style={{ marginTop: 0 }}>已收到！</h2>
        <p>之後會寄出揪團人連結。資料有誤請聯絡{done.contact}。</p>
        <div className="bank">
          <span className="muted">團練場</span><span>{done.venue}</span>
          <span className="muted">揪團人</span><span>{done.names.join('、')}</span>
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={again}>再登記一份</button>
      </div>
    </main>
  );

  return (
    <main className="wrap join">
      {head_}
      <p style={{ margin: '0 4px 12px' }}>感謝護持！約 1 分鐘就能完成。</p>
      <form onSubmit={send} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card">
          <h2>一、團練場</h2>
          <select aria-label="團練場" value={venue} className={need(!venue)} onChange={(e) => setVenue(e.target.value)}>
            <option value="">請選擇</option>
            {menu.venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            <option value={OTHER}>其他（請填）</option>
          </select>
          {venue === OTHER && <input style={{ marginTop: 8 }} aria-label="團練場名稱" placeholder="例：台北木柵" maxLength={30} value={venueText}
            className={need(!venueText.trim())} onChange={(e) => setVenueText(e.target.value)} />}
        </div>

        <div className="card">
          <h2>二、負責人</h2>
          <div className="fields">
            <label className="f">姓名<input value={head.name} maxLength={30} autoComplete="name" className={need(!head.name.trim())} onChange={(e) => setHead({ ...head, name: e.target.value })} /></label>
            <label className="f">手機<input value={head.phone} inputMode="tel" autoComplete="tel" placeholder="0912-345-678" className={need(!head.phone.trim() || !!phoneProblem(head.phone))} onChange={(e) => setHead({ ...head, phone: e.target.value })} /></label>
          </div>
          {phoneProblem(head.phone) && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{phoneProblem(head.phone)}</div>}
        </div>

        <div className="card">
          <h2>三、揪團人</h2>
          <p className="small muted" style={{ margin: '0 0 8px' }}>整理本團練場票務的人，可以和負責人同一位，也可以有好幾位。</p>
          {leaders.map((l, i) => (
            <div key={i} style={{ borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>{leaders.length > 1 ? `揪團人 ${i + 1}` : '揪團人'}</b>
                {leaders.length > 1 && <button type="button" className="btn small" onClick={() => setLeaders(leaders.filter((_, k) => k !== i))}>移除</button>}
              </div>
              {(i === 0 || l.sameAsHead) && (
                <label className="check" style={{ margin: '6px 0' }}>
                  <input type="checkbox" checked={l.sameAsHead} onChange={(e) => setL(i, { sameAsHead: e.target.checked })} />
                  <span>同負責人{l.sameAsHead && head.name.trim() && <span className="muted">（{head.name.trim()}）</span>}</span>
                </label>
              )}
              {!l.sameAsHead && (
                <div className="fields" style={{ marginTop: 6 }}>
                  <label className="f">姓名<input value={l.name} maxLength={30} className={need(!l.name.trim())} onChange={(e) => setL(i, { name: e.target.value })} /></label>
                  <label className="f">手機<input value={l.phone} inputMode="tel" placeholder="0912-345-678" className={need(!l.phone.trim() || !!phoneProblem(l.phone))} onChange={(e) => setL(i, { phone: e.target.value })} /></label>
                </div>
              )}
              {!l.sameAsHead && phoneProblem(l.phone) && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{phoneProblem(l.phone)}</div>}
              {!l.noEmail && (
                <label className="f" style={{ marginTop: 8 }}>Email（揪團人連結會寄到這裡）
                  <input type="email" inputMode="email" autoComplete="email" value={l.email} maxLength={120}
                    className={need(!emailOk(l.email))} onChange={(e) => setL(i, { email: e.target.value })} /></label>
              )}
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={l.noEmail} onChange={(e) => setL(i, { noEmail: e.target.checked })} />
                <span className="small">沒有 Email（改用 LINE 傳連結）</span>
              </label>
            </div>
          ))}
          {leaders.length < MAX && (
            <button type="button" className="btn" style={{ marginTop: 12, width: '100%' }} onClick={() => setLeaders([...leaders, blank()])}>＋ 新增一位揪團人</button>
          )}
        </div>

        <label className="check card" style={{ margin: 0 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>同意提供以上資料，用於本活動贈票服務。</span>
        </label>

        {err && <p className="note err" style={{ margin: 0 }}>{err}</p>}
        <button className="btn pri" style={{ padding: 14, fontSize: 18 }} disabled={busy}>{busy ? '送出中…' : '送出'}</button>
      </form>
    </main>
  );
}
