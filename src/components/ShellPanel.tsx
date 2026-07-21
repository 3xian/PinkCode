import { memo, useMemo, useState } from "react";
import type { LiveShellPayload } from "../types";

/** Collapse when longer than this many lines (show tail by default). */
const COLLAPSE_LINES = 40;
/** Always keep at least this many tail lines when collapsed. */
const TAIL_LINES = 28;
/** Max chars kept when collapsed (after line tail, if still long). */
const CHAR_TAIL = 3_500;

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

function tailLines(s: string, maxLines: number): string {
  if (!s) return s;
  let lines = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s.charCodeAt(i) === 10) {
      lines++;
      if (lines >= maxLines) {
        return s.slice(i + 1);
      }
    }
  }
  return s;
}

function tailChars(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `…\n${s.slice(-(maxChars - 2))}`;
}

/** Collapse for display: line tail first, then char tail if still huge. */
function collapsedDisplay(output: string): {
  text: string;
  hiddenLines: number;
  truncatedByChars: boolean;
} {
  const lineCount = countLines(output);
  let text = output;
  let hiddenLines = 0;

  if (lineCount > COLLAPSE_LINES) {
    text = tailLines(output, TAIL_LINES);
    hiddenLines = Math.max(0, lineCount - TAIL_LINES);
  }

  let truncatedByChars = false;
  if (text.length > CHAR_TAIL) {
    text = tailChars(text, CHAR_TAIL);
    truncatedByChars = true;
  }

  return { text, hiddenLines, truncatedByChars };
}

/** Inline shell command card used inside the Live timeline. */
export const ShellCard = memo(function ShellCard({
  shell,
}: {
  shell: LiveShellPayload;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = shell.output || "";
  const lineCount = useMemo(() => countLines(output), [output]);
  const collapsed = useMemo(() => collapsedDisplay(output), [output]);
  // Only offer collapse UI when collapsed view is actually shorter.
  const shouldCollapse =
    output.length > 0 && collapsed.text.length < output.length;
  const displayOut =
    shouldCollapse && !expanded ? collapsed.text : output;

  return (
    <div className={`shell-card status-${shell.status || "unknown"}`}>
      <div className="shell-card-top">
        <span className={`shell-status ${shell.status}`}>
          {shell.status || "…"}
        </span>
        {shell.exitCode != null && (
          <span
            className={`exit-code ${shell.exitCode === 0 ? "ok" : "fail"}`}
          >
            exit {shell.exitCode}
          </span>
        )}
        {shell.description && (
          <span className="muted small">{shell.description}</span>
        )}
      </div>
      <div className="shell-cmd mono">$ {shell.command || "(command)"}</div>
      {output ? (
        <>
          {shouldCollapse && (
            <div className="shell-collapse-bar">
              <button
                type="button"
                className="btn ghost shell-collapse-btn"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded
                  ? "Collapse output"
                  : lineCount > COLLAPSE_LINES
                    ? `Show full output (${lineCount} lines)`
                    : `Show full output (${(output.length / 1024).toFixed(1)} KB)`}
              </button>
              {!expanded && collapsed.hiddenLines > 0 && (
                <span className="muted small">
                  showing last {TAIL_LINES} · {collapsed.hiddenLines} lines
                  above
                </span>
              )}
              {!expanded &&
                collapsed.hiddenLines === 0 &&
                collapsed.truncatedByChars && (
                  <span className="muted small">showing tail only</span>
                )}
            </div>
          )}
          <pre className="shell-out">{displayOut}</pre>
        </>
      ) : (
        <div className="muted small shell-waiting">waiting for output…</div>
      )}
    </div>
  );
});
