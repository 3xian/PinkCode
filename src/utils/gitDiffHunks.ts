/**
 * Parse unified diffs into selectable hunks and rebuild partial patches
 * for `git apply --cached` / `--reverse`.
 */

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
    for (const line of bodyLines.slice(1)) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    hunks.push({
      index: hunks.length,
      header,
      body,
      added,
      removed,
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
