import { useCallback, useEffect, useRef, useState } from "react";
import { gitStatus } from "../api";
import { useKeyedSilentRefresh } from "../hooks/useKeyedSilentRefresh";
import type { GitChange } from "../types";

interface Props {
  cwd: string | null;
  /** Bump to force a refresh (e.g. after FS events). Debounce in parent. */
  refreshKey?: number;
}

export function GitChanges({ cwd, refreshKey = 0 }: Props) {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Only for first load of a cwd when the list is empty. */
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const changesRef = useRef(changes);
  changesRef.current = changes;

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

  useKeyedSilentRefresh({
    identity: cwd,
    refreshKey,
    onIdentityChange: (id) => {
      requestSeq.current += 1;
      setChanges([]);
      setError(null);
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

  // Slow safety poll (silent). Parent FS events cover the hot path.
  useEffect(() => {
    if (!cwd) return;
    const id = window.setInterval(() => void refresh(cwd, true), 12_000);
    return () => window.clearInterval(id);
  }, [cwd, refresh]);

  if (!cwd) {
    return (
      <div className="workspace-section">
        <div className="panel-header">
          <h2>Git changes</h2>
        </div>
        <div className="empty-hint small">Select a session to see uncommitted files.</div>
      </div>
    );
  }

  return (
    <div className="workspace-section git-changes-section">
      <div className="panel-header">
        <h2>
          Git changes
          {changes.length > 0 && (
            <span className="tab-count">{changes.length}</span>
          )}
        </h2>
      </div>
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
          {changes.map((c) => (
            <li key={c.path} className={`git-change kind-${c.kind}`}>
              <span className={`git-badge kind-${c.kind}`} title={c.status}>
                {statusLetter(c)}
              </span>
              <span className="git-path mono" title={c.path}>
                {c.path}
              </span>
              <span className="git-kind muted">{c.kind}</span>
            </li>
          ))}
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
  if (c.kind === "untracked") return "U";
  if (c.kind === "added") return "A";
  if (c.kind === "deleted") return "D";
  if (c.kind === "renamed") return "R";
  if (c.kind === "modified") return "M";
  if (c.kind === "unmerged") return "!";
  const trimmed = c.status.replace(/ /g, "");
  return (trimmed[0] || "?").toUpperCase();
}
