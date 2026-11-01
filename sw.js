/* Zayu 通知辅助 Service Worker
 * 作用：让「切后台 / 锁屏 / 页面被冻结」时仍能弹出系统通知。
 * 用法：和 index.html 放在同一目录，用 https 访问即可。
 */
const CACHE = 'zayu-v2';
const NOTIFY_ICON = './icon-192.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// 页面心跳：让 SW 保持激活
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'heartbeat' && e.source) {
    try { e.source.postMessage({ type: 'pong' }); } catch (_) {}
  }
});

// ====== Web Push：服务端推来「有消息」，SW 自己去取明细并逐条弹通知 ======
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let items = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub && sub.endpoint) {
        const r = await fetch('/api/pending?endpoint=' + encodeURIComponent(sub.endpoint), { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          items = Array.isArray(j.items) ? j.items : [];
        }
      }
    } catch (_) {}

    if (!items.length) {
      items = [{
        id: 'g' + Date.now(),
        title: 'Zayu',
        body: '对方发来一条新消息',
        kind: 'msg',
      }];
    }

    for (const it of items) {
      const title = String(it.title || 'Zayu');
      const body = String(it.body || '');
      const isCall = it.kind === 'call';
      const opts = {
        body,
        icon: NOTIFY_ICON,
        badge: NOTIFY_ICON,
        silent: !isCall,
        renotify: true,
        requireInteraction: isCall,
        tag: 'zayu-push-' + (it.id || (it.at || Date.now()) + '-' + Math.random().toString(36).slice(2, 6)),
        data: { kind: it.kind || 'msg', url: './', entryId: it.id || '' },
      };
      try { await self.registration.showNotification(title, opts); } catch (_) {}
    }
  })());
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

  // API 与跨域请求一律走网络，绝不缓存（否则会读到过期数据）
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (_) { return; }
  if (!sameOrigin || req.url.indexOf('/api/') >= 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(req).then((hit) =>
        hit || fetch(req).then((resp) => {
          try { if (resp && resp.ok) c.put(req, resp.clone()); } catch (_) {}
          return resp;
        }).catch(() => hit)
      )
    )
  );
});
