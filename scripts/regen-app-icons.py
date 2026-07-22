"""
Rebuild the shared desktop icon master (macOS + Windows + others).

One master feeds `tauri icon` → icon.icns + icon.ico + PNGs. There is no
separate Windows/Mac art path.

Design:
  - Full-bleed opaque plate (app chrome color) so Dock/taskbar slots are full
    size — never a floating transparent glyph.
  - Cover-fit the logo into ~90% of the plate so the planet/face reads large.
    Wide rings may clip slightly at the sides; that is intentional so the
    mascot matches other apps optically (letterbox was making it look small).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
OUT_MASTER = ROOT / "src-tauri" / "icons" / "app-icon-master.png"
# App window chrome: tauri.conf backgroundColor [11, 13, 18]
PLATE = (11, 13, 18, 255)
# Cover-fit target: glyph box aims to fill this fraction of the square.
FILL = 0.90
SIZE = 1024


def content_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    px = im.load()
    w, h = im.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 16 and not (r < 10 and g < 10 and b < 10):
                if x < minx:
                    minx = x
                if y < miny:
                    miny = y
                if x > maxx:
                    maxx = x
                if y > maxy:
                    maxy = y
    if maxx < 0:
        raise SystemExit(f"no visible content in {SRC}")
    return minx, miny, maxx + 1, maxy + 1


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    box = content_bbox(src)
    glyph = src.crop(box)

    canvas = Image.new("RGBA", (SIZE, SIZE), PLATE)
    target = int(SIZE * FILL)
    gw, gh = glyph.size
    # Cover: scale so the *smaller* relative axis fills `target` — logo is
    # wider than tall, so height drives scale and side rings may crop.
    scale = max(target / gw, target / gh)
    nw, nh = max(1, int(round(gw * scale))), max(1, int(round(gh * scale)))
    glyph = glyph.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (SIZE - nw) // 2
    y = (SIZE - nh) // 2
    # Paste may extend past canvas; alpha_composite needs same-size layer.
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # Crop glyph to canvas if oversized.
    gx0 = max(0, -x)
    gy0 = max(0, -y)
    gx1 = min(nw, SIZE - x)
    gy1 = min(nh, SIZE - y)
    if gx1 > gx0 and gy1 > gy0:
        cropped = glyph.crop((gx0, gy0, gx1, gy1))
        layer.paste(cropped, (max(0, x), max(0, y)), cropped)
    canvas.alpha_composite(layer)

    OUT_MASTER.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_MASTER, "PNG")
    print(f"wrote {OUT_MASTER.relative_to(ROOT)} ({SIZE}x{SIZE})")
    print(f"  source crop {box} -> glyph {gw}x{gh} scaled {nw}x{nh} fill={FILL} cover")
    print(f"  paste offset ({x},{y})")
    print("  next: npx tauri icon src-tauri/icons/app-icon-master.png")


if __name__ == "__main__":
    main()
