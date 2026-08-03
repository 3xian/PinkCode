/**
 * Renderable rows for a unified-diff patch shown inside a timeline tool card
 * (Grok Build Edit block style: @@ header + line numbers + -/+ gutters).
 *
 * The patch comes from `extractEditDiff` (editDiff.ts) and starts with the
 * first `@@` hunk header — no `diff --git` / `---` / `+++` preamble. Line
 * classification lives in `parseUnifiedDiff` (gitDiffHunks.ts); this module
 * only walks the classified lines to assign old/new line numbers.
 */

import { parseUnifiedDiff } from "./gitDiffHunks";

/** One rendered row of the snippet. */
export type DiffSnippetRow =
  | { tag: "hunk"; text: string }
  | {
      tag: "equal" | "delete" | "insert";
      /** Old-file line number (absent for pure inserts). */
      oldLine?: number;
      /** New-file line number (absent for pure deletes). */
      newLine?: number;
      text: string;
    };

export interface DiffSnippet {
  rows: DiffSnippetRow[];
  /** True when rows were cut at a hunk boundary to bound render cost. */
  truncated: boolean;
}

/** Render cap (Grok keeps MAX_CONTEXT; here the 12k char diff cap is already
 *  applied upstream, this bounds pathological per-line blowups). */
const MAX_DIFF_ROWS = 400;

/**
 * Map a unified-diff patch to display rows, or `null` when it contains no
 * parseable hunk (callers then fall back to plain-text rendering).
 */
export function buildDiffSnippet(patch: string): DiffSnippet | null {
  const parsed = parseUnifiedDiff(patch);
  if (parsed.empty) return null;

  const rows: DiffSnippetRow[] = [];
  let truncated = false;

  for (const hunk of parsed.hunks) {
    const candidate: DiffSnippetRow[] = [
      { tag: "hunk", text: hunk.header },
    ];
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.tag === "delete") {
        candidate.push({ tag: "delete", oldLine: oldNo++, text: line.text });
      } else if (line.tag === "insert") {
        candidate.push({ tag: "insert", newLine: newNo++, text: line.text });
      } else if (line.tag === "meta") {
        // "\ No newline at end of file" — context row, no line numbers.
        candidate.push({ tag: "equal", text: line.text });
      } else {
        candidate.push({
          tag: "equal",
          oldLine: oldNo++,
          newLine: newNo++,
          text: line.text,
        });
      }
    }

    // Only cut between hunks so a hunk never renders half-open.
    if (rows.length + candidate.length > MAX_DIFF_ROWS) {
      truncated = true;
      break;
    }
    rows.push(...candidate);
  }

  return { rows, truncated };
}
