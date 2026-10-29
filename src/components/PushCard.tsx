'use client';

import { useEffect, useState } from 'react';

type State = 'checking' | 'unsupported' | 'ios-home' | 'off' | 'on' | 'denied' | 'busy';

function keyBytes(b64: string) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * 「劃位結果直接通知這支手機」：開啟後，主辦方確認到帳時手機會跳出通知，即使購票頁已關閉。
 * Android Chrome 直接可用；iPhone 需先「加入主畫面」並從主畫面開啟。
 */
export default function PushCard({ endpoint, api, compact, title = '📱 劃位結果直接通知這支手機', offText, onText }: {
  endpoint: string;
  api: <T>(url: string, body?: unknown) => Promise<{ ok: true; data: T } | { ok: false; message: string }>;
  compact: boolean;
  title?: string;
  offText?: React.ReactNode;
  onText?: React.ReactNode;
}) {
  const [st, setSt] = useState<State>('checking');
  const [err, setErr] = useState('');
  const url = endpoint;

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (!ok) { setSt(ios && !standalone ? 'ios-home' : 'unsupported'); return; }
      if (Notification.permission === 'denied') { setSt('denied'); return; }
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        if (sub && Notification.permission === 'granted') {
          await api(url, sub.toJSON()); // 同一支手機可能換了連結，重新登記
          setSt('on');
        } else setSt('off');
      } catch { setSt('off'); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function enable() {
    setErr(''); setSt('busy');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setSt(perm === 'denied' ? 'denied' : 'off'); return; }
      const k = await api<{ publicKey: string }>(url);
      if (!k.ok) throw new Error(k.message);
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription())
        ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.data.publicKey) });
      const r = await api(url, sub.toJSON());
      if (!r.ok) throw new Error(r.message);
      setSt('on');
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 120)); setSt('off');
    }
  }

  if (st === 'checking' || st === 'unsupported') return null;
  if (st === 'on') return compact ? null : <div className="note ok small">{onText ?? '✓ 已開啟手機通知：主辦方確認到帳後，這支手機會直接跳出「劃位成功」通知。'}</div>;
  return (
    <div className="card pushcard">
      <h2>{title}</h2>
      {st === 'ios-home' ? (
        <p className="small" style={{ margin: 0 }}>
          iPhone 請先把這頁加入主畫面：按 Safari 下方的 <b>分享</b> 按鈕 →「<b>加入主畫面</b>」，再<b>從主畫面的「劃位」圖示打開</b>，就會出現「開啟通知」按鈕。
          <br /><span className="muted">不開啟也沒關係：劃位結果一樣會顯示在這一頁，也會寄簡訊與 Email。</span>
        </p>
      ) : st === 'denied' ? (
        <p className="small" style={{ margin: 0 }}>這支手機已封鎖本網站的通知。如要開啟，請到瀏覽器的網站設定允許「通知」。劃位結果一樣會顯示在這一頁。</p>
      ) : (
        <>
          <p className="small" style={{ margin: '0 0 8px' }}>{offText ?? <>開啟後，主辦方確認到帳時，手機會直接跳出「劃位成功」通知，<b>不用一直開著這頁</b>。</>}</p>
          <button className="btn pri" style={{ width: '100%' }} disabled={st === 'busy'} onClick={enable}>{st === 'busy' ? '開啟中…' : '開啟通知'}</button>
          {err && <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>無法開啟通知：{err}</div>}
        </>
      )}
    </div>
  );
}
