import { useCallback, useEffect, useRef, useState } from "react";
import { gitStatus } from "../api";
import { useKeyedSilentRefresh } from "../hooks/useKeyedSilentRefresh";
import type { GitChange } from "../types";
import { joinUnderRoot, pathsEqual } from "../utils/paths";

interface Props {
  cwd: string | null;
  /** Whether the Git tab is visible; hidden panels do not poll. */
  active?: boolean;
  /** Bump to force a refresh (e.g. after FS events). Debounce in parent. */
  refreshKey?: number;
  /** Currently previewed path (highlight). */
  selectedPath?: string | null;
  /** Click a changed file → preview. Path is absolute under cwd when possible. */
  onSelectFile?: (path: string) => void;
  /** Report change count so parent tab can show a badge. */
  onCountChange?: (count: number) => void;
}

export function GitChanges({
  cwd,
  active = true,
  refreshKey = 0,
  selectedPath = null,
  onSelectFile,
  onCountChange,
}: Props) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Only for first load of a cwd when the list is empty. */
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const refresh = useCallback(async (dir: string, silent: boolean) => {
    const seq = ++requestSeq.current;
    if (!silent && changesRef.current.length === 0) {
      setLoading(true);
    }
    try {
      const list = await gitStatus(dir);
      if (seq !== requestSeq.current || cwdRef.current !== dir) return;
      setChanges((prev) => (sameGitChanges(prev, list) ? prev : list));
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current || cwdRef.current !== dir) return;
      // Keep previous list on transient failures so the panel does not blink empty.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeq.current && cwdRef.current === dir) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    onCountChangeRef.current?.(changes.length);
  }, [changes.length]);

  useKeyedSilentRefresh({
    identity: cwd,
    refreshKey,
    onIdentityChange: (id) => {
      requestSeq.current += 1;
      setChanges([]);
      setError(null);
      onCountChangeRef.current?.(0);
      if (!id) {
        setLoading(false);
        return;
      }
      void refresh(id, false);
    },
    onSilentRefresh: (id) => {
      void refresh(id, true);
    },
  });

  // Slow safety poll (silent). Pause when the tab/window is hidden.
  useEffect(() => {
    if (!cwd || !active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh(cwd, true);
      }
    }, 30_000);
    return () => window.clearInterval(id);
  }, [cwd, active, refresh]);

  if (!cwd) {
    return (
      <div className="workspace-section git-changes-section">
        <div className="empty-hint small">
          Select a session to see uncommitted files.
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-section git-changes-section">
      {error && <div className="empty-hint error-text small">{error}</div>}
      {loading && changes.length === 0 ? (
        <div className="empty-hint small">Loading…</div>
      ) : changes.length === 0 ? (
        <div className="empty-hint small">
          No uncommitted changes
          {error ? null : " (or not a git repo)"}
        </div>
      ) : (
        <ul className="git-change-list">
          {changes.map((c) => {
            const abs = joinUnderRoot(cwd, c.path);
            const selected =
              selectedPath != null && pathsEqual(selectedPath, abs);
            return (
              <li
                key={c.path}
                className={
                  `git-change kind-${c.kind}` +
                  (selected ? " is-selected" : "") +
                  (onSelectFile ? " is-clickable" : "")
                }
                title={onSelectFile ? `${abs}\nClick to preview` : abs}
                onClick={() => onSelectFile?.(abs)}
              >
                <span className={`git-badge kind-${c.kind}`} title={c.status}>
                  {statusLetter(c)}
                </span>
                <span className="git-path mono" title={c.path}>
                  {c.path}
                </span>
                <span className="git-kind muted">{c.kind}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function sameGitChanges(a: GitChange[], b: GitChange[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].path !== b[i].path ||
      a[i].status !== b[i].status ||
      a[i].kind !== b[i].kind
    ) {
      return false;
    }
  }
  return true;
}

function statusLetter(c: GitChange): string {
  const s = c.status.replace(/\s/g, "");
  if (s === "??") return "U";
  if (s.length === 0) return "?";
  // Prefer index letter, else worktree.
  const ch = c.status[0] !== " " ? c.status[0]! : c.status[1] ?? "?";
  return ch === "?" ? "U" : ch;
}
