// functions/api/ds-order.js
// DeepSeek 充值「指令中继」：访客 POST -> 写指令到 GitHub ds-cmd 分支 cmd.json -> 本机守护接单
// Function 只持 GH_PAT（只能写 cmd.json 一个文件）；DeepSeek token 永不出本机
// 防御：Origin 白名单 + 每 IP 限流 + 参数白名单 + 指令只能带 PAT 写入
// 结果通道：守护把 res_{nonce}.json 推到 qr-data 分支，前端走 jsdelivr 轮询

const ALLOWED_ORIGINS = ['https://muzimi67.github.io', 'https://muzimi67.pages.dev'];
const LIMIT = 6;        // 每 IP 每窗口最多下单次数
const WIN = 60000;      // 60s 窗口
const hits = new Map(); // ip -> [ts, ...]（单实例内存计数，重启清零，够用）
const GH_API = 'https://api.github.com/repos/muzimi67/muzimi67.github.io/contents/cmd.json';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(h, obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...h, 'Content-Type': 'application/json' } });
}

function ghHeaders(pat) {
  return {
    'Authorization': 'Bearer ' + pat,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ds-order-relay',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') || '') });
}

export async function onRequestGet() {
  return new Response('POST only', { status: 405 });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  const h = corsHeaders(origin);
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json(h, { error: 'forbidden' }, 403);
  }
  if (!env.GH_PAT) {
    return json(h, { error: 'not_configured' }, 500);
  }

  // ---- 每 IP 限流 ----
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WIN);
  if (arr.length >= LIMIT) {
    return json(h, { error: 'rate_limited' }, 429);
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some(t => now - t < WIN)) hits.delete(k);
    }
  }

  // ---- 参数白名单 ----
  let body;
  try { body = await request.json(); } catch { return json(h, { error: 'bad_json' }, 400); }
  const amt = Number(body.amount);
  if (!Number.isInteger(amt) || amt < 1 || amt > 500) {
    return json(h, { error: 'bad_amount' }, 400);
  }
  const method = body.method === 'alipay' ? 'ALIPAY' : body.method === 'wechat' ? 'WECHAT' : null;
  if (!method) {
    return json(h, { error: 'bad_method' }, 400);
  }

  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const cmd = { nonce, method, amount: amt, ts: now };

  // ---- GET sha -> PUT cmd.json @ds-cmd（409 sha 冲突重试3次） ----
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const g = await fetch(GH_API + '?ref=ds-cmd', { headers: ghHeaders(env.GH_PAT) });
      if (!g.ok && g.status !== 404) { lastErr = 'gh_get_' + g.status; continue; }
      let sha = null;
      if (g.ok) { const gj = await g.json(); sha = gj.sha; }
      const put = await fetch(GH_API, {
        method: 'PUT',
        headers: ghHeaders(env.GH_PAT),
        body: JSON.stringify({
          message: 'cmd ' + nonce,
          branch: 'ds-cmd',
          content: btoa(JSON.stringify(cmd)),
          ...(sha ? { sha } : {}),
        }),
      });
      if (put.ok) {
        return json(h, { nonce, status: 'queued' });
      }
      lastErr = 'gh_put_' + put.status;
      if (put.status === 409) continue;
      break;
    } catch (e) {
      lastErr = 'gh_exc_' + String(e).slice(0, 60);
    }
  }
  return json(h, { error: 'relay_failed', why: lastErr }, 502);
}
