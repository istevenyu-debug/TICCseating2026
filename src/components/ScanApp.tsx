'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Info = { gate: string; event: string; showAt: string; total: number; entered: number; here: number };
type Ok = { result: 'ok'; serial: string; label: string; code: string; zoneName: string; side: string; holderName: string; holderId4: string; orderNo: string; manual: boolean };
type Used = { result: 'used'; serial: string; label: string; holderName: string; at: string; gate: string };
type Bad = { result: 'invalid'; reason: string };
type Res = (Ok | Used | Bad) & { total: number; entered: number; here: number };
type Found = { serial: string; label: string; holderName: string; holderId4: string; entered: string | null };

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

async function call<T>(url: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, message: '網路連線異常，請確認手機網路。' }; }
}

/** 提示音：成功高音一聲、失敗低音兩聲 */
function beep(ok: boolean) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const tone = (f: number, start: number, len: number) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, ctx.currentTime + start); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + len);
      o.start(ctx.currentTime + start); o.stop(ctx.currentTime + start + len);
    };
    if (ok) tone(1320, 0, 0.18); else { tone(220, 0, 0.22); tone(220, 0.3, 0.22); }
    navigator.vibrate?.(ok ? 80 : [200, 100, 200]);
  } catch { /* 無聲 */ }
}

/** 手機驗票頁：鏡頭連續掃描，結果以全螢幕綠／紅顯示 */
export default function ScanApp({ token }: { token: string }) {
  const url = `/api/scan/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [fatal, setFatal] = useState('');
  const [res, setRes] = useState<Res | null>(null);
  const [cam, setCam] = useState<'off' | 'starting' | 'on' | 'error'>('off');
  const [camErr, setCamErr] = useState('');
  const [serial, setSerial] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const busy = useRef(false);
  const last = useRef({ text: '', at: 0 });
  const hold = useRef(0); // 顯示結果期間暫停掃描

  const load = useCallback(async () => {
    const r = await call<Info>(url);
    if (r.ok) setInfo(r.data); else setFatal(r.message);
  }, [url]);
  useEffect(() => { load(); const i = setInterval(load, 20_000); return () => clearInterval(i); }, [load]);

  const submit = useCallback(async (body: { qr?: string; serial?: string }) => {
    if (busy.current) return;
    busy.current = true;
    const r = await call<Res>(url, body);
    busy.current = false;
    if (!r.ok) { setRes({ result: 'invalid', reason: r.message, total: info?.total ?? 0, entered: info?.entered ?? 0, here: info?.here ?? 0 }); beep(false); return; }
    setRes(r.data);
    setInfo((p) => (p ? { ...p, total: r.data.total, entered: r.data.entered, here: r.data.here } : p));
    beep(r.data.result === 'ok');
    hold.current = Date.now() + (r.data.result === 'ok' ? 1800 : 3500);
  }, [url, info]);

  async function startCam() {
    setCam('starting'); setCamErr('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setCam('on');
    } catch (e) {
      setCam('error');
      const n = (e as Error).name;
      setCamErr(n === 'NotAllowedError' ? '沒有相機權限：請在瀏覽器設定允許此網站使用相機，再重新整理。' : n === 'NotFoundError' ? '找不到相機。' : '無法開啟相機，可改用下方手動輸入序號。');
    }
  }
  useEffect(() => () => stream.current?.getTracks().forEach((x) => x.stop()), []);

  // 掃描迴圈：優先用瀏覽器內建 BarcodeDetector，沒有就用 jsQR
  useEffect(() => {
    if (cam !== 'on') return;
    let alive = true;
    let detector: { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } | null = null;
    const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => typeof detector }).BarcodeDetector;
    if (BD) { try { detector = new BD({ formats: ['qr_code'] }); } catch { detector = null; } }
    let jsQR: ((d: Uint8ClampedArray, w: number, h: number) => { data: string } | null) | null = null;
    import('jsqr').then((m) => { jsQR = m.default as unknown as typeof jsQR; });
    const tick = async () => {
      if (!alive) return;
      const v = video.current;
      if (v && v.readyState >= 2 && Date.now() > hold.current && !busy.current) {
        let text = '';
        try {
          if (detector) text = (await detector.detect(v))[0]?.rawValue ?? '';
          else if (jsQR) {
            const w = 640; const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
            const c = canvas.current ?? (canvas.current = document.createElement('canvas'));
            c.width = w; c.height = h;
            const g = c.getContext('2d', { willReadFrequently: true })!;
            g.drawImage(v, 0, 0, w, h);
            text = jsQR(g.getImageData(0, 0, w, h).data, w, h)?.data ?? '';
          }
        } catch { text = ''; }
        if (text && !(text === last.current.text && Date.now() - last.current.at < 4000)) {
          last.current = { text, at: Date.now() };
          await submit({ qr: text });
        }
      }
      setTimeout(tick, 120);
    };
    tick();
    return () => { alive = false; };
  }, [cam, submit]);

  if (fatal) return <main className="scan"><div className="scan-card bad"><div className="scan-big">無法使用</div><div>{fatal}</div></div></main>;
  if (!info) return <main className="scan"><div className="scan-card">載入中…</div></main>;

  const kind = res ? res.result : null;
  return (
    <main className="scan">
      <header className="scan-head">
        <div><b>驗票・{info.gate}</b><div className="scan-sub">{info.event}</div></div>
        <div className="scan-count"><b>{info.entered}</b> / {info.total}<div className="scan-sub">本門 {info.here}</div></div>
      </header>

      <div className="scan-cam">
        <video ref={video} playsInline muted aria-label="相機畫面" style={{ display: cam === 'on' ? 'block' : 'none' }} />
        {cam === 'on' && <div className="scan-frame" aria-hidden="true" />}
        {cam !== 'on' && (
          <div className="scan-start">
            <button className="scan-btn" onClick={startCam} disabled={cam === 'starting'}>{cam === 'starting' ? '開啟相機中…' : '開始掃描'}</button>
            {camErr && <p className="scan-err">{camErr}</p>}
          </div>
        )}
        {res && (
          <div className={`scan-result ${kind === 'ok' ? 'good' : 'bad'}`} role="status" onClick={() => { setRes(null); hold.current = 0; }}>
            {res.result === 'ok' && <>
              <div className="scan-big">✓ 可入場</div>
              <div className="scan-seat">{res.label}</div>
              <div>{res.zoneName}・{res.code}{res.side ? `・${res.side}` : ''}</div>
              <div className="scan-holder">持票人 <b>{res.holderName}</b>　證 <b>{res.holderId4}</b></div>
              <div className="scan-sub">請核對身分證件{res.manual ? '・手動入場' : ''}</div>
            </>}
            {res.result === 'used' && <>
              <div className="scan-big">✗ 已入場過</div>
              <div className="scan-seat">{res.label}</div>
              <div>持票人 {res.holderName}</div>
              <div className="scan-holder">已於 <b>{hhmm(res.at)}</b> 從 <b>{res.gate}</b> 入場</div>
            </>}
            {res.result === 'invalid' && <>
              <div className="scan-big">✗ 無效</div>
              <div className="scan-holder">{res.reason}</div>
            </>}
            <div className="scan-sub" style={{ marginTop: 10 }}>點一下繼續</div>
          </div>
        )}
      </div>

      <section className="scan-tools">
        <form onSubmit={(e) => { e.preventDefault(); if (serial.trim()) { submit({ serial: serial.trim() }); setSerial(''); } }} className="scan-row">
          <input value={serial} onChange={(e) => setSerial(e.target.value.toUpperCase())} placeholder="手動輸入序號，例 T1-00001-01" aria-label="手動輸入序號" autoCapitalize="characters" />
          <button className="scan-btn small" disabled={!serial.trim()}>入場</button>
        </form>
        <form onSubmit={async (e) => {
          e.preventDefault();
          const r = await call<{ results: Found[] }>(`${url}?q=${encodeURIComponent(q.trim())}`);
          setFound(r.ok ? r.data.results : []);
        }} className="scan-row">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋姓名、手機或訂單編號（忘記帶票）" aria-label="搜尋票券" />
          <button className="scan-btn small ghost" disabled={q.trim().length < 2}>搜尋</button>
        </form>
        {found && (
          <div className="scan-found">
            {found.length ? found.map((f) => (
              <div key={f.serial} className="scan-item">
                <span><b>{f.label}</b>　{f.holderName}（{f.holderId4}）<br /><span className="scan-sub">{f.serial}</span></span>
                {f.entered ? <span className="scan-sub">已入場 {hhmm(f.entered)}</span>
                  : <button className="scan-btn small" onClick={async () => { await submit({ serial: f.serial }); setFound(null); setQ(''); }}>入場</button>}
              </div>
            )) : <div className="scan-sub">查無資料</div>}
          </div>
        )}
        <p className="scan-sub">手動入場請先核對身分證件。結果畫面點一下即可繼續掃下一張。</p>
      </section>
    </main>
  );
}
