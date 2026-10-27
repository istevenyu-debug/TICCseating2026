/* 劃位系統：手機推播。收到主辦方訊息時跳出通知，點通知打開購票頁 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '主辦方通知', {
    body: d.body || '', data: { url: d.url || '/' }, tag: d.url || 'ticc', renotify: true, requireInteraction: true,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const path = new URL(url, self.location.origin).pathname;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname === path && 'focus' in w) { w.navigate && w.navigate(w.url); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
