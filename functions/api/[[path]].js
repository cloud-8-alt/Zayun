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


function b64uDecode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 浏览器订阅用的公钥是 65 字节未压缩点（04 + X + Y）；
// env.VAPID_PUBLIC 只存了 X+Y，这里补上 04 前缀后再给推送服务
function vapidKey65(env) {
  if (env.VAPID_X && env.VAPID_Y) {
    const x = b64uDecode(env.VAPID_X);
    const y = b64uDecode(env.VAPID_Y);
    const out = new Uint8Array(65);
    out[0] = 4;
    out.set(x, 1);
    out.set(y, 33);
    return b64u(out);
  }
  const raw = b64uDecode(env.VAPID_PUBLIC);
  if (raw.length === 65) return b64u(raw);
  const out2 = new Uint8Array(65);
  out2[0] = 4;
  out2.set(raw, 1);
  return b64u(out2);
}

async function sendPush(env, endpoint) {
  const jwt = await vapidJWT(endpoint, env);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      Authorization: 'vapid t=' + jwt + ', k=' + vapidKey65(env),
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
      await env.PUSH_KV.put('s:' + k, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys || {}, at: Date.now() }), { expirationTtl: 60 * 60 * 24 * 365 });
      return json({ ok: true, key: k });
    }

    if (path === '/ping' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const status = await sendPush(env, b.endpoint);
      return json({ ok: status >= 200 && status < 300, status });
    }

    // 合并写入：心跳 + 预排程 + 宽限窗口只占 1 次 KV 写（客户端每 2 分钟调用一次）
    if (path === '/beat' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      const plan = (b.plan || []).filter((i) => i && i.at).slice(0, 300);
      const grace = Math.max(120000, Math.min(Number(b.grace) || 300000, 24 * 3600000));
      const at = Number(b.at) || Date.now();
      await env.PUSH_KV.put('k:' + k, JSON.stringify({ at, grace, plan }), { expirationTtl: 60 * 60 * 4 });
      return json({ ok: true, count: plan.length, at, grace });
    }

    if (path === '/plan' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      const items = (b.items || []).filter((i) => i && i.at).slice(0, 200);
      await env.PUSH_KV.put('p:' + k, JSON.stringify(items), { expirationTtl: 60 * 60 * 24 * 7 });
      if (b.grace) {
        const g = String(Math.max(120000, Math.min(Number(b.grace) || 0, 24 * 3600000)));
        const prev = await env.PUSH_KV.get('g:' + k);
        if (prev !== g) await env.PUSH_KV.put('g:' + k, g, { expirationTtl: 60 * 60 * 24 * 30 });
      }
      return json({ ok: true, count: items.length });
    }

    if (path === '/alive' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      await env.PUSH_KV.put('a:' + k, String(Date.now()), { expirationTtl: 600 });
      return json({ ok: true });
    }

    if (path === '/grace' && request.method === 'POST') {
      const b = await request.json();
      if (!b.endpoint) return json({ error: 'endpoint required' }, 400);
      const k = await keyOf(b.endpoint);
      const g = String(Math.max(120000, Math.min(Number(b.ms) || 0, 24 * 3600000)));
      const prev = await env.PUSH_KV.get('g:' + k);
      if (prev !== g) await env.PUSH_KV.put('g:' + k, g, { expirationTtl: 60 * 60 * 24 * 30 });
      return json({ ok: true, grace: Number(g) });
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
      if (!b.data || (!b.endpoint && !b.code)) return json({ error: 'endpoint/code/data required' }, 400);
      const rec = JSON.stringify({ at: Date.now(), data: b.data });
      const keys = [];
      if (b.endpoint) keys.push('b:' + await keyOf(b.endpoint));
      if (b.code) keys.push('b:' + await keyOf('code:' + String(b.code)));
      await Promise.all(keys.map((k) => env.PUSH_KV.put(k, rec, { expirationTtl: 60 * 60 * 24 * 730 })));
      return json({ ok: true, size: b.data.length, keys: keys.length });
    }

    if (path === '/backup' && request.method === 'GET') {
      const ep = url.searchParams.get('endpoint');
      const code = url.searchParams.get('code');
      if (!ep && !code) return json({ error: 'endpoint or code required' }, 400);
      const k = await keyOf(ep ? ep : ('code:' + code));
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
      // 优先读合并 key（心跳 + 预排程 + 宽限窗口），兼容旧的三键结构
      const merged = await getJSON(env.PUSH_KV, 'k:' + k, null);
      let plan, alive, grace;
      if (merged) {
        plan = merged.plan || [];
        alive = Number(merged.at) || 0;
        grace = Number(merged.grace) || 300000;
      } else {
        plan = await getJSON(env.PUSH_KV, 'p:' + k, []);
        alive = Number(await env.PUSH_KV.get('a:' + k)) || 0;
        grace = Number(await env.PUSH_KV.get('g:' + k)) || 300000;
      }
      if (!plan.length) continue;

      const due = plan.filter((i) => i && i.at <= now);
      if (!due.length) continue;

      // 超过 grace 没有心跳 = 已划掉 / 被系统回收 → 清空预排程，彻底停止推送
      if (!alive || now - alive > grace) {
        if (merged) await env.PUSH_KV.delete('k:' + k);
        else await env.PUSH_KV.put('p:' + k, '[]');
        continue;
      }

      // 页面还活着（3 分钟内有心跳）：通知由页面自己弹，服务端不写、不推
      if (now - alive < 180000) continue;

      const rest = plan.filter((i) => i && i.at > now);
      if (merged) {
        await env.PUSH_KV.put('k:' + k, JSON.stringify({ at: alive, grace, plan: rest }), { expirationTtl: 60 * 60 * 4 });
      } else {
        await env.PUSH_KV.put('p:' + k, JSON.stringify(rest), { expirationTtl: 60 * 60 * 24 * 7 });
      }

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
      await env.PUSH_KV.put('l:' + k, JSON.stringify(log.concat(pushed).slice(-200)), { expirationTtl: 60 * 60 * 24 * 30 });

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
