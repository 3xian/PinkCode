/**
 * Rewrite latest.json platform download URLs from GitHub API asset IDs
 * (api.github.com/.../releases/assets/{id}) to public browser download URLs
 * (github.com/.../releases/download/{tag}/{name}).
 *
 * tauri-action currently embeds API URLs. Those require Accept:
 * application/octet-stream (and hit unauthenticated rate limits), so the
 * Tauri updater gets HTTP 403. Public browser URLs work without auth.
 *
 * Env:
 *   GITHUB_TOKEN  required (contents:write)
 *   GITHUB_REPOSITORY  owner/repo (set by Actions)
 *   RELEASE_TAG  optional; default = latest non-draft release tag
 */
import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  process.exit(1);
}

const [owner, name] = repo.split("/");
const api = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "MarsBuild-rewrite-updater-json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function gh(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${init.method || "GET"} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

async function downloadAssetBinary(assetId) {
  const res = await fetch(
    `${api}/repos/${owner}/${name}/releases/assets/${assetId}`,
    {
      headers: {
        ...headers,
        Accept: "application/octet-stream",
      },
      redirect: "follow",
    },
  );
  if (!res.ok) {
    throw new Error(
      `download asset ${assetId} → ${res.status}: ${await res.text()}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function mapAssetName(platformKey, assetsByName) {
  // Prefer exact updater bundles over installers.
  const prefer = [];
  if (platformKey.startsWith("darwin-")) {
    const arch =
      platformKey.includes("aarch64") || platformKey.includes("arm64")
        ? "aarch64"
        : "x64";
    // releaseAssetNamePattern: [name]_[version]_[platform]_[arch][ext]
    prefer.push(
      ...Object.keys(assetsByName).filter(
        (n) =>
          n.includes(`_darwin_${arch}`) && n.endsWith(".app.tar.gz") && !n.endsWith(".sig"),
      ),
    );
  } else if (platformKey.startsWith("windows-")) {
    prefer.push(
      ...Object.keys(assetsByName).filter(
        (n) =>
          n.includes("_windows_") &&
          (n.endsWith(".exe") || n.endsWith(".msi")) &&
          !n.endsWith(".sig"),
      ),
    );
  } else if (platformKey.startsWith("linux-")) {
    prefer.push(
      ...Object.keys(assetsByName).filter(
        (n) =>
          (n.endsWith(".AppImage") || n.endsWith(".AppImage.tar.gz")) &&
          !n.endsWith(".sig"),
      ),
    );
  }
  return prefer[0] || null;
}

const tag = process.env.RELEASE_TAG || "";
let release;
if (tag) {
  release = await gh(`/repos/${owner}/${name}/releases/tags/${tag}`);
} else {
  const releases = await gh(
    `/repos/${owner}/${name}/releases?per_page=10`,
  );
  release = releases.find((r) => !r.draft && !r.prerelease) || releases[0];
}
if (!release) {
  console.error("No release found");
  process.exit(1);
}

console.log(`Rewriting latest.json for ${release.tag_name} (id=${release.id})`);

const assets = await gh(
  `/repos/${owner}/${name}/releases/${release.id}/assets?per_page=100`,
);
const assetsByName = Object.fromEntries(assets.map((a) => [a.name, a]));
const latestAsset = assetsByName["latest.json"];
if (!latestAsset) {
  console.error("latest.json not found on release");
  process.exit(1);
}

const raw = await downloadAssetBinary(latestAsset.id);
const json = JSON.parse(Buffer.from(raw).toString("utf8"));
const tagName = release.tag_name;
const base = `https://github.com/${owner}/${name}/releases/download/${tagName}`;

let changed = 0;
for (const [platform, meta] of Object.entries(json.platforms || {})) {
  if (!meta || typeof meta !== "object") continue;
  const url = String(meta.url || "");
  const isApi =
    url.includes("api.github.com") && url.includes("/releases/assets/");
  if (!isApi && url.startsWith("https://github.com/")) continue;

  let assetName = null;
  if (isApi) {
    const id = Number(url.split("/").pop());
    const hit = assets.find((a) => a.id === id);
    assetName = hit?.name || null;
  }
  if (!assetName) {
    assetName = mapAssetName(platform, assetsByName);
  }
  if (!assetName) {
    console.warn(`skip ${platform}: could not resolve asset name from ${url}`);
    continue;
  }
  const next = `${base}/${assetName}`;
  if (meta.url !== next) {
    console.log(`${platform}: ${meta.url} → ${next}`);
    meta.url = next;
    changed++;
  }
}

if (changed === 0) {
  console.log("No API asset URLs to rewrite; latest.json already public.");
  process.exit(0);
}

const out = JSON.stringify(json, null, 2) + "\n";
writeFileSync("latest.json", out);

// Replace release asset: delete old, upload new.
await gh(`/repos/${owner}/${name}/releases/assets/${latestAsset.id}`, {
  method: "DELETE",
});

const uploadUrl = release.upload_url.replace(/\{.*\}$/, "");
const uploadRes = await fetch(
  `${uploadUrl}?name=${encodeURIComponent("latest.json")}`,
  {
    method: "POST",
    headers: {
      ...headers,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: out,
  },
);
if (!uploadRes.ok) {
  throw new Error(
    `upload latest.json → ${uploadRes.status}: ${await uploadRes.text()}`,
  );
}

console.log(`OK: rewrote ${changed} platform URL(s) on ${tagName}`);
