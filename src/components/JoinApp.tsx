'use client';

import { useEffect, useState } from 'react';
import { phoneProblem } from '@/lib/validation';

type Menu = { open: boolean; contact: string; event: { name: string; showAt: string }; venues: { id: number; name: string }[] };
type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

const OTHER = 'other';
export const fmtDate = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

async function call<T>(body?: unknown): Promise<Res<T>> {
  try {
    const r = await fetch('/api/join', body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, code: 'NETWORK', message: '網路連線異常，請確認後再試。' }; }
}

/** 揪團登記：負責人 4 欄（團練場、姓名、手機、Email） */
export default function JoinApp() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [err, setErr] = useState('');
  const [venue, setVenue] = useState('');
  const [venueText, setVenueText] = useState('');
  const [f, setF] = useState({ name: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<{ contact: string; venue: string } | null>(null);

  useEffect(() => { call<Menu>().then((r) => (r.ok ? setMenu(r.data) : setErr(r.message))); }, []);
  const need = (bad: boolean) => (tried && bad ? 'need' : undefined);

  function problem(): string | null {
    if (!venue) return '請選擇團練場';
    if (venue === OTHER && !venueText.trim()) return '請填寫團練場名稱';
    if (!f.name.trim()) return '請填寫負責人姓名';
    if (!f.phone.trim()) return '請填寫手機';
    const hp = phoneProblem(f.phone); if (hp) return hp;
    if (!f.email.trim()) return '請填寫 Email（連結會寄到這裡）';
    if (!emailOk(f.email)) return 'Email 格式不正確';
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
      headName: f.name, headPhone: f.phone, email: f.email,
    });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setDone({ contact: r.data.contact, venue: venue === OTHER ? venueText.trim() : menu?.venues.find((v) => String(v.id) === venue)?.name ?? '' });
    window.scrollTo(0, 0);
  }

  if (err && !menu) return <main className="wrap join"><div className="card"><p className="note err">{err}</p></div></main>;
  if (!menu) return <main className="wrap join"><div className="card muted">載入中…</div></main>;

  const head = (
    <div className="card">
      <h1 style={{ margin: '0 0 4px' }}>揪團登記</h1>
      <div className="muted">{menu.event.name}・{fmtDate(menu.event.showAt)}</div>
    </div>
  );

  if (!menu.open) return <main className="wrap join">{head}<div className="note" style={{ textAlign: 'center', padding: 16 }}>揪團登記目前尚未開放，敬請期待。</div></main>;

  if (done) return (
    <main className="wrap join">
      {head}
      <div className="card" style={{ borderTop: '4px solid var(--ok)' }}>
        <h2 style={{ marginTop: 0 }}>已收到！</h2>
        <p>之後會寄出連結。資料有誤請聯絡{done.contact}。</p>
        <div className="bank">
          <span className="muted">團練場</span><span>{done.venue}</span>
          <span className="muted">負責人</span><span>{f.name.trim()}</span>
        </div>
      </div>
    </main>
  );

  return (
    <main className="wrap join">
      {head}
      <p style={{ margin: '0 4px 12px' }}>感謝護持！請團練場負責人填寫，約 1 分鐘。</p>
      <form onSubmit={send} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="card">
          <label className="f">團練場
            <select value={venue} className={need(!venue)} onChange={(e) => setVenue(e.target.value)}>
              <option value="">請選擇</option>
              {menu.venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              <option value={OTHER}>其他（請填）</option>
            </select>
          </label>
          {venue === OTHER && <input style={{ marginTop: 8 }} aria-label="團練場名稱" placeholder="例：台北木柵" maxLength={30} value={venueText}
            className={need(!venueText.trim())} onChange={(e) => setVenueText(e.target.value)} />}
          <label className="f" style={{ marginTop: 12 }}>負責人姓名
            <input value={f.name} maxLength={30} autoComplete="name" className={need(!f.name.trim())} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="f" style={{ marginTop: 12 }}>手機
            <input value={f.phone} inputMode="tel" autoComplete="tel" placeholder="0912-345-678" className={need(!f.phone.trim() || !!phoneProblem(f.phone))} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          {phoneProblem(f.phone) && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{phoneProblem(f.phone)}</div>}
          <label className="f" style={{ marginTop: 12 }}>Email（連結會寄到這裡）
            <input type="email" inputMode="email" autoComplete="email" value={f.email} maxLength={120} className={need(!emailOk(f.email))} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        {err && <p className="note err" style={{ margin: 0 }}>{err}</p>}
        <button className="btn pri" style={{ padding: 14, fontSize: 18 }} disabled={busy}>{busy ? '送出中…' : '送出'}</button>
        <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>資料僅用於本活動贈票聯絡</p>
      </form>
    </main>
  );
}
