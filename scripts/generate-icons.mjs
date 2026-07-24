#!/usr/bin/env node
/**
 * Generate all icon sizes from the master SVG.
 * Usage: node scripts/generate-icons.mjs
 */
import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SVG_PATH = join(ROOT, "src-tauri/icons/icon-master.svg");
const ICONS_DIR = join(ROOT, "src-tauri/icons");
const PUBLIC_DIR = join(ROOT, "public");
const SRC_ASSETS = join(ROOT, "src/assets");

const svgBuffer = readFileSync(SVG_PATH);

async function render(size, output, opts = {}) {
  const { fit = "contain", background = { r: 0, g: 0, b: 0, alpha: 0 } } = opts;
  await sharp(svgBuffer, { density: 300 })
    .resize(size, size, { fit, background })
    .png()
    .toFile(output);
  console.log(`  ${output}`);
}

async function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  mkdirSync(PUBLIC_DIR, { recursive: true });
  mkdirSync(SRC_ASSETS, { recursive: true });

  console.log("Generating Tauri icons...");
  await render(32, join(ICONS_DIR, "32x32.png"));
  await render(64, join(ICONS_DIR, "64x64.png"));
  await render(128, join(ICONS_DIR, "128x128.png"));
  await render(256, join(ICONS_DIR, "128x128@2x.png"));
  await render(512, join(ICONS_DIR, "512x512.png"));
  await render(1024, join(ICONS_DIR, "icon.png"));

  // Windows Store logos
  await render(30, join(ICONS_DIR, "Square30x30Logo.png"));
  await render(44, join(ICONS_DIR, "Square44x44Logo.png"));
  await render(71, join(ICONS_DIR, "Square71x71Logo.png"));
  await render(89, join(ICONS_DIR, "Square89x89Logo.png"));
  await render(107, join(ICONS_DIR, "Square107x107Logo.png"));
  await render(142, join(ICONS_DIR, "Square142x142Logo.png"));
  await render(150, join(ICONS_DIR, "Square150x150Logo.png"));
  await render(284, join(ICONS_DIR, "Square284x284Logo.png"));
  await render(310, join(ICONS_DIR, "Square310x310Logo.png"));
  await render(50, join(ICONS_DIR, "StoreLogo.png"));

  // Master for Windows ICO generation
  await render(256, join(ICONS_DIR, "app-icon-master-windows.png"));

  console.log("\nGenerating web/frontend icons...");
  await render(16, join(PUBLIC_DIR, "favicon.png"));
  await render(32, join(PUBLIC_DIR, "favicon-32.png"));
  await render(180, join(PUBLIC_DIR, "favicon-180.png"));
  await render(192, join(PUBLIC_DIR, "favicon-192.png"));
  await render(512, join(PUBLIC_DIR, "favicon-512.png"));
  await render(512, join(PUBLIC_DIR, "logo-512.png"));
  await render(1024, join(PUBLIC_DIR, "logo.png"));

  await render(512, join(SRC_ASSETS, "logo-512.png"));
  await render(1024, join(SRC_ASSETS, "logo.png"));

  // App icon master (1024 with padding for macOS icon mask)
  await render(1024, join(ICONS_DIR, "app-icon-master.png"));

  console.log("\nAll icons generated.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
