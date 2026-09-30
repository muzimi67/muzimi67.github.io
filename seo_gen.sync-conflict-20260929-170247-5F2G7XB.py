#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
seo_gen.py - 从 index.html 的 DATA 提取产品，生成 sitemap.xml + llms.txt + jsonld.json

用法（在 showcase 目录下）：
    PYTHONIOENCODING=utf-8 python seo_gen.py

设计原则：单一数据源。产品列表只从 index.html 读，绝不手写第二份，
避免产品增删后 sitemap 过期（69 号手册坑 6 硬编码 URL 事故的同源教训）。
"""
import re
import sys
import json
import pathlib

sys.stdout.reconfigure(encoding="utf-8")

BASE = "https://muzimi67.github.io"
ROOT = pathlib.Path(__file__).resolve().parent
HTML = ROOT / "index.html"

html = HTML.read_text(encoding="utf-8")

# ---- 1. 抽产品 id（DATA.apps 区块内）----
apps_block = re.search(r"apps:\s*\[(.*?)\n  \],", html, re.S)
if not apps_block:
    sys.exit("!! 找不到 apps 区块，检查 index.html 结构是否变了")
apps_src = apps_block.group(1)

products = re.findall(
    r'id:"([a-z0-9]+)",\s*icon:"([^"]*)",\s*name:"([^"]*)",\s*ver:"([^"]*)",\s*date:"([^"]*)"',
    apps_src,
)
if not products:
    sys.exit("!! apps 区块解析出 0 个产品，正则需要更新")

latest = max(p[4] for p in products)
print(f"解析到 {len(products)} 个产品，最新日期 {latest}")

# ---- 2. sitemap.xml ----
# ⚠️ 重要：本站在用 hash 路由（#/app/xxx）。
# Google 官方文档明确：hash 片段不参与 URL 标识，爬虫「无法可靠解析」，
# 所以 #/app/* 写进 sitemap 无效（会被当成同一个页面）。
# 当前只提交真实可索引的根路径；产品页需改 History API 路由后才能单独收录。
urls = [
    (f"{BASE}/", latest, "1.0", "daily"),
]

lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
]
for loc, lastmod, prio, freq in urls:
    lines += [
        "  <url>",
        f"    <loc>{loc}</loc>",
        f"    <lastmod>{lastmod}</lastmod>",
        f"    <changefreq>{freq}</changefreq>",
        f"    <priority>{prio}</priority>",
        "  </url>",
]
lines.append("</urlset>")

(ROOT / "sitemap.xml").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"写出 sitemap.xml（{len(urls)} 条 URL，hash 路由已按 Google 官方结论排除）")

# ---- 3. llms.txt（2026 年 AI 爬虫入口，成本极低）----
catalog = "\n".join(
    f"- [{name}]({BASE}/#/app/{pid}): {ver} ({date})" for pid, _i, name, ver, date in products
)

llms = f"""# 木子米软件大全 (Muzimi Software Collection)

> 独立开发者木子米的离线单文件软件作品集。全部作品零外部依赖、断网可用、
> 跨平台（Android APK / iOS 浏览器 / HarmonyOS）。语音盒、互动游戏、邦多利系列。

## 核心特点
- 离线单文件：零外部依赖，断网可用，不会因服务器下线而失效
- 一次劳动三端通用：同一份 HTML 文件，Android 装 APK，iPhone/鸿蒙用浏览器打开
- 全部免费，通过 QQ 群分发抢先版

## 作品目录
{catalog}

## 联系
- B站：https://space.bilibili.com/638676336
- QQ群：318283066 / 575703180 / 1071472123

## 说明
本站为个人作品展示站，内容为自研软件与游戏，不涉及第三方版权内容分发。
所有下载链接指向网盘（夸克/UC/百度），供个人学习交流使用。
"""

(ROOT / "llms.txt").write_text(llms, encoding="utf-8")
print("写出 llms.txt")

# ---- 4. jsonld.json（供注入 index.html <head>）----
jsonld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "木子米软件大全",
    "description": "独立开发者木子米的离线单文件软件作品集，语音盒、互动游戏、邦多利系列",
    "url": f"{BASE}/",
    "numberOfItems": len(products),
    "itemListElement": [
        {
            "@type": "ListItem",
            "position": i + 1,
            "item": {
                "@type": "SoftwareApplication",
                "name": name,
                "applicationCategory": "GameApplication",
                "operatingSystem": "Android, iOS, HarmonyOS",
                "softwareVersion": ver,
                "datePublished": date,
                "url": f"{BASE}/#/app/{pid}",
                "offers": {"@type": "Offer", "price": "0", "priceCurrency": "CNY"},
            },
        }
        for i, (pid, _i, name, ver, date) in enumerate(products)
    ],
}
(ROOT / "jsonld.json").write_text(
    json.dumps(jsonld, ensure_ascii=False, indent=2), encoding="utf-8"
)
print("写出 jsonld.json（供注入 index.html <head>）")
print("\n完成。")
