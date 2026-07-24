/**
 * Canonical release notes for GitHub Release body + latest.json `notes`.
 *
 * Contract (consumed by UpdateModal):
 *   - UI owns the heading "What's new in vX"
 *   - This script emits body only: bullets / sections + optional changelog link
 *   - No leading "What's new" / "What's Changed" H1–H2 (would double the UI title)
 *
 * Source: GitHub Releases "generate-notes" API (auto previous tag).
 *
 * Env:
 *   GITHUB_TOKEN       required
 *   GITHUB_REPOSITORY  owner/repo
 *   RELEASE_TAG        e.g. v0.1.12 (default: GITHUB_REF_NAME)
 *
 * Output:
 *   - Always prints notes to stdout
 *   - If GITHUB_OUTPUT is set, also writes multiline `body` for Actions job outputs
 */
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const tag =
  process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || "";

if (!token || !repo || !tag) {
  console.error(
    "GITHUB_TOKEN, GITHUB_REPOSITORY, and RELEASE_TAG (or GITHUB_REF_NAME) are required",
  );
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "PinkCode-generate-release-notes",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

const res = await fetch(
  `https://api.github.com/repos/${repo}/releases/generate-notes`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ tag_name: tag }),
  },
);

if (!res.ok) {
  const text = await res.text();
  console.error(`generate-notes → ${res.status}: ${text}`);
  process.exit(1);
}

const data = await res.json();
let body = String(data.body || "").trim();

// Drop a leading H1/H2 that would stack under the modal's "What's new in vX".
body = body
  .replace(/^#{1,2}\s+What['’]?s\s+(Changed|New)\b[^\n]*\n+/i, "")
  .replace(/^\s+/, "")
  .trim();

if (!body) {
  body = "- Maintenance release";
}

process.stdout.write(body);
if (!body.endsWith("\n")) process.stdout.write("\n");

const outFile = process.env.GITHUB_OUTPUT;
if (outFile) {
  const { appendFileSync } = await import("node:fs");
  const delim = `NOTES_${crypto.randomUUID().replace(/-/g, "")}`;
  appendFileSync(outFile, `body<<${delim}\n${body}\n${delim}\n`);
}
