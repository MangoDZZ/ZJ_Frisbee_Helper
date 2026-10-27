"""生成小程序统一分享封面（500x400，微信推荐的 5:4）。

一次性脚本：产出的 miniprogram/images/share.png 要提交进仓库，
所以平时不需要再跑它。想换封面直接替换那张 png 即可。

    python scripts/make-share-image.py
"""

from PIL import Image, ImageDraw, ImageFont

W, H = 500, 400
BG_TOP = (172, 35, 255)      # 与 app.wxss 的 --theme 一致 #AC23FF
BG_BOTTOM = (124, 28, 196)   # 稍暗的同色系，做渐变
WHITE = (255, 255, 255)

BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
REGULAR = r"C:\Windows\Fonts\msyh.ttc"

# 全程在 RGBA 下画：半透明的胶囊/圆环必须先合成到图层上，
# 直接往 RGB 图上画会丢掉 alpha，变成纯白（白字跟着看不见）。
img = Image.new("RGBA", (W, H), BG_TOP + (255,))
draw = ImageDraw.Draw(img)

for y in range(H):
    t = y / (H - 1)
    r = round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
    g = round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
    b = round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b, 255))


def overlay():
    """新建一张透明图层，画完再合成回来。"""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    return layer, ImageDraw.Draw(layer)


# 右上角两圈同心圆：飞盘的意思，压住右上角的空白
for radius, width, alpha in ((150, 10, 26), (104, 10, 34)):
    layer, d = overlay()
    cx, cy = W - 40, 90
    d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
              outline=(255, 255, 255, alpha), width=width)
    img = Image.alpha_composite(img, layer)

draw = ImageDraw.Draw(img)

title_font = ImageFont.truetype(BOLD, 62)
sub_font = ImageFont.truetype(REGULAR, 26)
tag_font = ImageFont.truetype(BOLD, 20)
small_font = ImageFont.truetype(REGULAR, 20)

# 左上角小标签：白色半透明胶囊 + 白字
tag = "HAT EVENT"
tw = draw.textlength(tag, font=tag_font)
pill = [50, 60, 50 + tw + 36, 60 + 42]
layer, d = overlay()
d.rounded_rectangle(pill, radius=21, fill=(255, 255, 255, 46))
img = Image.alpha_composite(img, layer)
draw = ImageDraw.Draw(img)
draw.text((pill[0] + 18, pill[1] + 9), tag, font=tag_font, fill=WHITE + (255,))

# 主标题
draw.text((50, 128), "飞盘 HAT", font=title_font, fill=WHITE + (255,))
draw.text((50, 202), "赛事组织助手", font=title_font, fill=WHITE + (255,))

# 副标题：一句话说清这个小程序干什么
draw.text((52, 292), "报名 · 分队 · 记分 · 积分榜", font=sub_font, fill=(255, 255, 255, 225))

# 底部细线 + 一行补充说明
draw.line([(52, 344), (W - 52, 344)], fill=(255, 255, 255, 70), width=2)
draw.text((52, 356), "随机均衡分队，赛后可查个人数据", font=small_font,
          fill=(255, 255, 255, 170))

out = r"E:\HAT_helper\miniprogram\images\share.png"
img.convert("RGB").save(out, "PNG", optimize=True)
print("written %.1f KB" % (len(open(out, "rb").read()) / 1024))
