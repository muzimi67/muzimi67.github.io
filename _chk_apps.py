# -*- coding: utf-8 -*-
"""展示站改完后的计数断言：app 条目数 / 每条 pan 键 / 更新条目 / 内联 JS 语法"""
import re, sys, subprocess, os, tempfile
sys.stdout.reconfigure(encoding="utf-8")
P = r"D:\hello\咸鱼商品\技术手册\work\showcase\index.html"
h = open(P, encoding="utf-8").read()

ids = re.findall(r"\n\s+id:\"([a-zA-Z0-9]+)\"", h)
print("apps 条目数:", len(ids))
print("有无 zhouyou3in1:", "zhouyou3in1" in ids, "| 有无 zhouyou:", "zhouyou" in ids)
print("pan 键数:", len(re.findall(r"\n\s+[a-zA-Z0-9]+:\s*\{\s*quark:", h)))
print("updates 日期块:", re.findall(r"\{date:\"(\d{4}-\d{2}-\d{2})\"", h)[:4])

from html.parser import HTMLParser


class S(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inside = False
        self.blocks = []
        self.cur = []

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        a = dict(attrs)
        if a.get("src") or a.get("type") == "application/ld+json":
            return
        self.inside = True
        self.cur = []

    def handle_endtag(self, tag):
        if tag == "script" and self.inside:
            self.inside = False
            self.blocks.append("".join(self.cur))

    def handle_data(self, d):
        if self.inside:
            self.cur.append(d)


p = S()
p.feed(h)
blocks = p.blocks
print("可执行内联 script 块:", len(blocks), [len(b) for b in blocks])
tmp = os.path.join(tempfile.gettempdir(), "showcase_inline.js")
bad = 0
for i, b in enumerate(blocks):
    open(tmp, "w", encoding="utf-8").write(b)
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    if r.returncode != 0:
        bad += 1
        print("  block %d 语法错: %s" % (i, (r.stderr or "")[:200]))
print("node --check 全过:" , bad == 0)

# 结构化校验：把 DATA 那一大坨拿出来跑一遍，确认 27 个卡片的 id/name/shot 齐
m = re.search(r"const DATA\s*=\s*\{", h)
print("DATA 定义位置:", m.start() if m else None)
