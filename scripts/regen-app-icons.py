"""
Rebuild the shared desktop icon master (macOS + Windows + others).

One master → `tauri icon` → icon.icns + icon.ico + PNGs.

macOS Dock comparison
---------------------
Peer apps (system + big vendors) usually read as *slightly convex*: soft
top-left specular, darker bottom-right, a bit of depth under the glyph.
A perfectly flat plate + flat logo looks “sunken” and optically smaller even
when the bitmap fills the same squircle.

We keep:
  - Full-bleed opaque plate (full Dock slot geometry)
  - Contain-fit logo (no ring overflow)
and add a light “sphere / tile” treatment so the tile matches Dock peers.
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
OUT_MASTER = ROOT / "src-tauri" / "icons" / "app-icon-master.png"
FILL = 0.86
SIZE = 1024

# Brand plate ends (cyan → violet), then lifted by lighting.
PLATE_A = (18, 70, 120)
PLATE_B = (88, 36, 168)


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
    """
    Full-bleed plate with mild spherical lighting (top-left highlight,
    bottom-right shade) — the “puffy tile” look common on the Dock.
    """
    im = Image.new("RGBA", (size, size))
    px = im.load()
    ar, ag, ab = PLATE_A
    br, bg, bb = PLATE_B
    # Light comes from upper-left, as in classic macOS icon lighting.
    lx, ly, lz = -0.35, -0.55, 0.75
    llen = math.sqrt(lx * lx + ly * ly + lz * lz)
    lx, ly, lz = lx / llen, ly / llen, lz / llen
    denom = max(1, 2 * (size - 1))
    cx = cy = (size - 1) * 0.5
    # Sphere radius slightly > half diagonal of the tile so edges stay soft.
    radius = size * 0.72

    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            base_r = ar + (br - ar) * t
            base_g = ag + (bg - ag) * t
            base_b = ab + (bb - ab) * t

            # Map pixel to a unit hemisphere for diffuse + specular.
            nx = (x - cx) / radius
            ny = (y - cy) / radius
            n2 = nx * nx + ny * ny
            if n2 < 1.0:
                nz = math.sqrt(1.0 - n2)
            else:
                # Outside the “sphere”: flatter edge falloff, still lit.
                s = math.sqrt(n2)
                nx, ny = nx / s, ny / s
                nz = 0.12

            ndotl = max(0.0, nx * lx + ny * ly + nz * lz)
            # Soft ambient + diffuse (keeps brand color, adds volume).
            shade = 0.55 + 0.55 * ndotl
            # Specular lobe (subtle gloss, not a chrome ball).
            # Half-vector approx toward camera (0,0,1).
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
    """Soft contact shadow under the mascot for a bit of lift off the plate."""
    shadow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    # Alpha of glyph as soft black blob, offset down-right.
    alpha = glyph.split()[3]
    blob = Image.new("RGBA", glyph.size, (0, 0, 0, 0))
    blob.putalpha(alpha.point(lambda a: int(a * 0.45)))
    # Blur heavily for a diffuse ground shadow.
    pad = 48
    layer = Image.new(
        "RGBA", (glyph.size[0] + pad * 2, glyph.size[1] + pad * 2), (0, 0, 0, 0)
    )
    layer.paste(blob, (pad, pad), blob)
    layer = layer.filter(ImageFilter.GaussianBlur(radius=18))
    sx = ox - pad + 10
    sy = oy - pad + 16
    shadow.alpha_composite(layer, (sx, sy))
    return shadow


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

    shadow = soft_drop_shadow(glyph, SIZE, x, y)
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(glyph, (x, y))

    # Very subtle rim light on the outer edge of the tile (reads at 64–128px).
    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rim)
    inset = 3
    draw.rounded_rectangle(
        [inset, inset, SIZE - 1 - inset, SIZE - 1 - inset],
        radius=int(SIZE * 0.22),
        outline=(255, 255, 255, 28),
        width=2,
    )
    canvas.alpha_composite(rim)

    OUT_MASTER.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_MASTER, "PNG")
    print(f"wrote {OUT_MASTER.relative_to(ROOT)} ({SIZE}x{SIZE})")
    print(f"  crop {box} -> {gw}x{gh} scaled {nw}x{nh} fill={FILL} contain")
    print(f"  pad LTRB {x},{y},{SIZE - nw - x},{SIZE - nh - y}")
    print("  lighting: spherical plate + soft glyph shadow + rim")
    print("  next: npx tauri icon src-tauri/icons/app-icon-master.png")


if __name__ == "__main__":
    main()
