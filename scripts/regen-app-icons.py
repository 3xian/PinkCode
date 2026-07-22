"""
Rebuild the shared desktop icon master (macOS + Windows + others).

One master → `tauri icon` → icon.icns + icon.ico + PNGs.

Design (both platforms the same):
  1. Full-bleed opaque plate = full Dock/taskbar *frame* (no transparent
     margin that makes the whole icon look smaller than other apps).
  2. Contain-fit the logo so rings/moon stay inside the plate — never
     cover-crop (that enlarges the face but clips edges = "overflow").
  3. ~88% of the square for the glyph box leaves a little air for the
     macOS squircle mask so corners do not nibble the art.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
OUT_MASTER = ROOT / "src-tauri" / "icons" / "app-icon-master.png"
# App window chrome: tauri.conf backgroundColor [11, 13, 18]
PLATE = (11, 13, 18, 255)
# Contain-fit: entire logo (including rings) fits in this fraction of the plate.
FILL = 0.88
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
    # Contain: fit whole glyph inside the target square (no crop / overflow).
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
    print("  next: npx tauri icon src-tauri/icons/app-icon-master.png")


if __name__ == "__main__":
    main()
