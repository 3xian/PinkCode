/**
 * Canonical path / file-link helpers for workspace preview.
 * Prefer these over ad-hoc regex in components.
 */

/** Absolute Windows path (`C:\…`), UNC, or POSIX (`/…`). */
export function isAbsolutePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  if (t.startsWith("/") || t.startsWith("\\\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(t);
}

/** Case- and separator-insensitive path equality (Windows-friendly). */
export function pathsEqual(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Join a project-relative path under `root`; leave absolute `rel` unchanged. */
export function joinUnderRoot(root: string, rel: string): string {
  const r = rel.trim();
  if (!r || isAbsolutePath(r)) return r || root;
  const sep = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  // Normalize separators in the relative tail to match the project root style.
  const tail = r
    .replace(/^[\\/]+/, "")
    .replace(/[/\\]+/g, sep);
  return `${base}${sep}${tail}`;
}

/**
 * True when a bare string looks like a filesystem path worth opening in preview.
 * Conservative: requires a path separator, or absolute form — not bare `foo.bar`
 * (avoids `console.log` / version tokens as false positives).
 * Use for *inferred* paths (inline code, tool cards). Explicit markdown links
 * use `isFileLinkHref` instead (allows intentional single-segment names).
 */
export function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || t.includes(" ") || t.includes("\n") || t.length >= 260) {
    return false;
  }
  if (isAbsolutePath(t)) return true;
  // Relative path with a separator (project-style: src/foo.ts)
  if (/[/\\]/.test(t)) return true;
  return false;
}

/**
 * True when `href` looks like a local file path (not http/mailto/…).
 * Accepts `file://`, absolute paths, and relative project paths with separators.
 * Bare extension-only tokens (e.g. `README.md`) are allowed for markdown links
 * that authors intentionally wrote as paths; prefer `looksLikePath` for tool cards.
 */
export function isFileLinkHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const raw = href.trim();
  if (!raw || raw.includes("\n") || raw.length >= 260) return false;
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("data:") ||
    lower.startsWith("#")
  ) {
    return false;
  }
  if (lower.startsWith("file:")) return true;
  if (looksLikePath(raw)) return true;
  // Intentional single-segment file name in a markdown link (has extension).
  if (!raw.includes(" ") && /\.[A-Za-z0-9]{1,12}$/.test(raw)) return true;
  return false;
}

/** Strip `file://` / `file:///` and optional Windows drive prefix quirks. */
export function hrefToFsPath(href: string): string {
  const t = href.trim();
  if (!/^file:/i.test(t)) return t;
  try {
    const u = new URL(t);
    let p = decodeURIComponent(u.pathname);
    // file:///C:/foo → /C:/foo on Chromium; strip leading slash before drive.
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return t.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
  }
}

/** Best-effort path extraction from a tool timeline card title/detail. */
export function extractToolPath(detail?: string | null, title?: string | null): string | null {
  const candidates = [detail, title].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  for (const raw of candidates) {
    // Backtick path in title: Read `src/foo.ts`
    const bt = raw.match(/`([^`\n]+)`/);
    if (bt?.[1] && looksLikePath(bt[1])) return bt[1].trim();
    // Bare path-like first line
    const line = raw.trim().split(/\r?\n/)[0] ?? "";
    if (looksLikePath(line)) return line;
  }
  return null;
}
