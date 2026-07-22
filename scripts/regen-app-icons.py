"""
Rebuild app icon masters so the glyph fills the macOS dock plate.

Problem: the planet logo is wider than tall and was centered with large
transparent top/bottom margins (~44% empty height), so Dock/Finder icons
look a size smaller than full-bleed system apps.

Fix: crop content, scale to ~95% of the square on a full-bleed plate
matching the app chrome so the icon occupies the full squircle mask.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
OUT_MASTER = ROOT / "src-tauri" / "icons" / "app-icon-master.png"
# App window chrome: tauri.conf backgroundColor [11, 13, 18]
PLATE = (11, 13, 18, 255)
# Keep a little air so rings aren't clipped by the macOS squircle corners.
FILL = 0.95
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
    scale = min(target / gw, target / gh)
    nw, nh = max(1, int(round(gw * scale))), max(1, int(round(gh * scale)))
    glyph = glyph.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (SIZE - nw) // 2
    y = (SIZE - nh) // 2
    canvas.alpha_composite(glyph, (x, y))

    OUT_MASTER.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_MASTER, "PNG")
    print(f"wrote {OUT_MASTER.relative_to(ROOT)} ({SIZE}x{SIZE})")
    print(f"  source crop {box} -> glyph {gw}x{gh} scaled {nw}x{nh} fill={FILL}")
    print(f"  pad LTRB {x},{y},{SIZE-nw-x},{SIZE-nh-y}")


if __name__ == "__main__":
    main()
