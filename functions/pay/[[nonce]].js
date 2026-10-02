/**
 * /pay/{nonce} —— DeepSeek 充值收款码短链（Cloudflare Pages Function）
 *
 *   为什么需要它（2026-10-02 修复）：
 *     支付宝 alipay.trade.page.pay 返回的是带 RSA2 签名的完整网关 URL，
 *     实测长度 1028 字符。而 QR 码标准最大容量（typeNumber=40 / L 级）只有
 *     366 字节 —— 超出 2.8 倍，qrcode-generator 必抛 "Too long data"，
 *     前端只能显示"二维码渲染失败"。这就是收款码"老是出不来"的真正原因。
 *
 *   方案：二维码只编码本短链（约 40 字节），扫码后由本函数 302 跳到真实支付 URL。
 *     附带好处：省掉前端轮等，302 是秒回。
 *
 *   数据来源：qr-data 分支的 res_{nonce}.json（ds_daemon.py 下单成功后推送）
 *   安全：    1) nonce 严格 8 位 hex 白名单正则，防路径穿越
 *            2) 跳转目标做【域名白名单】，杜绝本函数被当成开放重定向器
 *            3) 文件本身在公开仓库里可见（仓库设计如此，不含 order_id/token）
 */

const RAW_BASE = "https://raw.githubusercontent.com/muzimi67/muzimi67.github.io/qr-data/";

/* 允许跳转的支付域名 —— 只有这些能成为 Location 头的值 */
const OK_HOST = /(^|\.)(alipay\.com|alipayobjects\.com|qq\.com|tenpay\.com|weixin\.qq\.com)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function page(title, msg, extra) {
  const h = { "content-type": "text/html; charset=utf-8" };
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>" + title + "</title>" +
      "<style>body{font-family:-apple-system,system-ui,'PingFang SC','Microsoft YaHei',sans-serif;" +
      "background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;" +
      "height:100vh;margin:0;text-align:center;padding:24px}" +
      "div{max-width:420px}h1{font-size:20px;margin:0 0 12px}" +
      "p{font-size:15px;line-height:1.7;color:#94a3b8;margin:6px 0}" +
      "a{color:#38bdf8;font-size:15px}</style>" +
      "<div><h1>" + title + "</h1><p>" + msg + "</p>" + (extra || "") + "</div>",
    { status: 200, headers: h }
  );
}

export async function onRequest(context) {
  const { request, params } = context;
  const nonce = String((params && params.nonce) || "").toLowerCase();

  /* 只认 8 位 hex —— 顺带挡掉 ../ 之类的路径穿越 */
  if (!/^[a-f0-9]{8}$/.test(nonce)) {
    return page("链接无效", "收款码编号格式不对，请回到网站重新生成一张。", "");
  }

  /* res 文件是 daemon 推上去的，扫码可能比推送早几秒 —— 最多重试 4 次（约 6s） */
  let j = null;
  for (let i = 0; i < 4; i++) {
    try {
      // 加时间戳破 CDN/GitHub raw 的 120s 缓存，避免拿到还没更新的旧内容
      const r = await fetch(RAW_BASE + "res_" + nonce + ".json?t=" + Date.now(), {
        headers: { "cache-control": "no-cache" },
      });
      if (r.ok) {
        j = await r.json();
        break;
      }
      if (r.status !== 404) break;
    } catch (e) {
      /* 网络抖动，重试 */
    }
    if (i < 3) await sleep(1500);
  }

  if (!j) {
    return page(
      "收款码还没生成好",
      "博主电脑可能刚开机，或这张码已经过期（有效期 15 分钟）。<br>请回到网站重新生成一张～",
      '<p><a href="https://muzimi67.github.io/">回首页重新生成 →</a></p>'
    );
  }

  if (j.status !== "ok" || !j.url) {
    return page(
      "这笔收款码没能生成",
      (j.msg || "上游开小差了").toString().slice(0, 120) +
        "<br>请回到网站再试一次。",
      '<p><a href="https://muzimi67.github.io/">回首页 →</a></p>'
    );
  }

  /* 目标域名白名单 —— 防止有人拿本函数当开放重定向（钓鱼跳板） */
  let target;
  try {
    target = new URL(j.url);
  } catch (e) {
    return page("收款码已损坏", "这笔订单的上游地址无法解析，请重新生成。", "");
  }
  if (target.protocol !== "https:" || !OK_HOST.test(target.hostname)) {
    return page("收款码已损坏", "这笔订单的支付地址不在白名单内，已拦截。请重新生成。", "");
  }

  /* 302 临时跳转：支付宝/微信都不该缓存这个跳转 */
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "referrer-policy": "no-referrer",
    },
  });
}