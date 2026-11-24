"""把桌面端那枚正式图标（蓝紫圆角方块 + 黑 A）转成 Android 的启动图标 / 启动图。

产出（android/app/src/main/res/）：
  mipmap-*/ic_launcher.png            自适应图标的前身（老系统 / 部分启动器用）
  mipmap-*/ic_launcher_round.png      圆形版
  mipmap-*/ic_launcher_foreground.png 自适应图标前景（只有 A，四周留安全边距）
  drawable*/splash.png                深底 + 图标，替代 Capacitor 默认那张

用法：python scripts/android-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android" / "app" / "src" / "main" / "res"
SOURCE = ROOT / "src-tauri" / "icons" / "icon.png"

# 主题底色（和 styles.css 的 --bg 一致）
SPLASH_BG = (11, 13, 18)
# 自适应图标背景渐变：和图标本身的蓝紫一致
BG_TOP = (99, 145, 250)
BG_BOTTOM = (139, 92, 246)

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

PORT_SPLASH = {
    "mdpi": (320, 480),
    "hdpi": (480, 800),
    "xhdpi": (720, 1280),
    "xxhdpi": (960, 1600),
    "xxxhdpi": (1280, 1920),
}
LAND_SPLASH = {key: (h, w) for key, (w, h) in PORT_SPLASH.items()}


def load_source() -> Image.Image:
    img = Image.open(SOURCE).convert("RGBA")
    return img.resize((512, 512), Image.LANCZOS)


def glyph_mask(source: Image.Image) -> Image.Image:
    """把黑色的 A 抠成 alpha 蒙版：图标底色是亮蓝紫，A 是近黑。

    圆角方块四角是**透明**的（alpha 0、亮度也是 0），
    所以不能只看亮度 —— 否则会把四个角一起抠出来。这里同时要求 alpha 不透明。
    """
    gray = source.convert("L")
    alpha = source.getchannel("A")
    mask = Image.new("L", source.size, 0)
    pixels = mask.load()
    gray_px = gray.load()
    alpha_px = alpha.load()
    for y in range(source.height):
        for x in range(source.width):
            if alpha_px[x, y] > 200 and gray_px[x, y] < 90:
                pixels[x, y] = 255
    return mask


def foreground(size: int, glyph: Image.Image, scale: float = 0.86) -> Image.Image:
    """自适应图标的前景：108dp 画布上，A 占中间约 86。

    安全区 66/108 是「不被任何启动器裁掉」的下限；实际上多数启动器只裁到 72dp，
    A 放大到这里才和桌面端那枚图标观感一致（不然缩成一个小字母）。
    """
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * scale)
    scaled = glyph.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste((17, 19, 26, 255), (offset, offset), scaled)
    return canvas


def legacy_icon(size: int, glyph: Image.Image, round_mask: bool) -> Image.Image:
    """老式图标（API < 26 的启动器 / 需要位图的场合）。

    **满幅**的蓝紫渐变 + 居中的 A：新启动器会自己套形状遮罩，
    图标自己先切圆角反而会在外面留一圈黑边（vivo 桌面就是这样）。
    圆形版再套一个正圆。
    """
    canvas = gradient_background(size, size).convert("RGBA")
    inner = int(size * 0.86)
    scaled = glyph.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste((17, 19, 26, 255), (offset, offset), scaled)
    if not round_mask:
        return canvas
    big = canvas.resize((size * 4, size * 4), Image.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    out = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def gradient_background(width: int, height: int) -> Image.Image:
    """竖直渐变（顶浅底深），和桌面图标的观感一致。"""
    strip = Image.new("RGBA", (1, height))
    pixels = strip.load()
    for y in range(height):
        t = y / max(1, height - 1)
        pixels[0, y] = (
            round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
            round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
            round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
            255,
        )
    return strip.resize((width, height), Image.BILINEAR)


def splash(width: int, height: int, source: Image.Image) -> Image.Image:
    """深色底 + 居中的图标（边长取短边的 28%）。"""
    canvas = Image.new("RGBA", (width, height), (*SPLASH_BG, 255))
    icon_size = int(min(width, height) * 0.28)
    icon = source.resize((icon_size, icon_size), Image.LANCZOS)
    # 图标本身带圆角；先垫一层同色渐变底，缩到小尺寸时边缘更干净
    canvas.alpha_composite(icon, ((width - icon_size) // 2, (height - icon_size) // 2))
    return canvas


def main() -> None:
    source = load_source()
    glyph = glyph_mask(source)

    for density, factor in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)

        legacy = int(48 * factor)
        legacy_icon(legacy, glyph, round_mask=False).save(folder / "ic_launcher.png")
        legacy_icon(legacy, glyph, round_mask=True).save(folder / "ic_launcher_round.png")

        fg = int(108 * factor)
        foreground(fg, glyph).save(folder / "ic_launcher_foreground.png")

    # 启动图：竖屏 / 横屏各一套，另外 drawable/splash.png 是兜底
    splash(480, 320, source).save(RES / "drawable" / "splash.png")
    for density, (width, height) in PORT_SPLASH.items():
        target = RES / f"drawable-port-{density}"
        target.mkdir(parents=True, exist_ok=True)
        splash(width, height, source).save(target / "splash.png")
    for density, (width, height) in LAND_SPLASH.items():
        target = RES / f"drawable-land-{density}"
        target.mkdir(parents=True, exist_ok=True)
        splash(width, height, source).save(target / "splash.png")

    print("图标 / 启动图已生成：", RES)


if __name__ == "__main__":
    main()
