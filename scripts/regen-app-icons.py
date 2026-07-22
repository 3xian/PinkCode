"""
Rebuild desktop icon masters and Windows export assets.

One pipeline, two shapes
------------------------
  square  → macOS full-bleed plate  → app-icon-master.png
  circle  → Windows circular plate  → app-icon-master-windows.png
                                    → icon.ico + Square*/StoreLogo.png

Shared PNG sizes (32/128/…) and icon.icns are NOT written here.
They stay on the Mac geometry path. If you refresh them with:

  npx tauri icon src-tauri/icons/app-icon-master.png

that overwrites icon.ico with a square plate. Always finish with this
script (or `npm run icons:regen`) so Windows assets stay circular.

Usage
-----
  python scripts/regen-app-icons.py              # default: both masters + Win export
  python scripts/regen-app-icons.py --windows-export   # only re-export Win from master
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
ICONS = ROOT / "src-tauri" / "icons"
OUT_MASTER_MAC = ICONS / "app-icon-master.png"
OUT_MASTER_WIN = ICONS / "app-icon-master-windows.png"
OUT_ICO = ICONS / "icon.ico"

FILL = 0.86
SIZE = 1024
Shape = Literal["square", "circle"]

PLATE_A = (18, 70, 120)
PLATE_B = (88, 36, 168)

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

# Windows Store / MSIX logo sizes (same table as `tauri icon`).
WINDOWS_PNGS: dict[str, int] = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

# Rim: (inset, radius_or_none, outline_rgba, width)
# radius_or_none is only used for square (squircle); circle uses ellipse.
RIM_SQUARE = (3, int(SIZE * 0.22), (255, 255, 255, 28), 2)
RIM_CIRCLE = (4, None, (255, 255, 255, 32), 3)


@dataclass(frozen=True)
class GlyphLayout:
    glyph: Image.Image
    x: int
    y: int
    content_box: tuple[int, int, int, int]
    content_size: tuple[int, int]


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


def clamp8(v: float) -> int:
    return max(0, min(255, int(round(v))))


def brand_plate(size: int) -> Image.Image:
    """Full-bleed plate with mild spherical lighting (Dock-style volume)."""
    im = Image.new("RGBA", (size, size))
    px = im.load()
    ar, ag, ab = PLATE_A
    br, bg, bb = PLATE_B
    lx, ly, lz = -0.35, -0.55, 0.75
    llen = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / llen, ly / llen, lz / llen
    denom = max(1, 2 * (size - 1))
    cx = cy = (size - 1) * 0.5
    radius = size * 0.72

    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            base_r = ar + (br - ar) * t
            base_g = ag + (bg - ag) * t
            base_b = ab + (bb - ab) * t

            nx = (x - cx) / radius
            ny = (y - cy) / radius
            n2 = nx * nx + ny * ny
            if n2 < 1.0:
                nz = math.sqrt(1.0 - n2)
            else:
                s = math.sqrt(n2)
                nx, ny = nx / s, ny / s
                nz = 0.12

            ndotl = max(0.0, nx * lx + ny * ly + nz * lz)
            shade = 0.55 + 0.55 * ndotl
            hx, hy, hz = lx, ly, lz + 1.0
            hlen = math.sqrt(hx * hx + hy * hy + hz * hz)
            hx, hy, hz = hx / hlen, hy / hlen, hz / hlen
            ndoth = max(0.0, nx * hx + ny * hy + nz * hz)
            spec = (ndoth**28) * 0.28

            r = clamp8(base_r * shade + 255 * spec)
            g = clamp8(base_g * shade + 255 * spec)
            b = clamp8(base_b * shade + 255 * spec)
            px[x, y] = (r, g, b, 255)

    return im


def soft_drop_shadow(
    glyph: Image.Image, canvas_size: int, ox: int, oy: int
) -> Image.Image:
    shadow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    alpha = glyph.split()[3]
    blob = Image.new("RGBA", glyph.size, (0, 0, 0, 0))
    blob.putalpha(alpha.point(lambda a: int(a * 0.45)))
    pad = 48
    layer = Image.new(
        "RGBA", (glyph.size[0] + pad * 2, glyph.size[1] + pad * 2), (0, 0, 0, 0)
    )
    layer.paste(blob, (pad, pad), blob)
    layer = layer.filter(ImageFilter.GaussianBlur(radius=18))
    shadow.alpha_composite(layer, (ox - pad + 10, oy - pad + 16))
    return shadow


def fit_glyph(src: Image.Image) -> GlyphLayout:
    box = content_bbox(src)
    cropped = src.crop(box)
    cw, ch = cropped.size
    target = int(SIZE * FILL)
    scale = min(target / cw, target / ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    glyph = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    return GlyphLayout(
        glyph=glyph,
        x=(SIZE - nw) // 2,
        y=(SIZE - nh) // 2,
        content_box=box,
        content_size=(cw, ch),
    )


def make_rim(shape: Shape) -> Image.Image:
    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rim)
    if shape == "square":
        inset, radius, outline, width = RIM_SQUARE
        draw.rounded_rectangle(
            [inset, inset, SIZE - 1 - inset, SIZE - 1 - inset],
            radius=radius,
            outline=outline,
            width=width,
        )
    else:
        inset, _, outline, width = RIM_CIRCLE
        draw.ellipse(
            [inset, inset, SIZE - 1 - inset, SIZE - 1 - inset],
            outline=outline,
            width=width,
        )
    return rim


def circular_alpha_mask(size: int) -> Image.Image:
    """Antialiased circular alpha via 4× supersample."""
    ss = 4
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    pad = ss
    ImageDraw.Draw(mask).ellipse([pad, pad, big - 1 - pad, big - 1 - pad], fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def apply_circular_mask(canvas: Image.Image) -> Image.Image:
    r, g, b, a = canvas.split()
    a = ImageChops.multiply(a, circular_alpha_mask(SIZE))
    return Image.merge("RGBA", (r, g, b, a))


def compose_icon(layout: GlyphLayout, shape: Shape) -> Image.Image:
    """Shared plate + glyph path; only rim and outer mask depend on shape."""
    canvas = brand_plate(SIZE)
    canvas.alpha_composite(soft_drop_shadow(layout.glyph, SIZE, layout.x, layout.y))
    canvas.alpha_composite(layout.glyph, (layout.x, layout.y))
    canvas.alpha_composite(make_rim(shape))
    if shape == "circle":
        canvas = apply_circular_mask(canvas)
    return canvas


def export_windows(master: Image.Image) -> None:
    master.save(OUT_ICO, format="ICO", sizes=ICO_SIZES)
    print(f"wrote {OUT_ICO.relative_to(ROOT)} sizes={[s[0] for s in ICO_SIZES]}")
    for name, side in WINDOWS_PNGS.items():
        master.resize((side, side), Image.Resampling.LANCZOS).save(ICONS / name, "PNG")
        print(f"  wrote icons/{name} ({side}x{side})")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--windows-export",
        action="store_true",
        help=(
            "Only re-export icon.ico + Square/Store PNGs from "
            "app-icon-master-windows.png (fix after `tauri icon` overwrote ico)"
        ),
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    ICONS.mkdir(parents=True, exist_ok=True)

    if args.windows_export:
        if not OUT_MASTER_WIN.is_file():
            raise SystemExit(
                f"missing {OUT_MASTER_WIN.relative_to(ROOT)}; "
                "run without --windows-export first"
            )
        win = Image.open(OUT_MASTER_WIN).convert("RGBA")
        export_windows(win)
        print("  windows export only; masters unchanged; icon.icns untouched")
        return

    src = Image.open(SRC).convert("RGBA")
    layout = fit_glyph(src)

    mac = compose_icon(layout, "square")
    mac.save(OUT_MASTER_MAC, "PNG")
    print(f"wrote {OUT_MASTER_MAC.relative_to(ROOT)} ({SIZE}x{SIZE}) [mac square]")

    win = compose_icon(layout, "circle")
    win.save(OUT_MASTER_WIN, "PNG")
    print(f"wrote {OUT_MASTER_WIN.relative_to(ROOT)} ({SIZE}x{SIZE}) [win circle]")
    export_windows(win)

    gw, gh = layout.glyph.size
    cw, ch = layout.content_size
    print(
        f"  crop {layout.content_box} -> {cw}x{ch} "
        f"scaled {gw}x{gh} fill={FILL} contain"
    )
    print(
        f"  pad LTRB {layout.x},{layout.y},"
        f"{SIZE - gw - layout.x},{SIZE - gh - layout.y}"
    )
    print("  shape: square(mac) + circle(win); never touches icon.icns")
    print("  if you run `tauri icon` next, finish with: npm run icons:regen")


if __name__ == "__main__":
    main()
