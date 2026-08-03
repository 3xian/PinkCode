/**
 * Modified-file diff for edit/write tool cards.
 *
 * Mirrors Grok Build's Edit scrollback block (`extract_edit_hunks` →
 * `build_diff_hunks` → `diff_hunks_to_patch`): the agent's file mutations
 * render as a unified diff of the old → new content. Data sources, in order:
 *
 * 1. `rawOutput` typed `SearchReplace`/`EditsApplied` — structured per-edit
 *    details (`edits.details[]`) with context + line numbers.
 * 2. ACP `content` `{"type":"diff"}` blocks — full old/new text (used for
 *    pre-execution previews and the write tool).
 *
 * The full post-write content (`FileWritten`) never reaches ACP clients —
 * grok-build routes it to its hunk tracker only — so this is the faithful
 * timeline representation of "modified file content".
 */

import { extractToolMeta } from "./toolTitle";

/** Cap rendered diff size so a huge write cannot balloon a timeline card. */
const MAX_EDIT_DIFF_CHARS = 12_000;
/** Context lines kept above/below each change (Grok `MAX_CONTEXT`). */
const MAX_CONTEXT = 3;
/** LCS diff cell budget; beyond it we skip alignment (all -/+ run). */
const MAX_LCS_CELLS = 1_000_000;

type Tag = "equal" | "delete" | "insert";

interface DiffLine {
  tag: Tag;
  text: string;
  /** 1-based line in the old file. */
  lo: number;
  /** 1-based line in the new file. */
  ln: number;
}

interface EditDetail {
  old_string?: string;
  new_string?: string;
  old_line?: number;
  new_line?: number;
  context_before?: string;
  context_after?: string;
  line_prefix?: string;
}

/** Edit-class tool names (tool meta `name`), lowercased. */
const EDIT_TOOL_NAMES: Record<string, true> = {
  search_replace: true,
  apply_patch: true,
  str_replace: true,
  write: true,
  edit: true,
  grok_build_concise_search_replace: true,
  opencode_edit: true,
  opencode_write: true,
  codex_apply_patch: true,
};

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** `split_inclusive('\n')` — keep the trailing newline on each line. */
function splitLinesKeepNewline(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * Line-based diff of two texts (Rust `similar::TextDiff::from_lines`
 * equivalent via LCS). Falls back to an unaligned -/+ run when the texts
 * are too large for the DP table.
 */
function lineDiff(oldText: string, newText: string): Array<{ tag: Tag; text: string }> {
  const a = splitLinesKeepNewline(oldText);
  const b = splitLinesKeepNewline(newText);
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_LCS_CELLS) {
    const ops: Array<{ tag: Tag; text: string }> = [];
    for (const line of a) ops.push({ tag: "delete", text: line });
    for (const line of b) ops.push({ tag: "insert", text: line });
    return ops;
  }

  // Longest-common-subsequence table (bottom-up).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ tag: Tag; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: "delete", text: a[i] });
      i += 1;
    } else {
      ops.push({ tag: "insert", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ tag: "delete", text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ tag: "insert", text: b[j] });
    j += 1;
  }
  return ops;
}

/** One edit detail → diff lines with old/new line numbers (Grok build_diff_hunks). */
function detailToLines(d: EditDetail): DiffLine[] {
  const oldLine = d.old_line ?? 1;
  const newLine = d.new_line ?? 1;
  const before = splitLinesKeepNewline(d.context_before ?? "");
  const after = splitLinesKeepNewline(d.context_after ?? "");
  const lines: DiffLine[] = [];

  for (let i = 0; i < before.length; i++) {
    const fromEnd = before.length - (i + 1);
    lines.push({
      tag: "equal",
      text: before[i],
      lo: Math.max(1, oldLine - fromEnd - 1),
      ln: Math.max(1, newLine - fromEnd - 1),
    });
  }

  let lo = oldLine;
  let ln = newLine;
  const oldString = d.old_string ?? "";
  let newString = d.new_string ?? "";
  const emptyToEmpty = oldString === "" && newString === "";
  const midFile = before.length > 0 || after.length > 0;
  if (emptyToEmpty && midFile) {
    // Blank-line insertion: both sides empty but a line was inserted.
    newString = "\n";
  }

  const prefix = d.line_prefix ?? "";
  const hasPrefix = prefix !== "";
  let prefixAppliedDelete = false;
  let prefixAppliedInsert = false;
  for (const op of lineDiff(oldString, newString)) {
    let text = op.text;
    if (hasPrefix) {
      const needsPrefix =
        op.tag === "delete"
          ? !prefixAppliedDelete
          : op.tag === "insert"
            ? !prefixAppliedInsert
            : !prefixAppliedDelete && !prefixAppliedInsert;
      if (needsPrefix) text = prefix + text;
      if (op.tag !== "insert") prefixAppliedDelete = true;
      if (op.tag !== "delete") prefixAppliedInsert = true;
    }
    lines.push({ tag: op.tag, text, lo, ln });
    if (op.tag !== "insert") lo += 1;
    if (op.tag !== "delete") ln += 1;
  }

  for (const line of after) {
    lines.push({ tag: "equal", text: line, lo, ln });
    lo += 1;
    ln += 1;
  }
  return lines;
}

/** Trim blank context and cap context runs (Grok trim + MAX_CONTEXT). */
function trimHunk(lines: DiffLine[]): DiffLine[] {
  const total = lines.length;
  let equalBefore = 0;
  while (equalBefore < total && lines[equalBefore].tag === "equal") equalBefore += 1;
  let equalAfter = 0;
  while (equalAfter < total - equalBefore && lines[total - 1 - equalAfter].tag === "equal") {
    equalAfter += 1;
  }
  let start = Math.max(0, equalBefore - MAX_CONTEXT);
  let end = total - Math.max(0, equalAfter - MAX_CONTEXT);
  while (start < end && lines[start].tag === "equal" && lines[start].text.trim() === "") {
    start += 1;
  }
  while (start < end && lines[end - 1].tag === "equal" && lines[end - 1].text.trim() === "") {
    end -= 1;
  }
  return start < end ? lines.slice(start, end) : [];
}

/** Unified-diff patch text for a set of hunks (Grok diff_hunks_to_patch). */
function renderPatch(hunks: DiffLine[][]): string {
  if (!hunks.length) return "";
  const out: string[] = [];
  for (const hunk of hunks) {
    if (!hunk.length) continue;
    const oldStart =
      hunk.find((l) => l.tag !== "insert")?.lo ?? 1;
    const newStart =
      hunk.find((l) => l.tag !== "delete")?.ln ?? 1;
    const oldCount = hunk.filter((l) => l.tag !== "insert").length;
    const newCount = hunk.filter((l) => l.tag !== "delete").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of hunk) {
      const prefix = line.tag === "equal" ? " " : line.tag === "insert" ? "+" : "-";
      out.push(prefix + line.text.replace(/\r?\n$/, ""));
    }
  }
  return out.join("\n");
}

function diffFromDetails(details: unknown[]): string | undefined {
  const hunks: DiffLine[][] = [];
  for (const raw of details) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const d: EditDetail = {
      old_string: str(rec.old_string),
      new_string: str(rec.new_string),
      old_line: num(rec.old_line),
      new_line: num(rec.new_line),
      context_before: str(rec.context_before),
      context_after: str(rec.context_after),
      line_prefix: str(rec.line_prefix),
    };
    const hunk = trimHunk(detailToLines(d));
    if (hunk.length) hunks.push(hunk);
  }
  const patch = renderPatch(hunks);
  return capPatch(patch);
}

function capPatch(patch: string): string | undefined {
  if (!patch) return undefined;
  if (patch.length <= MAX_EDIT_DIFF_CHARS) return patch;
  return `${patch.slice(0, MAX_EDIT_DIFF_CHARS)}…\n(diff truncated)`;
}

/**
 * Strategy 1: `rawOutput` typed `SearchReplace` with `EditsApplied`.
 * Wire: `{ type: "SearchReplace", EditsApplied: { edits: { details: [...] } } }`.
 */
function diffFromRawOutput(rawOutput: unknown): string | undefined {
  const raw = asRecord(rawOutput);
  if (!raw || raw.type !== "SearchReplace") return undefined;
  const applied = asRecord(raw.EditsApplied);
  if (!applied) return undefined;
  const edits = asRecord(applied.edits);
  const details = Array.isArray(edits?.details) ? edits.details : [];
  if (!details.length) return undefined;
  return diffFromDetails(details);
}

/**
 * Strategy 2: ACP `content` Diff blocks. The wire ships camelCase
 * `{ type: "diff", path, oldText, newText, _meta: {old_line, new_line} }`;
 * pre-execution previews and disk logs also carry snake_case `old_text` /
 * `new_text` / `meta`. Accept both spellings.
 */
function diffFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const b = asRecord(block);
    if (!b || b.type !== "diff") continue;
    const oldText = str(b.oldText) || str(b.old_text);
    const newText = str(b.newText) || str(b.new_text);
    if (!oldText && !newText) continue;
    const meta = asRecord(b._meta) ?? asRecord(b.meta);
    const startLine = num(meta?.new_line) ?? 1;
    const hunks = [
      trimHunk(
        detailToLines({
          old_string: oldText,
          new_string: newText,
          old_line: startLine,
          new_line: startLine,
        }),
      ),
    ].filter((h) => h.length > 0);
    const patch = renderPatch(hunks);
    if (patch) return capPatch(patch);
  }
  return undefined;
}

/** Whether this tool update is an edit/write class that can carry a diff. */
export function isEditToolUpdate(inner: Record<string, unknown>): boolean {
  // ACP ToolKind serializes lowercase (`"kind":"edit"`); the shell maps both
  // search_replace and write-class tools to ToolKind::Edit.
  const kind = String(inner.kind ?? "").trim().toLowerCase();
  if (kind === "edit" || kind === "write") return true;
  const name = String(extractToolMeta(inner).name ?? "")
    .trim()
    .toLowerCase();
  // Own-key check: a plain Record inherits Object.prototype, so a tool named
  // "toString" must not be mistaken for an edit tool.
  if (Object.prototype.hasOwnProperty.call(EDIT_TOOL_NAMES, name)) return true;
  const title = String(inner.title ?? "").trim().toLowerCase();
  // Wire titles are "Edit `path`" / "Write `path`"; snake-case tool names
  // (str_replace, apply_patch, …) are already covered by EDIT_TOOL_NAMES.
  return /^(edit|write)\b/.test(title);
}

/**
 * Unified diff of the modified file, or `undefined` when the update carries
 * no editable content (e.g. a mid-stream status update).
 */
export function extractEditDiff(inner: Record<string, unknown>): string | undefined {
  const rawOutput = inner.rawOutput ?? inner.raw_output;
  const fromRaw = diffFromRawOutput(rawOutput);
  if (fromRaw) return fromRaw;
  return diffFromContent(inner.content);
}
