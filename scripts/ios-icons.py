"""把桌面端那枚正式图标（蓝紫圆角方块 + 黑 A）转成 iOS 的 AppIcon / 启动图。

和 `scripts/android-icons.py` 同一套观感：满幅蓝紫渐变 + 居中的 A，
iOS 会自己套圆角遮罩，所以这里**不能**再切圆角，也不能留透明（App Store 会拒）。

产出（ios/App/App/Assets.xcassets/）：
  AppIcon.appiconset/AppIcon-512@2x.png   1024×1024，不透明
  Splash.imageset/splash-2732x2732*.png   深色底 + 居中图标（1x/2x/3x 同尺寸，沿用模板命名）

用法：python scripts/ios-icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "ios" / "App" / "App" / "Assets.xcassets"
SOURCE = ROOT / "src-tauri" / "icons" / "icon.png"

# 主题底色（和 styles.css 的 --bg 一致）
SPLASH_BG = (11, 13, 18)
# iOS 图标背景渐变：和图标本身的蓝紫一致
BG_TOP = (99, 145, 250)
BG_BOTTOM = (139, 92, 246)


def load_source() -> Image.Image:
    return Image.open(SOURCE).convert("RGBA").resize((512, 512), Image.LANCZOS)


def glyph_mask(source: Image.Image) -> Image.Image:
    """把黑色的 A 抠成 alpha 蒙版（和 Android 那份同一个判定）。"""
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


def gradient_background(width: int, height: int) -> Image.Image:
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


def app_icon(size: int, glyph: Image.Image) -> Image.Image:
    """不透明的满幅图标：iOS 自己裁圆角，透明会被 App Store 拒。"""
    canvas = gradient_background(size, size).convert("RGB")
    inner = int(size * 0.86)
    scaled = glyph.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.paste((17, 19, 26), (offset, offset), scaled)
    return canvas


def splash(size: int, source: Image.Image) -> Image.Image:
    """深色底 + 居中图标（边长取画布的 28%，和 Android 启动图一致）。"""
    canvas = Image.new("RGBA", (size, size), (*SPLASH_BG, 255))
    icon_size = int(size * 0.28)
    icon = source.resize((icon_size, icon_size), Image.LANCZOS)
    canvas.alpha_composite(icon, ((size - icon_size) // 2, (size - icon_size) // 2))
    return canvas.convert("RGB")


def main() -> None:
    source = load_source()
    glyph = glyph_mask(source)

    icon_dir = ASSETS / "AppIcon.appiconset"
    icon_dir.mkdir(parents=True, exist_ok=True)
    app_icon(1024, glyph).save(icon_dir / "AppIcon-512@2x.png")

    splash_dir = ASSETS / "Splash.imageset"
    splash_dir.mkdir(parents=True, exist_ok=True)
    image = splash(2732, source)
    for name in ("splash-2732x2732-2.png", "splash-2732x2732-1.png", "splash-2732x2732.png"):
        image.save(splash_dir / name)

    print("iOS 图标 / 启动图已生成：", ASSETS)


if __name__ == "__main__":
    main()
