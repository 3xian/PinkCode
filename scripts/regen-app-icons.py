"""
Rebuild the shared desktop icon master (macOS + Windows + others).

One master → `tauri icon` → icon.icns + icon.ico + PNGs.

Why icons looked smaller than other apps
---------------------------------------
A full-bleed *near-black* plate (#0B0D12) is the correct *geometry* for the
Dock slot, but on a dark macOS Dock the plate disappears — only the colorful
mascot reads as “the icon”. That glyph is wider than tall, so it only fills
~half the height → optically a size smaller than full-color app tiles
(Safari, Chrome, Slack, …).

Fix
---
  1. Full-bleed *visible* brand gradient (fills the whole squircle/tile).
  2. Contain-fit the logo so rings never overflow the plate.
  3. ~84% glyph box keeps air for the system corner mask.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
OUT_MASTER = ROOT / "src-tauri" / "icons" / "app-icon-master.png"
# Contain-fit: entire logo (including rings) inside this fraction of the plate.
FILL = 0.84
SIZE = 1024

# Brand-aligned plate ends (cyan → violet). Saturated enough to read as a
# full-size tile on a dark Dock; not pure black.
PLATE_A = (14, 55, 95)  # deep teal
PLATE_B = (76, 29, 149)  # deep violet


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


def brand_plate(size: int) -> Image.Image:
    """Diagonal gradient plate — full canvas, opaque."""
    im = Image.new("RGBA", (size, size))
    px = im.load()
    ar, ag, ab = PLATE_A
    br, bg, bb = PLATE_B
    denom = max(1, 2 * (size - 1))
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom  # 0..1 along diagonal
            # Slight radial lift in the center so the face sits on a brighter zone.
            cx = (x + 0.5) / size - 0.5
            cy = (y + 0.5) / size - 0.5
            radial = max(0.0, 1.0 - (cx * cx + cy * cy) * 2.2)
            t = min(1.0, max(0.0, t * 0.85 + radial * 0.15))
            r = int(ar + (br - ar) * t)
            g = int(ag + (bg - ag) * t)
            b = int(ab + (bb - ab) * t)
            # Lift midtones a bit for Dock legibility.
            r = min(255, r + 12)
            g = min(255, g + 8)
            b = min(255, b + 10)
            px[x, y] = (r, g, b, 255)
    return im


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    box = content_bbox(src)
    glyph = src.crop(box)

    canvas = brand_plate(SIZE)
    target = int(SIZE * FILL)
    gw, gh = glyph.size
    scale = min(target / gw, target / gh)
    nw = max(1, int(round(gw * scale)))
    nh = max(1, int(round(gh * scale)))
    glyph = glyph.resize((nw, nh), Image.Resampling.LANCZOS)
    x = (SIZE - nw) // 2
    y = (SIZE - nh) // 2
    canvas.alpha_composite(glyph, (x, y))

    OUT_MASTER.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_MASTER, "PNG")
    print(f"wrote {OUT_MASTER.relative_to(ROOT)} ({SIZE}x{SIZE})")
    print(f"  crop {box} -> {gw}x{gh} scaled {nw}x{nh} fill={FILL} contain")
    print(f"  pad LTRB {x},{y},{SIZE - nw - x},{SIZE - nh - y}")
    print(f"  plate gradient {PLATE_A} -> {PLATE_B} (visible full tile)")
    print("  next: npx tauri icon src-tauri/icons/app-icon-master.png")


if __name__ == "__main__":
    main()
