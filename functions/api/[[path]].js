/**
 * /api/* —— 网站投稿后端（Cloudflare Pages Function，单文件多路由）
 *
 *   路由：
 *     POST /api/submit    投 稿：存 KV(票号) + 发 TG（消息带票号）
 *     GET  /api/reply?t=  查回复：凭票号读整段对话
 *     POST /api/followup  追 问：投稿人补一句 → 存 KV + 通知 TG
 *     POST /api/tg-hook   TG webhook：主人在 TG 里【回复】投稿消息 → 存进 KV
 *
 *   设计原则（79 号手册 §3.7）：
 *     1. VPS 完全不参与，源站 IP 永不暴露
 *     2. bot token / secret 只存 CF 加密环境变量
 *     3. 纯文本发送（不带 parse_mode）→ 免疫 Markdown/HTML 注入
 *     4. 四道闸：蜜罐 / 最短填写时长 / 每 IP 限流 / Turnstile
 *     5. 没有服务器也双向：靠 Telegram webhook —— TG 主动推给本函数
 *
 *   环境变量：TELEGRAM_BOT_TOKEN（必）· TELEGRAM_CHAT_ID（必）· TURNSTILE_SECRET（可选）
 *             TG_HOOK_SECRET（可选，配了才启用 webhook 回复台）· KV 绑定 SUBS（可选，配了才有票号/查回复）
 */

const ALLOWED_ORIGINS = ["https://muzimi67.pages.dev", "https://muzimi67.github.io"];

const MAX_IDEA = 1200;
const MAX_NAME = 24;
const MAX_CONTACT = 64;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_FILL_MS = 2500;
const KEEP_DAYS = 30;                       // 投稿与对话保留 30 天，到期自动消失
const TICKET_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   // 去掉 0O1I 等易混字符

const hits = new Map();                     // ip -> [ts]  （isolate 内存限流）

/* ---------- 小工具 ---------- */

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function rateLimited(ip, max, windowMs, gapMs) {
  if (!ip) return false;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  if (gapMs && arr.length && now - arr[arr.length - 1] < gapMs) return true;
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/\u0000/g, "").trim().slice(0, max);
}

function newTicket() {
  let s = "";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (const b of buf) s += TICKET_ALPHABET[b % TICKET_ALPHABET.length];
  return "MZ" + s;
}

function nowCST() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

async function tg(env, method, form) {
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method;
  const r = await fetch(url, { method: "POST", body: form });
  let j = {};
  try { j = await r.json(); } catch (e) { j = { ok: false, description: "non-json " + r.status }; }
  return j;
}

async function tgText(env, chatId, text) {
  const f = new FormData();
  f.append("chat_id", String(chatId));
  f.append("text", text);                    // 无 parse_mode = 纯文本，防注入
  f.append("disable_web_page_preview", "true");
  return tg(env, "sendMessage", f);
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

/* ---------- KV 读写（没绑 KV 时全部降级为"功能未启用"，投稿照常能发） ---------- */

async function kvGetSub(env, ticket) {
  if (!env.SUBS) return null;
  try { return await env.SUBS.get("sub:" + ticket, { type: "json" }); } catch (e) { return null; }
}

async function kvPutSub(env, rec) {
  if (!env.SUBS) return false;
  try {
    await env.SUBS.put("sub:" + rec.t, JSON.stringify(rec), { expirationTtl: KEEP_DAYS * 86400 });
    return true;
  } catch (e) { return false; }
}

/* ---------- 路由 ---------- */

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("Origin") || "") });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const path = url.pathname.replace(/\/+$/, "");        // 去掉尾斜杠

  if (request.method === "OPTIONS") return onRequestOptions(context);

  if (path.endsWith("/api/submit"))   return handleSubmit(context, origin);
  if (path.endsWith("/api/reply"))    return handleReply(context, origin);
  if (path.endsWith("/api/mine"))     return handleMine(context, origin);
  if (path.endsWith("/api/followup")) return handleFollowup(context, origin);
  if (path.endsWith("/api/tg-hook"))  return handleTgHook(context);

  return jsonResp({ ok: false, error: "not-found" }, 404, origin);
}

/* ===== 投稿 ===== */
async function handleSubmit({ request, env }, origin) {
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405, origin);
  const ip = request.headers.get("CF-Connecting-IP") || "";

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return jsonResp({ ok: false, error: "server-not-configured" }, 500, origin);
  }

  let form;
  try { form = await request.formData(); } catch (e) { return jsonResp({ ok: false, error: "bad-body" }, 400, origin); }

  if (clean(form.get("website"), 50)) return jsonResp({ ok: true, note: "ignored" }, 200, origin);   // 闸1 蜜罐

  const t0 = parseInt(form.get("t0") || "0", 10);
  if (!t0 || Date.now() - t0 < MIN_FILL_MS) return jsonResp({ ok: false, error: "too-fast" }, 429, origin);  // 闸2

  if (rateLimited(ip, 5, 10 * 60 * 1000, 15 * 1000)) return jsonResp({ ok: false, error: "rate-limited" }, 429, origin); // 闸3

  const ts = await verifyTurnstile(env, form.get("cf-turnstile-response"), ip);                       // 闸4
  if (!ts.ok) return jsonResp({ ok: false, error: "captcha", why: ts.why }, 403, origin);

  const name = clean(form.get("name"), MAX_NAME);
  const contact = clean(form.get("contact"), MAX_CONTACT);
  const idea = clean(form.get("idea"), MAX_IDEA);
  if (idea.length < 2) return jsonResp({ ok: false, error: "empty" }, 400, origin);

  const files = form.getAll("images").filter((f) => f && typeof f === "object" && f.size > 0);
  if (files.length > MAX_FILES) return jsonResp({ ok: false, error: "too-many-images", max: MAX_FILES }, 400, origin);
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) return jsonResp({ ok: false, error: "image-too-big", maxMB: MAX_FILE_BYTES / 1048576 }, 400, origin);
    if (f.type && !/^image\//.test(f.type)) return jsonResp({ ok: false, error: "not-image" }, 400, origin);
  }

  const ticket = newTicket();
  const when = nowCST();

  const head = [
    "📮 网站新投稿" + (env.SUBS ? " · 票号 " + ticket : ""),
    "称呼：" + (name || "（没留）"),
    "联系：" + (contact || "（没留）"),
    "时间：" + when + " (UTC+8)",
    "图：" + files.length + " 张",
    "IP：" + (ip || "-"),
    "——————",
  ].join("\n");
  const tail = env.SUBS ? "\n\n（回复本条消息即可回给投稿人，我存进票号 " + ticket + "）" : "";

  const sent = await tgText(env, env.TELEGRAM_CHAT_ID, head + "\n" + idea + tail);
  if (!sent.ok) return jsonResp({ ok: false, error: "telegram-message-failed", why: sent.description || "" }, 502, origin);

  /* 存票号 + 建立 TG 消息 → 票号 的映射（主人回复那条消息时靠它找回来）
     ⚠️ 隐私：KV 里【不存】IP / UA / 称呼 / 联系方式 —— 只留票号与对话正文。
        个人信息只出现在主人的 TG 消息里，不落库。 */
  let stored = false;
  if (env.SUBS && env.TICKET_OFF !== "1") {
    const rec = {
      t: ticket, ts: Date.now(),
      msgs: [{ who: "user", text: idea, ts: Date.now() }],
    };
    stored = await kvPutSub(env, rec);
    if (sent.result && sent.result.message_id) {
      try { await env.SUBS.put("msg:" + sent.result.message_id, ticket, { expirationTtl: KEEP_DAYS * 86400 }); } catch (e) {}
    }
  }

  let sentImgs = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const pf = new FormData();
    pf.append("chat_id", String(env.TELEGRAM_CHAT_ID));
    pf.append("caption", "图 " + (i + 1) + "/" + files.length + (name ? " · " + name : ""));
    pf.append("photo", f, f.name || ("pic" + (i + 1) + ".jpg"));
    const r = await tg(env, "sendPhoto", pf);
    if (r.ok) sentImgs++;
  }

  return jsonResp({ ok: true, images: sentImgs, ticket: stored ? ticket : null }, 200, origin);
}

/* ===== 查回复 ===== */
async function handleReply({ request, env }, origin) {
  if (!env.SUBS) return jsonResp({ ok: false, error: "reply-feature-off" }, 503, origin);
  const url = new URL(request.url);
  const ticket = clean(url.searchParams.get("t"), 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ticket.length < 6) return jsonResp({ ok: false, error: "bad-ticket" }, 400, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited(ip, 30, 10 * 60 * 1000, 800)) return jsonResp({ ok: false, error: "rate-limited" }, 429, origin);

  const rec = await kvGetSub(env, ticket);
  if (!rec) return jsonResp({ ok: false, error: "not-found" }, 404, origin);
  return jsonResp({ ok: true, ticket, ts: rec.ts, msgs: rec.msgs || [] }, 200, origin);
}

/* ===== 我的投稿（浏览器本地记住票号 → 一次批量取回，无需注册/无需手抄票号） ===== */
async function handleMine({ request, env }, origin) {
  if (!env.SUBS) return jsonResp({ ok: false, error: "reply-feature-off" }, 503, origin);
  const url = new URL(request.url);
  const raw = clean(url.searchParams.get("t"), 200).toUpperCase();
  const tickets = raw.split(",").map((s) => s.replace(/[^A-Z0-9]/g, "")).filter((s) => s.length >= 6).slice(0, 10);
  if (!tickets.length) return jsonResp({ ok: true, threads: [] }, 200, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited(ip, 60, 10 * 60 * 1000, 500)) return jsonResp({ ok: false, error: "rate-limited" }, 429, origin);

  const threads = [];
  for (const t of tickets) {
    const rec = await kvGetSub(env, t);
    if (!rec) continue;
    const msgs = rec.msgs || [];
    const owner = msgs.filter((m) => m.who === "owner");
    threads.push({
      ticket: t,
      ts: rec.ts,
      count: msgs.length,
      ownerCount: owner.length,
      lastOwner: owner.length ? owner[owner.length - 1].text.slice(0, 200) : "",
      first: (msgs[0] && msgs[0].text || "").slice(0, 80),
    });
  }
  return jsonResp({ ok: true, threads }, 200, origin);
}

/* ===== 追问 ===== */
async function handleFollowup({ request, env }, origin) {
  if (!env.SUBS) return jsonResp({ ok: false, error: "reply-feature-off" }, 503, origin);
  if (request.method !== "POST") return jsonResp({ ok: false, error: "method" }, 405, origin);

  let body;
  try { body = await request.json(); } catch (e) { return jsonResp({ ok: false, error: "bad-body" }, 400, origin); }
  const ticket = clean(body.ticket, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const text = clean(body.text, MAX_IDEA);
  if (ticket.length < 6 || text.length < 1) return jsonResp({ ok: false, error: "bad-input" }, 400, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited(ip, 10, 10 * 60 * 1000, 5000)) return jsonResp({ ok: false, error: "rate-limited" }, 429, origin);

  const rec = await kvGetSub(env, ticket);
  if (!rec) return jsonResp({ ok: false, error: "not-found" }, 404, origin);

  rec.msgs = rec.msgs || [];
  rec.msgs.push({ who: "user", text, ts: Date.now() });
  const ok = await kvPutSub(env, rec);
  if (!ok) return jsonResp({ ok: false, error: "store-failed" }, 500, origin);

  await tgText(env, env.TELEGRAM_CHAT_ID,
    "💬 追加（票号 " + ticket + (rec.name ? " · " + rec.name : "") + "）：\n" + text +
    "\n\n（回复这条消息即可继续回给 TA）").then((r) => {
      if (r && r.ok && r.result && r.result.message_id && env.SUBS) {
        return env.SUBS.put("msg:" + r.result.message_id, ticket, { expirationTtl: KEEP_DAYS * 86400 });
      }
    }).catch(() => {});

  return jsonResp({ ok: true }, 200, origin);
}

/* ===== 主人在 TG 里回复 ===== */
async function handleTgHook({ request, env }) {
  /* Telegram 只认 POST */
  if (request.method !== "POST") return new Response("ok", { status: 200 });
  if (!env.TG_HOOK_SECRET || !env.SUBS) return new Response("ok", { status: 200 });

  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (secret !== env.TG_HOOK_SECRET) return new Response("forbidden", { status: 403 });

  let upd = null;
  try { upd = await request.json(); } catch (e) { return new Response("ok", { status: 200 }); }

  const m = upd && (upd.message || upd.edited_message);
  if (!m || !m.text) return new Response("ok", { status: 200 });
  if (String(m.chat && m.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok", { status: 200 });  // 只认主人

  let ticket = null;
  let body = (m.text || "").trim();

  if (m.reply_to_message && m.reply_to_message.message_id) {
    try { ticket = await env.SUBS.get("msg:" + m.reply_to_message.message_id); } catch (e) {}
  }
  if (!ticket) {
    const mt = body.match(/^\/r(?:eply)?\s+(MZ[A-Z0-9]{4,10})\s+([\s\S]+)$/i);
    if (mt) { ticket = mt[1].toUpperCase(); body = mt[2].trim(); }
  }
  if (!ticket) return new Response("ok", { status: 200 });

  const rec = await kvGetSub(env, ticket);
  if (!rec) { await tgText(env, env.TELEGRAM_CHAT_ID, "⚠️ 票号 " + ticket + " 不存在或已过期（保留 " + KEEP_DAYS + " 天）"); return new Response("ok", { status: 200 }); }

  rec.msgs = rec.msgs || [];
  rec.msgs.push({ who: "owner", text: body.slice(0, MAX_IDEA), ts: Date.now() });
  const ok = await kvPutSub(env, rec);
  await tgText(env, env.TELEGRAM_CHAT_ID,
    (ok ? "✅ 已回给票号 " + ticket : "❌ 写入失败（KV 异常）") + "\n投稿人可在网站凭票号查看。");

  return new Response("ok", { status: 200 });
}
