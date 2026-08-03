/**
 * Parse unified diffs into selectable hunks and rebuild partial patches
 * for `git apply --cached` / `--reverse`.
 */

/** One classified hunk content line (prefix stripped). */
export interface ParsedDiffLine {
  /** `-`/`+`/` ` content lines; `meta` for `\ No newline at end of file`. */
  tag: "equal" | "delete" | "insert" | "meta";
  /** Content without the diff prefix (`meta` lines keep the full text). */
  text: string;
}

export interface DiffHunk {
  /** 0-based index among hunks in this file. */
  index: number;
  /** The `@@ -a,b +c,d @@` header line. */
  header: string;
  /** Full hunk body including the header line. */
  body: string;
  /** Added / removed line counts (for UI). */
  added: number;
  removed: number;
  /** Old-file start line from the header (`@@ -a,b …`); defaults to 1. */
  oldStart: number;
  /** New-file start line from the header (`@@ … +c,d`); defaults to 1. */
  newStart: number;
  /** Classified content lines (excludes the header line). */
  lines: ParsedDiffLine[];
}

export interface ParsedFileDiff {
  /** Lines before the first `@@` (diff --git / --- / +++ / index …). */
  fileHeader: string;
  hunks: DiffHunk[];
  /** True when there is no parseable hunk (empty or binary/unreadable). */
  empty: boolean;
}

/** Split a single-file unified diff into header + hunks. */
export function parseUnifiedDiff(diff: string): ParsedFileDiff {
  const text = diff.replace(/\r\n/g, "\n");
  if (!text.trim()) {
    return { fileHeader: "", hunks: [], empty: true };
  }

  const lines = text.split("\n");
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let i = 0;

  // Collect preamble until first @@ hunk.
  while (i < lines.length && !lines[i]!.startsWith("@@")) {
    headerLines.push(lines[i]!);
    i++;
  }

  while (i < lines.length) {
    if (!lines[i]!.startsWith("@@")) {
      i++;
      continue;
    }
    const start = i;
    const header = lines[i]!;
    i++;
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      // Stop if a new file starts (multi-file safety).
      if (
        lines[i]!.startsWith("diff --git ") ||
        (lines[i]!.startsWith("--- ") && i + 1 < lines.length && lines[i + 1]!.startsWith("+++ "))
      ) {
        break;
      }
      i++;
    }
    const bodyLines = lines.slice(start, i);
    // Drop trailing empty line that is just the split artifact.
    while (
      bodyLines.length > 1 &&
      bodyLines[bodyLines.length - 1] === ""
    ) {
      bodyLines.pop();
    }
    const body = bodyLines.join("\n");
    let added = 0;
    let removed = 0;
    const classified: ParsedDiffLine[] = [];
    for (const line of bodyLines.slice(1)) {
      const c = line[0];
      if (c === "+") {
        // `+++` lines are file headers (defensive: they never reach bodyLines).
        if (!line.startsWith("+++")) added++;
        classified.push({ tag: "insert", text: line.slice(1) });
      } else if (c === "-") {
        if (!line.startsWith("---")) removed++;
        classified.push({ tag: "delete", text: line.slice(1) });
      } else if (c === "\\") {
        // "\ No newline at end of file" — metadata, not a file line.
        classified.push({ tag: "meta", text: line });
      } else {
        classified.push({ tag: "equal", text: line.slice(1) });
      }
    }
    const starts = parseHunkStart(header);
    hunks.push({
      index: hunks.length,
      header,
      body,
      added,
      removed,
      oldStart: starts.oldStart,
      newStart: starts.newStart,
      lines: classified,
    });
  }

  // Preserve trailing newline convention of the original when present.
  let fileHeader = headerLines.join("\n");
  if (headerLines.length && text.endsWith("\n") && !fileHeader.endsWith("\n")) {
    // header alone; body hunks carry their own newlines when joined
  }
  if (fileHeader && !fileHeader.endsWith("\n")) {
    fileHeader += "\n";
  }

  return {
    fileHeader,
    hunks,
    empty: hunks.length === 0,
  };
}

/** Parse `@@ -a[,b] +c[,d] @@` header line numbers; absent ranges default to 1. */
export function parseHunkStart(header: string): {
  oldStart: number;
  newStart: number;
} {
  const m = header.match(/^@@\s*-([0-9]+)(?:,[0-9]+)?\s*\+([0-9]+)(?:,[0-9]+)?\s*@@/);
  if (!m) return { oldStart: 1, newStart: 1 };
  const oldStart = Number(m[1]);
  const newStart = Number(m[2]);
  return {
    oldStart: Number.isFinite(oldStart) ? oldStart : 1,
    newStart: Number.isFinite(newStart) ? newStart : 1,
  };
}

/**
 * Build a git-applyable patch from selected hunk indices.
 * Returns null if no valid selection.
 */
export function buildPartialPatch(
  parsed: ParsedFileDiff,
  selectedIndices: Iterable<number>,
): string | null {
  const set = new Set(selectedIndices);
  const selected = parsed.hunks.filter((h) => set.has(h.index));
  if (!selected.length) return null;

  let header = parsed.fileHeader;
  if (!header.trim()) {
    // Minimal header so git apply can still work with path context from ---/+++
    // when the source diff lacked `diff --git` (rare).
    header = "";
  }
  if (header && !header.endsWith("\n")) header += "\n";

  const parts = selected.map((h) =>
    h.body.endsWith("\n") ? h.body : `${h.body}\n`,
  );
  return header + parts.join("");
}
