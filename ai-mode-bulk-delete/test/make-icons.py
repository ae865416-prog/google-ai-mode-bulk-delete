"""產生擴充功能圖示（深色底 + 強調色勾勾）。"""
from PIL import Image, ImageDraw

ACCENT = (168, 199, 250, 255)
BG_TOP = (32, 34, 39, 255)
BG_BOT = (18, 19, 22, 255)
S = 512  # supersample


def rounded_bg(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # 垂直漸層
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), tuple(int(BG_TOP[i] * (1 - t) + BG_BOT[i] * t) for i in range(4)))
    grad = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.235), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_check(img):
    d = ImageDraw.Draw(img)
    w = int(img.size[0] * 0.095)
    pts = [(0.255, 0.525), (0.435, 0.705), (0.755, 0.325)]
    p = [(x * img.size[0], y * img.size[0]) for x, y in pts]
    d.line(p, fill=ACCENT, width=w, joint="curve")
    r = w // 2
    for (x, y) in (p[0], p[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=ACCENT)


def make(size):
    big = rounded_bg(S)
    draw_check(big)
    return big.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(rf"icons/icon{s}.png")
    print("icon", s, "ok")
