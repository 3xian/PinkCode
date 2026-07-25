#!/usr/bin/env node
/**
 * Generate every PinkCode icon from the supplied bitmap artwork.
 *
 * The handwritten mark is never traced or redrawn: its original pixels,
 * gradient, texture, and silhouette are preserved. Small Windows frames are
 * rendered directly from the 1024px bitmap master, never chained from another
 * small PNG, which keeps the taskbar icon crisp.
 */
import sharp from "sharp";
import {
  mkdirSync,
  writeFileSync,
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

const canvasSize = 1024;
const plateInset = 24;
const plateSize = canvasSize - plateInset * 2;
const targetSubjectHeight = 0.66;

const windowsIcoSizes = [
  16, 20, 24, 28, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256,
];

const pngTargets = new Map([
  // Tauri desktop bundle assets
  [join(iconsDir, "32x32.png"), 32],
  [join(iconsDir, "64x64.png"), 64],
  [join(iconsDir, "128x128.png"), 128],
  [join(iconsDir, "128x128@2x.png"), 256],
  [join(iconsDir, "512x512.png"), 512],
  [join(iconsDir, "icon.png"), 1024],
  [join(iconsDir, "app-icon-master.png"), 1024],
  [join(iconsDir, "app-icon-master-windows.png"), 1024],

  // Windows Store / installer assets
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

  // Web app, browser, and installable touch icons
  [join(publicDir, "favicon.png"), 16],
  [join(publicDir, "favicon-32.png"), 32],
  [join(publicDir, "favicon-180.png"), 180],
  [join(publicDir, "favicon-192.png"), 192],
  [join(publicDir, "favicon-512.png"), 512],
  [join(publicDir, "logo-512.png"), 512],
  [join(publicDir, "logo.png"), 1024],

  // In-app empty state and repository documentation
  [join(srcAssetsDir, "logo-512.png"), 512],
  [join(srcAssetsDir, "logo.png"), 1024],
  [join(docsDir, "logo.png"), 1024],
]);

for (const dir of [iconsDir, publicDir, srcAssetsDir, docsDir]) {
  mkdirSync(dir, { recursive: true });
}

function render(master, size) {
  // Every output starts from the full bitmap master. No chained resizing.
  return sharp(master)
    .resize(size, size, {
      fit: "fill",
      kernel: size <= 32 ? sharp.kernel.lanczos3 : sharp.kernel.lanczos2,
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

function writePngIco(path, frames) {
  const headerSize = 6 + frames.length * 16;
  let offset = headerSize;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);

  frames.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  writeFileSync(path, Buffer.concat([directory, ...frames.map((x) => x.data)]));
}

function continuousCornerMask() {
  // Geometry is used only as an alpha mask for the bitmap plate. The supplied
  // handwritten mark remains entirely raster-based.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="${canvasSize}" height="${canvasSize}"
         viewBox="0 0 ${canvasSize} ${canvasSize}">
      <path fill="#fff" d="
        M 512 24
        C 234 24 142 24 83 83
        C 24 142 24 234 24 512
        C 24 790 24 882 83 941
        C 142 1000 234 1000 512 1000
        C 790 1000 882 1000 941 941
        C 1000 882 1000 790 1000 512
        C 1000 234 1000 142 941 83
        C 882 24 790 24 512 24
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

async function buildBitmapMaster() {
  const subject = await findSubjectBounds();
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

  // Keep the original white field around the mark. This retains its naturally
  // antialiased edge pixels exactly, without a keyed fringe or generated mask.
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

  const mask = await continuousCornerMask();
  const master = await sharp(canvas)
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

  return {
    master,
    subject,
    crop: { left: cropLeft, top: cropTop, size: cropSize },
  };
}

function buildIcns(masterPath) {
  // Tauri's icon command is used only for the Apple ICNS container. All PNG
  // and ICO outputs it may create are overwritten below from our own renders.
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
  const { master, subject, crop } = await buildBitmapMaster();
  const masterPath = join(iconsDir, "app-icon-master.png");
  writeFileSync(masterPath, master);
  process.stdout.write(
    `Bitmap source subject ${subject.width}x${subject.height} ` +
      `at (${subject.left},${subject.top}); crop ${crop.size}px ` +
      `at (${crop.left},${crop.top}).\n`,
  );

  process.stdout.write("Building Apple icon container...\n");
  buildIcns(masterPath);

  process.stdout.write("Rendering PNG assets from the bitmap master...\n");
  for (const [path, size] of pngTargets) {
    writeFileSync(path, await render(master, size));
    process.stdout.write(`  ${path.slice(root.length + 1)} (${size}x${size})\n`);
  }

  process.stdout.write("Building multi-resolution Windows icon...\n");
  const frames = [];
  for (const size of windowsIcoSizes) {
    frames.push({ size, data: await render(master, size) });
  }
  writePngIco(join(iconsDir, "icon.ico"), frames);
  process.stdout.write(`  src-tauri/icons/icon.ico [${windowsIcoSizes.join(", ")}]\n`);

  process.stdout.write("All icon assets are in sync.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
