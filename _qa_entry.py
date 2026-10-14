# -*- coding: utf-8 -*-
"""展示站新条目验收：卡片渲染 + 详情页内容 + 截图可加载 + 控制台无 error"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8933/#"
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 430, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    pg.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" else None)

    pg.goto(BASE + "/", wait_until="load")
    pg.wait_for_timeout(1200)
    n = pg.evaluate("()=>document.querySelectorAll('.app-card').length")
    print("首页卡片数:", n)

    pg.goto(BASE + "/apps", wait_until="load")
    pg.wait_for_timeout(1000)
    n2 = pg.evaluate("()=>document.querySelectorAll('.app-card').length")
    has = pg.evaluate("()=>Array.from(document.querySelectorAll('.app-card')).some(c=>c.textContent.indexOf('周友的酒三合一')>=0)")
    print("apps 页卡片数:", n2, "| 含周友的酒三合一:", has)

    pg.goto(BASE + "/app/zhouyou3in1", wait_until="load")
    pg.wait_for_timeout(1200)
    txt = pg.evaluate("()=>document.body.innerText")
    for k in ["周友的酒三合一", "舟友的酒", "小兔子也绝非善类", "左右滑", "夸克", "UC"]:
        print("  详情页含 %-12s : %s" % (k, k in txt))
    imgok = pg.evaluate("""async ()=>{const i=[...document.images].find(x=>x.src.indexOf('zhouyou3in1')>=0);
        if(!i) return 'no-img'; await new Promise(r=>{i.onload=r;i.onerror=r;setTimeout(r,2500)}); return [i.naturalWidth,i.naturalHeight];}""")
    print("详情页截图:", imgok)

    pg.goto(BASE + "/updates", wait_until="load")
    pg.wait_for_timeout(900)
    up = pg.evaluate("()=>document.body.innerText.indexOf('周友的酒三合一')>=0")
    print("更新页含新条目:", up)

    real = [e for e in errs if "Turnstile" not in e and "400" not in e]
    print("真实 JS 报错:", real[:4] if real else "无")
    b.close()
sys.exit(0)
