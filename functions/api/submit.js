/**
 * POST /api/submit —— 网站投稿接收（Cloudflare Pages Function）
 *
 * 链路：浏览器 → 本函数（与站点同域，github.io 走 CORS）→ Telegram Bot API → 你的 TG
 * 设计要点（与 79 号手册 §3.7 / 23 号手册"藏源"原则一致）：
 *   1. VPS 完全不参与，源站 IP 永不暴露给前端
 *   2. bot token 只存 CF 加密环境变量（wrangler pages secret put），前端一行都没有
 *   3. 纯文本发送（不带 parse_mode）→ 天然免疫 Markdown/HTML 注入
 *   4. 四道闸：蜜罐字段 / 最短填写时长 / 每 IP 限流 / Turnstile（配了 secret 才强制）
 *
 * 环境变量（可选配齐，缺 Turnstile 时自动降级为前三道闸）：
 *   TELEGRAM_BOT_TOKEN  —— 必填
 *   TELEGRAM_CHAT_ID    —— 必填（发给谁）
 *   TURNSTILE_SECRET    —— 可选，填了就强制校验
 */

const ALLOWED_ORIGINS = [
  "https://muzimi67.pages.dev",
  "https://muzimi67.github.io",
];

const MAX_IDEA = 1200;      // 正文上限（TG 单条 4096 字符，留足余量）
const MAX_NAME = 24;
const MAX_CONTACT = 64;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // Telegram sendPhoto 上限 10MB
const MIN_FILL_MS = 2500;                  // 人类最短填写时长

/* 每 isolate 内存限流：单 IP 15 秒 1 条、10 分钟 5 条（跨 isolate 不精确，够挡住脚本刷） */
const hits = new Map();

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResp(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 5) return true;
  if (arr.length && now - arr[arr.length - 1] < 15 * 1000) return true;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

async function tg(env, method, form) {
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method;
  const r = await fetch(url, { method: "POST", body: form });
  let j = {};
  try { j = await r.json(); } catch (e) { j = { ok: false, description: "non-json " + r.status }; }
  return j;
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, why: "missing-token" };
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const j = await r.json();
    return { ok: !!j.success, why: (j["error-codes"] || []).join(",") || "" };
  } catch (e) {
    return { ok: false, why: "verify-fetch-failed" };
  }
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/\u0000/g, "").trim().slice(0, max);
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("Origin") || "") });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin") || "";
  const ip = request.headers.get("CF-Connecting-IP") || "";

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return jsonResp({ ok: false, error: "server-not-configured" }, 500, origin);
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResp({ ok: false, error: "bad-body" }, 400, origin);
  }

  /* 闸 1：蜜罐 */
  if (clean(form.get("website"), 50)) {
    return jsonResp({ ok: true, note: "ignored" }, 200, origin);   // 假装成功，别给机器人反馈
  }

  /* 闸 2：最短填写时长 */
  const t0 = parseInt(form.get("t0") || "0", 10);
  if (!t0 || Date.now() - t0 < MIN_FILL_MS) {
    return jsonResp({ ok: false, error: "too-fast" }, 429, origin);
  }

  /* 闸 3：限流 */
  if (ip && rateLimited(ip)) {
    return jsonResp({ ok: false, error: "rate-limited" }, 429, origin);
  }

  /* 闸 4：Turnstile */
  const ts = await verifyTurnstile(env, form.get("cf-turnstile-response"), ip);
  if (!ts.ok) {
    return jsonResp({ ok: false, error: "captcha", why: ts.why }, 403, origin);
  }

  const name = clean(form.get("name"), MAX_NAME);
  const contact = clean(form.get("contact"), MAX_CONTACT);
  const idea = clean(form.get("idea"), MAX_IDEA);
  if (idea.length < 2) {
    return jsonResp({ ok: false, error: "empty" }, 400, origin);
  }

  const files = form.getAll("images").filter((f) => f && typeof f === "object" && f.size > 0);
  if (files.length > MAX_FILES) {
    return jsonResp({ ok: false, error: "too-many-images", max: MAX_FILES }, 400, origin);
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return jsonResp({ ok: false, error: "image-too-big", maxMB: MAX_FILE_BYTES / 1024 / 1024 }, 400, origin);
    }
    if (f.type && !/^image\//.test(f.type)) {
      return jsonResp({ ok: false, error: "not-image" }, 400, origin);
    }
  }

  const when = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
  const head = [
    "📮 网站新投稿",
    "称呼：" + (name || "（没留）"),
    "联系：" + (contact || "（没留）"),
    "时间：" + when + " (UTC+8)",
    "图：" + files.length + " 张",
    "IP：" + (ip || "-"),
    "——————",
  ].join("\n");

  /* ① 正文 */
  const msgForm = new FormData();
  msgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
  msgForm.append("text", head + "\n" + idea);          // 纯文本，不设 parse_mode
  msgForm.append("disable_web_page_preview", "true");
  const sentMsg = await tg(env, "sendMessage", msgForm);
  if (!sentMsg.ok) {
    return jsonResp({ ok: false, error: "telegram-message-failed", why: sentMsg.description || "" }, 502, origin);
  }

  /* ② 图片（逐张 sendPhoto；单张失败不影响整体） */
  let sentImgs = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const pf = new FormData();
    pf.append("chat_id", env.TELEGRAM_CHAT_ID);
    pf.append("caption", "图 " + (i + 1) + "/" + files.length + (name ? " · " + name : ""));
    pf.append("photo", f, f.name || ("pic" + (i + 1) + ".jpg"));
    const r = await tg(env, "sendPhoto", pf);
    if (r.ok) sentImgs++;
  }

  return jsonResp({ ok: true, images: sentImgs }, 200, origin);
}
