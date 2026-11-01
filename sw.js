/* Zayu 通知辅助 Service Worker
 * 作用：让「切后台 / 锁屏」时仍能弹出系统通知（安卓 Chrome 等浏览器只允许通过 SW 发通知）。
 * 用法：把它和 index.html 放在同一目录，用 https（或 localhost）访问即可，无需其它配置。
 */
const CACHE = 'zayu-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// 页面每 20 秒发一次心跳，让 SW 保持激活，后台弹通知更稳
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'heartbeat' && e.source) {
    try { e.source.postMessage({ type: 'pong' }); } catch (_) {}
  }
});

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();

  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // 来电通知上的「接听 / 挂断」
    if (data.kind === 'call' && (e.action === 'accept' || e.action === 'reject')) {
      for (const c of list) {
        try { c.postMessage({ type: 'call-action', action: e.action }); } catch (_) {}
      }
      for (const c of list) {
        if ('focus' in c) { try { await c.focus(); } catch (_) {} break; }
      }
      return;
    }

    // 普通点击：聚焦已有窗口，没有就打开
    for (const c of list) {
      if ('focus' in c) { try { await c.focus(); } catch (_) {} return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(data.url || './');
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(req).then((hit) =>
        hit || fetch(req).then((resp) => {
          try { c.put(req, resp.clone()); } catch (_) {}
          return resp;
        }).catch(() => hit)
      )
    )
  );
});
