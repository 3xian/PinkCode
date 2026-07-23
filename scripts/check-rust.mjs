#!/usr/bin/env node
/**
 * Local parity with `.github/workflows/ci.yml` rust job:
 *   cargo fmt --check
 *   cargo clippy --all-targets -- -D warnings
 *   cargo test
 *
 * Run via `npm run check:rust` (or `npm run check` which includes this).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "src-tauri", "Cargo.toml");

function run(label, args) {
  console.log(`\n==> ${label}\n    cargo ${args.join(" ")}\n`);
  // Prefer no shell (avoids arg concatenation warnings). On Windows, fall back
  // to shell only if cargo is not on PATH as a bare executable.
  const r = spawnSync("cargo", args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

run("cargo fmt --check", ["fmt", "--manifest-path", manifest, "--check"]);
run("cargo clippy", [
  "clippy",
  "--manifest-path",
  manifest,
  "--all-targets",
  "--",
  "-D",
  "warnings",
]);
run("cargo test", ["test", "--manifest-path", manifest]);

console.log("\nRust checks passed.\n");
