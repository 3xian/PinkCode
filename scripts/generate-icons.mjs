#!/usr/bin/env node
/**
 * Generate every PinkCode icon from the supplied bitmap artwork.
 *
 * Platform split:
 *   - Default / Mac: 1024 master with soft plate → icns, dock, web/docs
 *   - Windows: same subject proportion as default (height fill 0.66), but
 *       composed at 2048 and processed for taskbar: soft gradient art looks
 *       mushy at 16–48px, so small rungs get a hardened plate + solid mark
 *       alpha. ICO stores ≤128 as BMP DIB; entry0 is 16 for Tauri fallback.
 *       On Windows, runtime also reloads multi-size PE icons (see windows_icons.rs).
 */
import sharp from "sharp";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const iconsDir = join(root, "src-tauri", "icons");
const publicDir = join(root, "public");
const srcAssetsDir = join(root, "src", "assets");
const docsDir = join(root, "docs");
const sourcePath = join(iconsDir, "icon-source.png");

const defaultLayout = {
  canvasSize: 1024,
  plateInset: 24,
  targetSubjectHeight: 0.66,
};

/**
 * Windows compose uses the same subject proportion as default
 * (targetSubjectHeight 0.66, plate inset scaled 24→48 at 2048).
 * Only resolution / small-rung hardening differ.
 */
const windowsLayout = {
  canvasSize: 2048,
  plateInset: 48,
  targetSubjectHeight: 0.66,
};

/**
 * Full DPI ladder for the PE / taskbar (Windows picks by size).
 *
 * IMPORTANT: Tauri's *window* (title-bar) icon is NOT multi-size — codegen
 * only embeds ICO entry[0] as RGBA (`CachedIcon::new_ico`). Put 16 first so
 * the caption uses a native 16×16 frame instead of scaling 32→16 (soft/ugly).
 * Taskbar still sees every rung via the full resource ICO.
 */
const windowsIcoSizes = [
  16, 20, 24, 28, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256,
];

const defaultPngTargets = new Map([
  [join(iconsDir, "128x128.png"), 128],
  [join(iconsDir, "128x128@2x.png"), 256],
  [join(iconsDir, "512x512.png"), 512],
  [join(iconsDir, "icon.png"), 1024],
  [join(iconsDir, "app-icon-master.png"), 1024],

  [join(publicDir, "favicon.png"), 16],
  [join(publicDir, "favicon-32.png"), 32],
  [join(publicDir, "favicon-180.png"), 180],
  [join(publicDir, "favicon-192.png"), 192],
  [join(publicDir, "favicon-512.png"), 512],
  [join(publicDir, "logo-512.png"), 512],
  [join(publicDir, "logo.png"), 1024],

  [join(srcAssetsDir, "logo-512.png"), 512],
  [join(srcAssetsDir, "logo.png"), 1024],
  [join(docsDir, "logo.png"), 1024],
]);

const windowsPngTargets = new Map([
  [join(iconsDir, "32x32.png"), 32],
  [join(iconsDir, "64x64.png"), 64],
  [join(iconsDir, "app-icon-master-windows.png"), 1024],
  [join(iconsDir, "Square30x30Logo.png"), 30],
  [join(iconsDir, "Square44x44Logo.png"), 44],
  [join(iconsDir, "Square71x71Logo.png"), 71],
  [join(iconsDir, "Square89x89Logo.png"), 89],
  [join(iconsDir, "Square107x107Logo.png"), 107],
  [join(iconsDir, "Square142x142Logo.png"), 142],
  [join(iconsDir, "Square150x150Logo.png"), 150],
  [join(iconsDir, "Square284x284Logo.png"), 284],
  [join(iconsDir, "Square310x310Logo.png"), 310],
  [join(iconsDir, "StoreLogo.png"), 50],
]);

for (const dir of [iconsDir, publicDir, srcAssetsDir, docsDir]) {
  mkdirSync(dir, { recursive: true });
}

/** Soft downscale for large / non-taskbar assets. */
function renderSoft(master, size) {
  return sharp(master)
    .resize(size, size, {
      fit: "fill",
      kernel: size <= 48 ? sharp.kernel.lanczos3 : sharp.kernel.lanczos2,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/**
 * Taskbar / small-tile render.
 *
 * Soft source fringes read as blur; binary-at-target-size reads as jaggies.
 * Middle path: supersample → solid plate + solid mark → Lanczos downscale
 * so edges get ~1px natural AA (smooth, still defined). Subject proportion
 * stays that of `master` (same 0.66 layout as default).
 */
async function renderWindowsFrame(master, size) {
  if (size > 64) {
    return renderSoft(master, size);
  }

  // Extra supersample at 16px (title bar): 8× → smoother caption glyph.
  // 4× for other ≤32, 3× for 36–64.
  const over = size <= 16 ? 8 : size <= 32 ? 4 : 3;
  const big = size * over;

  const { data, info } = await sharp(master)
    .resize(big, big, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = info.width * info.height;
  // Punchier pink for legibility on white; hue stays rose.
  const brandR = 232;
  const brandG = 96;
  const brandB = 140;

  // SVG rounded rect with natural AA at supersampled size.
  const plate = await plateMask(big)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const plateA = plate.data[o + 3];
    if (plateA < 8) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 0;
      continue;
    }

    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // Strong chroma = mark body (ignore washed soft fringe of the source).
    const isMark = a > 40 && chroma > 22 && Math.min(r, g, b) < 245;

    if (isMark) {
      // Premultiply-ish with plate alpha so corner AA stays clean.
      data[o] = brandR;
      data[o + 1] = brandG;
      data[o + 2] = brandB;
      data[o + 3] = plateA;
    } else {
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = plateA;
    }
  }

  // Downscale produces smooth coverage AA — no hard pixel stairsteps.
  // Very light unsharp keeps definition without re-jagging.
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .sharpen({
      // 16px title-bar: light touch only — heavy unsharp = stair-steps.
      sigma: size <= 16 ? 0.3 : size <= 24 ? 0.4 : 0.35,
      m1: size <= 16 ? 0.35 : 0.5,
      m2: size <= 16 ? 0.2 : 0.25,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

/** Rounded plate mask (SVG AA at the requested size). */
function plateMask(size) {
  const inset = Math.max(1, Math.round(size * 0.02));
  const radius = Math.round(size * 0.18);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="${inset}" y="${inset}"
            width="${size - inset * 2}" height="${size - inset * 2}"
            rx="${radius}" ry="${radius}" fill="#fff"/>
    </svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().png();
}

/**
 * Encode a 32-bit BGRA DIB for ICO (bottom-up) + empty AND mask.
 * Small BMP frames are picked more reliably by the Windows shell than
 * PNG-in-ICO for 16–48 taskbar slots.
 */
async function pngToBmpDib(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  // XOR bitmap: 32bpp BGRA, bottom-up, row stride aligned to 4 (already is).
  const xorSize = w * h * 4;
  // AND mask: 1 bit/pixel, rows padded to 32 bits.
  const andRowBytes = Math.ceil(w / 32) * 4;
  const andSize = andRowBytes * h;

  const headerSize = 40;
  const dib = Buffer.alloc(headerSize + xorSize + andSize);
  // BITMAPINFOHEADER
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  // Height is XOR+AND (2 * image height) for icons.
  dib.writeInt32LE(h * 2, 8);
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(32, 14); // bit count
  dib.writeUInt32LE(0, 16); // BI_RGB (alpha in 4th byte is still used by modern shell)
  dib.writeUInt32LE(xorSize, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);

  // Bottom-up BGRA
  for (let y = 0; y < h; y += 1) {
    const srcY = h - 1 - y;
    for (let x = 0; x < w; x += 1) {
      const si = (srcY * w + x) * 4;
      const di = headerSize + (y * w + x) * 4;
      dib[di] = data[si + 2]; // B
      dib[di + 1] = data[si + 1]; // G
      dib[di + 2] = data[si]; // R
      dib[di + 3] = data[si + 3]; // A
    }
  }
  // AND mask left zero → “use alpha”
  return dib;
}

/**
 * Write multi-resolution ICO.
 * - size ≤ 128 → BMP DIB frames (taskbar reliability)
 * - size ≥ 256 → PNG frame (Vista+ large icon)
 */
async function writeIco(path, frames) {
  // frames: [{ size, png }]  — order preserved (32 first).
  const encoded = [];
  for (const { size, png } of frames) {
    if (size >= 256) {
      encoded.push({ size, data: png, bpp: 32 });
    } else {
      encoded.push({ size, data: await pngToBmpDib(png), bpp: 32 });
    }
  }

  const headerSize = 6 + encoded.length * 16;
  let offset = headerSize;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(encoded.length, 4);

  encoded.forEach(({ size, data, bpp }, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(bpp, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  writeFileSync(
    path,
    Buffer.concat([directory, ...encoded.map((x) => x.data)]),
  );
}

function continuousCornerMask(canvasSize) {
  const s = canvasSize;
  const inset = Math.round(s * (24 / 1024));
  const c1 = Math.round(s * (234 / 1024));
  const c2 = Math.round(s * (142 / 1024));
  const c3 = Math.round(s * (83 / 1024));
  const mid = Math.round(s / 2);
  const far = s - inset;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="${s}" height="${s}"
         viewBox="0 0 ${s} ${s}">
      <path fill="#fff" d="
        M ${mid} ${inset}
        C ${c1} ${inset} ${c2} ${inset} ${c3} ${c3}
        C ${inset} ${c2} ${inset} ${c1} ${inset} ${mid}
        C ${inset} ${s - c1} ${inset} ${s - c2} ${c3} ${s - c3}
        C ${c2} ${far} ${c1} ${far} ${mid} ${far}
        C ${s - c1} ${far} ${s - c2} ${far} ${s - c3} ${s - c3}
        C ${far} ${s - c2} ${far} ${s - c1} ${far} ${mid}
        C ${far} ${c1} ${far} ${c2} ${s - c3} ${c3}
        C ${s - c2} ${inset} ${s - c1} ${inset} ${mid} ${inset}
        Z"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function findSubjectBounds() {
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const isArtwork = Math.min(r, g, b) < 245 && chroma > 12;
      if (!isArtwork) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    throw new Error("No colored subject found in icon-source.png");
  }

  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
    sourceWidth: info.width,
    sourceHeight: info.height,
  };
}

async function buildBitmapMaster(layout, subject) {
  const { canvasSize, plateInset, targetSubjectHeight } = layout;
  const plateSize = canvasSize - plateInset * 2;
  const centerX = (subject.left + subject.right) / 2;
  const centerY = (subject.top + subject.bottom) / 2;

  const requestedCrop = Math.round(
    (subject.height * plateSize) / (canvasSize * targetSubjectHeight),
  );
  const cropSize = Math.min(
    requestedCrop,
    subject.sourceWidth,
    subject.sourceHeight,
  );
  const cropLeft = Math.max(
    0,
    Math.min(subject.sourceWidth - cropSize, Math.round(centerX - cropSize / 2)),
  );
  const cropTop = Math.max(
    0,
    Math.min(subject.sourceHeight - cropSize, Math.round(centerY - cropSize / 2)),
  );

  const plate = await sharp(sourcePath)
    .extract({
      left: cropLeft,
      top: cropTop,
      width: cropSize,
      height: cropSize,
    })
    .resize(plateSize, plateSize, {
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .png()
    .toBuffer();

  const canvas = await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  })
    .composite([{ input: plate, left: plateInset, top: plateInset }])
    .png()
    .toBuffer();

  const mask = await continuousCornerMask(canvasSize);
  const master = await sharp(canvas)
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  return {
    master,
    crop: { left: cropLeft, top: cropTop, size: cropSize },
  };
}

function buildIcns(masterPath) {
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const result = spawnSync(
    process.execPath,
    [cli, "icon", masterPath, "--output", iconsDir],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error("Tauri failed to build icon.icns");
  }
}

async function main() {
  // Drop any leftover comparison probes.
  for (const name of ["_cmp_base32.png", "_cmp_hard32.png", "_cmp_ss32.png"]) {
    try {
      rmSync(join(iconsDir, name));
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(join(iconsDir, "_probe"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const subject = await findSubjectBounds();
  process.stdout.write(
    `Bitmap source subject ${subject.width}x${subject.height} ` +
      `at (${subject.left},${subject.top}).\n`,
  );

  const { master: defaultMaster, crop: defaultCrop } = await buildBitmapMaster(
    defaultLayout,
    subject,
  );
  const defaultMasterPath = join(iconsDir, "app-icon-master.png");
  writeFileSync(defaultMasterPath, defaultMaster);
  process.stdout.write(
    `Default master crop ${defaultCrop.size}px at (${defaultCrop.left},${defaultCrop.top}) ` +
      `subjectH=${defaultLayout.targetSubjectHeight}.\n`,
  );

  process.stdout.write("Building Apple icon container...\n");
  buildIcns(defaultMasterPath);

  process.stdout.write("Rendering default PNG assets...\n");
  for (const [path, size] of defaultPngTargets) {
    writeFileSync(path, await renderSoft(defaultMaster, size));
    process.stdout.write(`  ${path.slice(root.length + 1)} (${size}x${size})\n`);
  }

  const { master: windowsHi, crop: winCrop } = await buildBitmapMaster(
    windowsLayout,
    subject,
  );
  process.stdout.write(
    `Windows compose @${windowsLayout.canvasSize} crop ${winCrop.size}px ` +
      `at (${winCrop.left},${winCrop.top}) subjectH=${windowsLayout.targetSubjectHeight}.\n`,
  );

  process.stdout.write("Rendering Windows PNG assets (crisp small rungs)...\n");
  for (const [path, size] of windowsPngTargets) {
    writeFileSync(path, await renderWindowsFrame(windowsHi, size));
    process.stdout.write(`  ${path.slice(root.length + 1)} (${size}x${size})\n`);
  }

  process.stdout.write(
    "Building multi-resolution Windows icon (16 first for title bar, BMP small)...\n",
  );
  const frames = [];
  for (const size of windowsIcoSizes) {
    const png = await renderWindowsFrame(windowsHi, size);
    frames.push({ size, png });
  }
  await writeIco(join(iconsDir, "icon.ico"), frames);
  process.stdout.write(
    `  src-tauri/icons/icon.ico [${windowsIcoSizes.join(", ")}] ` +
      `(entry0=${windowsIcoSizes[0]} → window title bar)\n`,
  );

  process.stdout.write("All icon assets are in sync.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
