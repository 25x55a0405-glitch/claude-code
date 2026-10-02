// Sky's service worker: shows push notifications and opens the right screen.
// The server sends JSON { title, body, url, tag }, where url is a hash route.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Sky';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '#/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.url) || '#/';
  const target = new URL(self.registration.scope).origin + '/' + (hash.startsWith('#') ? hash : '#' + hash);
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === new URL(target).origin) {
        await c.focus();
        return c.navigate ? c.navigate(target) : undefined;
      }
    }
    return self.clients.openWindow(target);
  })());
});
