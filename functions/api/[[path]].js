// Zayu 推送 Worker（Cloudflare Workers，ES Module）
// 路由：/sub /ping /plan /pending /log /backup /health

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS),
  });
}

function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function keyOf(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

async function vapidJWT(endpoint, env) {
  const origin = new URL(endpoint).origin;
  const enc = (s) => b64u(new TextEncoder().encode(s));
  const header = enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = enc(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.CONTACT || 'mailto:zayu@example.com',
  }));
  const unsigned = header + '.' + payload;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: env.VAPID_X, y: env.VAPID_Y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + b64u(sig);
}

async function sendPush(env, endpoint) {
  const jwt = await vapidJWT(endpoint, env);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC,
    },
  });
  return res.status;
}

async function getJSON(ns, k, dflt) {
  const v = await ns.get(k);
  if (!v) return dflt;
  try { return JSON.parse(v); } catch (e) { return dflt; }
}


export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/api/, '').replace(/\/+$/, '') || '/';

  try {
    if (path === '/health') return json({ ok: true, ts: Date.now(), mode: 'pages' });

    if (path === '/sub' && request.method === 'POST') {
      const b = await request.json();
      const sub = b.subscription;
      if (!sub || !sub.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(sub.endpoint);
      await env.PUSH_KV.put('s:' + k, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys || {}, at: Date.now() }));
      return json({ ok: true, key: k });
    }

    if (path === '/ping' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const status = await sendPush(env, b.endpoint);
      return json({ ok: status >= 200 && status < 300, status });
    }

    if (path === '/plan' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      const items = (b.items || []).filter((i) => i && i.at).slice(0, 200);
      await env.PUSH_KV.put('p:' + k, JSON.stringify(items));
      return json({ ok: true, count: items.length });
    }

    if (path === '/alive' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      await env.PUSH_KV.put('a:' + k, String(Date.now()));
      return json({ ok: true });
    }

    if (path === '/pending' && request.method === 'GET') {
      const ep = url.searchParams.get('endpoint');
      if (!ep) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(ep);
      const items = await getJSON(env.PUSH_KV, 'd:' + k, []);
      if (items.length) await env.PUSH_KV.delete('d:' + k);
      return json({ items });
    }

    if (path === '/log' && request.method === 'GET') {
      const ep = url.searchParams.get('endpoint');
      const since = Number(url.searchParams.get('since') || 0);
      if (!ep) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(ep);
      const all = await getJSON(env.PUSH_KV, 'l:' + k, []);
      return json({ items: all.filter((i) => (i.at || 0) >= since) });
    }

    if (path === '/backup' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint || !b.data) return json({ error: 'endpoint/data required' }, 400);
      const k = await keyOf(b.endpoint);
      await env.PUSH_KV.put('b:' + k, JSON.stringify({ at: Date.now(), data: b.data }));
      return json({ ok: true, size: b.data.length });
    }

    if (path === '/backup' && request.method === 'GET') {
      const ep = url.searchParams.get('endpoint');
      if (!ep) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(ep);
      const rec = await getJSON(env.PUSH_KV, 'b:' + k, null);
      if (!rec) return json({ error: 'not found' }, 404);
      return json(rec);
    }

    if (path === '/cron') {
      await runDue(env);
      return json({ ok: true });
    }

    return json({ error: 'not found', path }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
}

// 定时任务：检查所有订阅者的预排程，到点且页面已不在线时发 Web Push
async function runDue(env) {
  const now = Date.now();
  let cursor = undefined;

  do {
    const page = await env.PUSH_KV.list({ prefix: 's:', cursor });
    for (const key of page.keys) {
      const k = key.name.slice(2);
      const plan = await getJSON(env.PUSH_KV, 'p:' + k, []);
      if (!plan.length) continue;

      const due = plan.filter((i) => i && i.at <= now);
      if (!due.length) continue;

      const rest = plan.filter((i) => i && i.at > now);
      await env.PUSH_KV.put('p:' + k, JSON.stringify(rest));

      // 页面还活着（120 秒内有心跳）：它自己会弹通知，服务端直接跳过，避免重复
      const aliveRaw = await env.PUSH_KV.get('a:' + k);
      const alive = aliveRaw ? Number(aliveRaw) : 0;
      if (alive && now - alive < 120000) continue;

      const sub = await getJSON(env.PUSH_KV, 's:' + k, null);
      if (!sub) continue;

      const pushed = due.map((i) => ({
        id: i.id || ('x' + i.at),
        at: i.at,
        title: i.title || 'Zayu',
        body: i.body || '',
        kind: i.kind || 'msg',
        pushed: true,
      }));

      // 明细进日志（客户端打开页面时按 id 回填聊天记录），同时放进 pending 给 SW 取
      const log = await getJSON(env.PUSH_KV, 'l:' + k, []);
      await env.PUSH_KV.put('l:' + k, JSON.stringify(log.concat(pushed).slice(-200)));

      const pending = await getJSON(env.PUSH_KV, 'd:' + k, []);
      await env.PUSH_KV.put('d:' + k, JSON.stringify(pending.concat(pushed).slice(-50)), { expirationTtl: 3600 });

      try {
        const status = await sendPush(env, sub.endpoint);
        if (status === 404 || status === 410) {
          // 订阅已失效（用户卸载/重置），清理掉，避免一直报错
          await env.PUSH_KV.delete('s:' + k);
          await env.PUSH_KV.delete('p:' + k);
        }
      } catch (e) {}
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
