import { memo, useMemo } from "react";
import { buildDiffSnippet } from "../utils/diffSnippet";

/**
 * Grok Build-style before/after snippet for an edited file: @@ hunk headers,
 * old/new line-number gutters, and tinted +/- lines.
 *
 * Falls back to the raw patch text when the detail carries no parseable hunk
 * (callers reuse the same `detail` for tool cards that are not edit diffs).
 */
export const DiffSnippet = memo(function DiffSnippet({
  patch,
}: {
  patch: string;
}) {
  const snippet = useMemo(() => buildDiffSnippet(patch), [patch]);

  if (!snippet) {
    return <pre className="tl-diff-fallback">{patch}</pre>;
  }

  return (
    <div className="tl-diff" aria-label="Edited file diff">
      {snippet.rows.map((row, i) =>
        row.tag === "hunk" ? (
          <div key={i} className="tl-diff-hunk">
            {row.text}
          </div>
        ) : (
          <div
            key={i}
            className={`tl-diff-line tl-diff-${row.tag}`}
          >
            <span className="tl-diff-num" aria-hidden>
              {row.oldLine ?? ""}
            </span>
            <span className="tl-diff-num" aria-hidden>
              {row.newLine ?? ""}
            </span>
            <span className="tl-diff-sign" aria-hidden>
              {row.tag === "insert" ? "+" : row.tag === "delete" ? "−" : ""}
            </span>
            <span className="tl-diff-text">{row.text}</span>
          </div>
        ),
      )}
      {snippet.truncated && (
        <div className="tl-diff-trunc" aria-hidden>
          …
        </div>
      )}
    </div>
  );
});
