import { useCallback, useMemo, useState } from "react";
import { gitApplyPatch } from "../api";
import type { GitFileDiff } from "../types";
import {
  buildPartialPatch,
  parseUnifiedDiff,
  type DiffHunk,
} from "../utils/gitDiffHunks";

interface Props {
  cwd: string;
  path: string;
  diff: GitFileDiff;
  /** True when viewing the staged index side (unstage on apply). */
  staged: boolean;
  onClose: () => void;
  /** Called after a successful hunk apply so parent can refresh status. */
  onApplied: () => void;
  onError?: (message: string) => void;
}

/**
 * Inline per-hunk stage/unstage UI for a single-file unified diff.
 * Owned separately from the file-list chrome in GitChanges.
 */
export function GitDiffHunkPanel({
  cwd,
  path,
  diff,
  staged,
  onClose,
  onApplied,
  onError,
}: Props) {
  const parsed = useMemo(() => parseUnifiedDiff(diff.diff), [diff.diff]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const toggle = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(parsed.hunks.map((h) => h.index)));
  }, [parsed.hunks]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const applySelected = useCallback(async () => {
    if (selected.size === 0) return;
    const patch = buildPartialPatch(parsed, selected);
    if (!patch) return;
    setBusy(true);
    try {
      await gitApplyPatch(cwd, patch, staged);
      setSelected(new Set());
      onApplied();
      onClose();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [cwd, parsed, selected, staged, onApplied, onClose, onError]);

  return (
    <div className="git-diff-inline">
      <div className="git-diff-header">
        <span className="mono">{path}</span>
        <span className="muted">({diff.kind})</span>
        {!parsed.empty && (
          <>
            <button
              className="btn-link small"
              type="button"
              onClick={selectAll}
              disabled={busy}
            >
              Select all
            </button>
            <button
              className="btn-link small"
              type="button"
              onClick={clear}
              disabled={busy || selected.size === 0}
            >
              Clear
            </button>
            <button
              className="btn-link small"
              type="button"
              onClick={() => void applySelected()}
              disabled={busy || selected.size === 0}
              title={
                staged ? "Unstage selected hunks" : "Stage selected hunks"
              }
            >
              {busy
                ? "…"
                : staged
                  ? `Unstage ${selected.size || ""}`.trim()
                  : `Stage ${selected.size || ""}`.trim()}
            </button>
          </>
        )}
        <button className="btn-link small" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {parsed.empty ? (
        <pre className="git-diff-content mono">
          {diff.diff || "(no changes)"}
        </pre>
      ) : (
        <div className="git-hunk-list">
          {parsed.hunks.map((h) => (
            <HunkBlock
              key={h.index}
              hunk={h}
              selected={selected.has(h.index)}
              onToggle={() => toggle(h.index)}
              disabled={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HunkBlock({
  hunk,
  selected,
  onToggle,
  disabled,
}: {
  hunk: DiffHunk;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={"git-hunk-block" + (selected ? " is-selected" : "")}
      data-hunk={hunk.index}
    >
      <label className="git-hunk-toolbar">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
        />
        <span className="git-hunk-header mono" title={hunk.header}>
          {hunk.header}
        </span>
        <span className="git-hunk-stats muted">
          <span className="add">+{hunk.added}</span>
          <span className="del">−{hunk.removed}</span>
        </span>
      </label>
      <pre className="git-diff-content mono git-hunk-body">{hunk.body}</pre>
    </div>
  );
}
