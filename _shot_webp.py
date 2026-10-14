# -*- coding: utf-8 -*-
"""把 shots/zhouyou3in1.png 转 webp（展示站其余截图都是 webp）"""
import os
from PIL import Image

D = r"D:\hello\咸鱼商品\技术手册\work\showcase\shots"
src = os.path.join(D, "zhouyou3in1.png")
im = Image.open(src).convert("RGB")
out = os.path.join(D, "zhouyou3in1.webp")
im.save(out, "WEBP", quality=86, method=5)
print("->", out, os.path.getsize(out), "bytes", im.size)
