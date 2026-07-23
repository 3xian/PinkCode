"""
Rebuild desktop icon masters and Windows export assets.

One pipeline, two platforms (IconStyle — not “shape-as-platform”)
-----------------------------------------------------------------
  Mac     → brand plate, contain-fit, soft shadow  → app-icon-master.png
  Windows → black plate, height-fit, circular mask → app-icon-master-windows.png
                                                   → icon.ico + Square*/StoreLogo.png

Mac-only shared PNG sizes (32/128/…) and icon.icns are NOT written here.
If you refresh them with:

  npx tauri icon src-tauri/icons/app-icon-master.png

that overwrites icon.ico with the Mac plate. Always finish with this
script (or `npm run icons:regen`) so Windows assets stay black + circular.

Windows resolution notes
------------------------
  1. ICO embeds real PNG frames at every common DPI size (16–256).
  2. Each size is downscaled from a 2048 compose (never chained from 32px).
  3. Glyph is height-fitted (logo art is wide) so taskbar pixels go to the mark.
  4. `--windows-export` recomposes from logo.png @2048 — never upscales the
     1024 on-disk master (avoids a silent quality cliff).

Usage
-----
  python scripts/regen-app-icons.py                 # both platforms + Win export
  python scripts/regen-app-icons.py --windows-export  # Windows only (recompose + ICO)
"""
from __future__ import annotations

import argparse
import io
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "assets" / "logo.png"
ICONS = ROOT / "src-tauri" / "icons"
OUT_MASTER_MAC = ICONS / "app-icon-master.png"
OUT_MASTER_WIN = ICONS / "app-icon-master-windows.png"
OUT_ICO = ICONS / "icon.ico"

FitMode = Literal["contain", "height"]
RimKind = Literal["squircle", "circle"]
PlateKind = Literal["brand", "black"]

# Mac Dock plate (blue → purple spherical volume).
PLATE_A = (18, 70, 120)
PLATE_B = (88, 36, 168)
WIN_PLATE = (0, 0, 0, 255)

# Full DPI ladder. Windows shell picks nearest; missing rungs force upscales.
ICO_SIDES = [16, 20, 24, 28, 30, 32, 36, 40, 48, 64, 72, 96, 128, 256]

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


@dataclass(frozen=True)
class IconStyle:
    """Platform look: plate, fit, shadow, rim, mask — not overloaded geometry names."""

    name: str
    compose_size: int
    master_size: int
    fill: float
    fit: FitMode
    plate: PlateKind
    soft_shadow: bool
    rim: RimKind
    circular_mask: bool
    master_path: Path


MAC = IconStyle(
    name="mac",
    compose_size=1024,
    master_size=1024,
    fill=0.86,
    fit="contain",
    plate="brand",
    soft_shadow=True,
    rim="squircle",
    circular_mask=False,
    master_path=OUT_MASTER_MAC,
)

WINDOWS = IconStyle(
    name="windows",
    compose_size=2048,
    master_size=1024,
    fill=0.72,  # height fill — logo is wide; spends taskbar budget on the mark
    fit="height",
    plate="black",
    soft_shadow=False,
    rim="circle",
    circular_mask=True,
    master_path=OUT_MASTER_WIN,
)


@dataclass(frozen=True)
class GlyphLayout:
    glyph: Image.Image
    x: int
    y: int
    content_box: tuple[int, int, int, int]
    content_size: tuple[int, int]
    canvas_size: int
    fill: float


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
    """Mac full-bleed plate with mild spherical lighting (Dock-style volume)."""
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


def black_plate(size: int) -> Image.Image:
    return Image.new("RGBA", (size, size), WIN_PLATE)


PLATES: dict[PlateKind, Callable[[int], Image.Image]] = {
    "brand": brand_plate,
    "black": black_plate,
}


def soft_drop_shadow(
    glyph: Image.Image, canvas_size: int, ox: int, oy: int
) -> Image.Image:
    shadow = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    alpha = glyph.split()[3]
    blob = Image.new("RGBA", glyph.size, (0, 0, 0, 0))
    blob.putalpha(alpha.point(lambda a: int(a * 0.45)))
    pad = max(24, canvas_size // 20)
    blur = max(8, canvas_size // 55)
    layer = Image.new(
        "RGBA", (glyph.size[0] + pad * 2, glyph.size[1] + pad * 2), (0, 0, 0, 0)
    )
    layer.paste(blob, (pad, pad), blob)
    layer = layer.filter(ImageFilter.GaussianBlur(radius=blur))
    ox_off = max(4, canvas_size // 100)
    oy_off = max(6, canvas_size // 64)
    shadow.alpha_composite(layer, (ox - pad + ox_off, oy - pad + oy_off))
    return shadow


def fit_glyph(src: Image.Image, style: IconStyle) -> GlyphLayout:
    """
    contain — fit inside fill*canvas square (Mac).
    height  — scale so glyph height == fill*canvas (Windows); sides may clip.
    """
    box = content_bbox(src)
    cropped = src.crop(box)
    cw, ch = cropped.size
    size = style.compose_size
    if style.fit == "height":
        scale = (size * style.fill) / ch
    else:
        target = int(size * style.fill)
        scale = min(target / cw, target / ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    glyph = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    return GlyphLayout(
        glyph=glyph,
        x=(size - nw) // 2,
        y=(size - nh) // 2,
        content_box=box,
        content_size=(cw, ch),
        canvas_size=size,
        fill=style.fill,
    )


def make_rim(kind: RimKind, size: int) -> Image.Image:
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rim)
    if kind == "squircle":
        inset = max(2, size // 340)
        radius = int(size * 0.22)
        outline = (255, 255, 255, 28)
        width = max(1, size // 512)
        draw.rounded_rectangle(
            [inset, inset, size - 1 - inset, size - 1 - inset],
            radius=radius,
            outline=outline,
            width=width,
        )
    else:
        inset = max(3, size // 256)
        outline = (255, 255, 255, 48)
        width = max(2, size // 340)
        draw.ellipse(
            [inset, inset, size - 1 - inset, size - 1 - inset],
            outline=outline,
            width=width,
        )
    return rim


def circular_alpha_mask(size: int) -> Image.Image:
    ss = 4
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    pad = ss
    ImageDraw.Draw(mask).ellipse([pad, pad, big - 1 - pad, big - 1 - pad], fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def apply_circular_mask(canvas: Image.Image) -> Image.Image:
    r, g, b, a = canvas.split()
    a = ImageChops.multiply(a, circular_alpha_mask(canvas.size[0]))
    return Image.merge("RGBA", (r, g, b, a))


def paste_glyph(
    canvas: Image.Image, glyph: Image.Image, x: int, y: int
) -> None:
    """Paste glyph; supports negative offsets when height-fit overflows sides."""
    size = canvas.size[0]
    gx, gy = 0, 0
    gw, gh = glyph.size
    if x < 0:
        gx = -x
        gw -= gx
        x = 0
    if y < 0:
        gy = -y
        gh -= gy
        y = 0
    if x + gw > size:
        gw = size - x
    if y + gh > size:
        gh = size - y
    if gw <= 0 or gh <= 0:
        return
    piece = glyph.crop((gx, gy, gx + gw, gy + gh))
    canvas.alpha_composite(piece, (x, y))


def compose_icon(layout: GlyphLayout, style: IconStyle) -> Image.Image:
    size = layout.canvas_size
    canvas = PLATES[style.plate](size)
    if style.soft_shadow:
        canvas.alpha_composite(
            soft_drop_shadow(layout.glyph, size, layout.x, layout.y)
        )
    paste_glyph(canvas, layout.glyph, layout.x, layout.y)
    canvas.alpha_composite(make_rim(style.rim, size))
    if style.circular_mask:
        canvas = apply_circular_mask(canvas)
    return canvas


def flatten_on_black(im: Image.Image) -> Image.Image:
    """Return image as-is — compose_icon already bakes black plate + circular mask."""
    return im


def resize_for_windows(master_flat: Image.Image, side: int) -> Image.Image:
    out = master_flat.resize((side, side), Image.Resampling.LANCZOS)
    if side <= 48:
        out = out.filter(
            ImageFilter.UnsharpMask(
                radius=0.55 if side <= 24 else 0.75,
                percent=110,
                threshold=2,
            )
        )
    return out


def write_png_ico(path: Path, images: list[Image.Image]) -> None:
    """Multi-resolution ICO with one PNG stream per size (explicit frames)."""
    entries: list[tuple[int, int, int, int, int, int, int, int]] = []
    blobs: list[bytes] = []
    offset = 6 + 16 * len(images)
    for im in images:
        if im.mode != "RGBA":
            im = im.convert("RGBA")
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        blob = buf.getvalue()
        w, h = im.size
        entries.append(
            (
                0 if w >= 256 else w,
                0 if h >= 256 else h,
                0,
                0,
                1,
                32,
                len(blob),
                offset,
            )
        )
        blobs.append(blob)
        offset += len(blob)

    with path.open("wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(images)))
        for e in entries:
            f.write(struct.pack("<BBBBHHII", *e))
        for blob in blobs:
            f.write(blob)


def export_windows(compose_hi: Image.Image) -> None:
    """
    Export ICO + Store PNGs from a high-res Windows compose (ideally 2048).
    Flatten once, then resize each rung from that full-res flat image.
    """
    flat = flatten_on_black(compose_hi)
    frames = [resize_for_windows(flat, side) for side in ICO_SIDES]
    write_png_ico(OUT_ICO, frames)
    print(f"wrote {OUT_ICO.relative_to(ROOT)} sizes={ICO_SIDES}")

    with OUT_ICO.open("rb") as f:
        data = f.read()
    _res, itype, count = struct.unpack_from("<HHH", data, 0)
    if itype != 1 or count != len(ICO_SIDES):
        raise SystemExit(
            f"icon.ico header invalid: type={itype} count={count} "
            f"(expected type=1 count={len(ICO_SIDES)})"
        )
    print(f"  ico verified: {count} PNG frames, {len(data)} bytes")

    for name, side in WINDOWS_PNGS.items():
        resize_for_windows(flat, side).save(ICONS / name, "PNG")
        print(f"  wrote icons/{name} ({side}x{side})")


def build_platform(src: Image.Image, style: IconStyle) -> tuple[Image.Image, GlyphLayout]:
    """Compose at style.compose_size; return (hi-res image, layout)."""
    layout = fit_glyph(src, style)
    return compose_icon(layout, style), layout


def save_master(compose_hi: Image.Image, style: IconStyle) -> None:
    if compose_hi.size[0] == style.master_size:
        master = compose_hi
    else:
        master = compose_hi.resize(
            (style.master_size, style.master_size), Image.Resampling.LANCZOS
        )
    master.save(style.master_path, "PNG")
    print(
        f"wrote {style.master_path.relative_to(ROOT)} "
        f"({style.master_size}x{style.master_size}) "
        f"[{style.name} plate={style.plate} fit={style.fit} "
        f"compose=@{style.compose_size} fill={style.fill}]"
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "--windows-export",
        action="store_true",
        help=(
            "Windows only: recompose from logo.png @2048, refresh "
            "app-icon-master-windows.png + icon.ico + Square/Store PNGs "
            "(does not touch Mac masters / icon.icns)"
        ),
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    ICONS.mkdir(parents=True, exist_ok=True)

    if not SRC.is_file():
        raise SystemExit(f"missing source logo: {SRC.relative_to(ROOT)}")

    src = Image.open(SRC).convert("RGBA")

    if args.windows_export:
        # Always recompose @2048 from logo — never upscale the 1024 disk master.
        win_hi, win_layout = build_platform(src, WINDOWS)
        save_master(win_hi, WINDOWS)
        export_windows(win_hi)
        gw, gh = win_layout.glyph.size
        print(
            f"  win-only: scaled glyph {gw}x{gh} @ {WINDOWS.compose_size}; "
            "Mac masters / icon.icns untouched"
        )
        return

    mac_hi, _mac_layout = build_platform(src, MAC)
    save_master(mac_hi, MAC)

    win_hi, win_layout = build_platform(src, WINDOWS)
    save_master(win_hi, WINDOWS)
    export_windows(win_hi)

    gw, gh = win_layout.glyph.size
    cw, ch = win_layout.content_size
    print(
        f"  win crop {win_layout.content_box} -> {cw}x{ch} "
        f"scaled {gw}x{gh} @ {WINDOWS.compose_size} height_fill={WINDOWS.fill}"
    )
    print(
        f"  win pad LTRB {win_layout.x},{win_layout.y},"
        f"{WINDOWS.compose_size - gw - win_layout.x},"
        f"{WINDOWS.compose_size - gh - win_layout.y}"
    )
    print("  never touches icon.icns or Mac 32/128 PNGs")
    print("  if you run `tauri icon` next, finish with: npm run icons:regen")


if __name__ == "__main__":
    main()
