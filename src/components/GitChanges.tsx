import { useCallback, useEffect, useRef, useState } from "react";
import { gitBranchInfo, gitCommit, gitDiffFile, gitStageAll, gitStageFile, gitStatus, gitUnstageAll, gitUnstageFile } from "../api";
import { useKeyedSilentRefresh } from "../hooks/useKeyedSilentRefresh";
import type { GitBranchInfo, GitChange, GitFileDiff } from "../types";
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
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
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
      const [list, info] = await Promise.all([
        gitStatus(dir),
        gitBranchInfo(dir).catch(() => null),
      ]);
      if (seq !== requestSeq.current || cwdRef.current !== dir) return;
      setChanges((prev) => (sameGitChanges(prev, list) ? prev : list));
      setBranchInfo(info);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current || cwdRef.current !== dir) return;
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
      setBranchInfo(null);
      setDiff(null);
      setDiffPath(null);
      setError(null);
      setCommitMsg("");
      setCommitResult(null);
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

  const handleFileClick = useCallback(
    async (path: string, staged: boolean) => {
      if (!cwd) return;
      if (diffPath === path && diffStaged === staged) {
        // Toggle off
        setDiff(null);
        setDiffPath(null);
        return;
      }
      setDiffLoading(true);
      setDiffPath(path);
      setDiffStaged(staged);
      setDiff(null);
      try {
        const d = await gitDiffFile(cwd, path, staged);
        if (cwdRef.current === cwd) {
          setDiff(d);
        }
      } catch {
        // ignore
      } finally {
        setDiffLoading(false);
      }
    },
    [cwd, diffPath, diffStaged],
  );

  const handleStage = useCallback(
    async (path: string) => {
      if (!cwd) return;
      try {
        await gitStageFile(cwd, path);
        void refresh(cwd, true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [cwd, refresh],
  );

  const handleUnstage = useCallback(
    async (path: string) => {
      if (!cwd) return;
      try {
        await gitUnstageFile(cwd, path);
        void refresh(cwd, true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [cwd, refresh],
  );

  const handleStageAll = useCallback(async () => {
    if (!cwd) return;
    try {
      await gitStageAll(cwd);
      void refresh(cwd, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd, refresh]);

  const handleUnstageAll = useCallback(async () => {
    if (!cwd) return;
    try {
      await gitUnstageAll(cwd);
      void refresh(cwd, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cwd, refresh]);

  const handleCommit = useCallback(async () => {
    if (!cwd || !commitMsg.trim()) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const result = await gitCommit(cwd, commitMsg.trim());
      setCommitResult(result || "Committed successfully.");
      setCommitMsg("");
      void refresh(cwd, false);
    } catch (e) {
      setCommitResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCommitting(false);
    }
  }, [cwd, commitMsg, refresh]);

  if (!cwd) {
    return (
      <div className="workspace-section git-changes-section">
        <div className="empty-hint small">
          Select a session to see uncommitted files.
        </div>
      </div>
    );
  }

  // Split changes into staged (X != ' ') and unstaged (Y != ' ')
  const stagedChanges = changes.filter((c) => {
    const s = c.status;
    return s.length >= 2 && s[0] !== " " && s[0] !== "?";
  });
  const unstagedChanges = changes.filter((c) => {
    const s = c.status;
    return s.length >= 2 && s[1] !== " " && s[1] !== "?";
  });
  const hasStaged = stagedChanges.length > 0;
  const hasUnstaged = unstagedChanges.length > 0;

  return (
    <div className="workspace-section git-changes-section">
      {/* Branch info bar */}
      {branchInfo && (
        <div className="git-branch-bar">
          <span className="git-branch-name mono">
            {branchInfo.branch ?? "(detached)"}
          </span>
          {branchInfo.upstream && (
            <span className="git-upstream muted">
              ↑{branchInfo.ahead} ↓{branchInfo.behind} {branchInfo.upstream}
            </span>
          )}
          <span className="git-counts muted">
            {branchInfo.stagedCount > 0 && (
              <span className="git-staged-count">
                +{branchInfo.stagedCount} staged
              </span>
            )}
            {branchInfo.unstagedCount > 0 && (
              <span className="git-unstaged-count">
                {" "}~{branchInfo.unstagedCount} unstaged
              </span>
            )}
            {branchInfo.untrackedCount > 0 && (
              <span className="git-untracked-count">
                {" "}?{branchInfo.untrackedCount} new
              </span>
            )}
          </span>
        </div>
      )}

      {error && <div className="empty-hint error-text small">{error}</div>}
      {loading && changes.length === 0 ? (
        <div className="empty-hint small">Loading…</div>
      ) : changes.length === 0 && !hasStaged && !hasUnstaged ? (
        <div className="empty-hint small">
          No uncommitted changes
          {error ? null : " (or not a git repo)"}
        </div>
      ) : (
        <>
          {/* Staged changes */}
          {hasStaged && (
            <div className="git-section-group">
              <div className="git-section-header">
                <span className="git-section-label">Staged</span>
                <button
                  className="btn-link small"
                  onClick={handleUnstageAll}
                  title="Unstage all"
                >
                  Unstage all
                </button>
              </div>
              <ul className="git-change-list">
                {stagedChanges.map((c) => renderChangeRow(c, cwd, {
                  selectedPath,
                  onSelectFile,
                  diffPath,
                  diffStaged,
                  diffLoading,
                  onFileClick: handleFileClick,
                  onStage: handleStage,
                  onUnstage: handleUnstage,
                  staged: true,
                }))}
              </ul>
            </div>
          )}

          {/* Unstaged changes */}
          {hasUnstaged && (
            <div className="git-section-group">
              <div className="git-section-header">
                <span className="git-section-label">Unstaged</span>
                <button
                  className="btn-link small"
                  onClick={handleStageAll}
                  title="Stage all"
                >
                  Stage all
                </button>
              </div>
              <ul className="git-change-list">
                {unstagedChanges.map((c) => renderChangeRow(c, cwd, {
                  selectedPath,
                  onSelectFile,
                  diffPath,
                  diffStaged,
                  diffLoading,
                  onFileClick: handleFileClick,
                  onStage: handleStage,
                  onUnstage: handleUnstage,
                  staged: false,
                }))}
              </ul>
            </div>
          )}

          {/* Inline diff viewer */}
          {diff && diffPath && (
            <div className="git-diff-inline">
              <div className="git-diff-header">
                <span className="mono">{diffPath}</span>
                <span className="muted">({diff.kind})</span>
                <button
                  className="btn-link small"
                  onClick={() => { setDiff(null); setDiffPath(null); }}
                >
                  Close
                </button>
              </div>
              <pre className="git-diff-content mono">
                {diff.diff || "(no changes)"}
              </pre>
            </div>
          )}

          {/* Commit section */}
          {hasStaged && (
            <div className="git-commit-section">
              <textarea
                className="git-commit-input"
                placeholder="Commit message…"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                rows={2}
                disabled={committing}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCommit}
                disabled={committing || !commitMsg.trim()}
              >
                {committing ? "Committing…" : "Commit"}
              </button>
              {commitResult && (
                <div className="git-commit-result small muted">{commitResult}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface RowActions {
  selectedPath: string | null;
  onSelectFile: ((path: string) => void) | undefined;
  diffPath: string | null;
  diffStaged: boolean;
  diffLoading: boolean;
  onFileClick: (path: string, staged: boolean) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  staged: boolean;
}

function renderChangeRow(
  c: GitChange,
  cwd: string,
  actions: RowActions,
) {
  const abs = joinUnderRoot(cwd, c.path);
  const selected =
    actions.selectedPath != null && pathsEqual(actions.selectedPath, abs);
  const diffActive =
    actions.diffPath === c.path && actions.diffStaged === actions.staged;
  const s = c.status;
  const indexChar = s.length >= 2 && s[0] !== " " ? s[0] : null;

  return (
    <li
      key={`${c.path}-${actions.staged ? "s" : "u"}`}
      className={
        `git-change kind-${c.kind}` +
        (selected ? " is-selected" : "") +
        (actions.onSelectFile ? " is-clickable" : "")
      }
      title={actions.onSelectFile ? `${abs}\nClick to preview` : abs}
    >
      <span
        className={`git-badge kind-${c.kind}`}
        title={c.status}
        onClick={() => actions.onFileClick(c.path, actions.staged)}
        style={{ cursor: "pointer" }}
      >
        {actions.diffLoading && diffActive ? "…" : statusLetter(c)}
      </span>
      <span
        className="git-path mono"
        title={c.path}
        onClick={() => actions.onSelectFile?.(abs)}
      >
        {c.path}
      </span>
      <span className="git-kind muted">{c.kind}</span>
      <span className="git-row-actions">
        {actions.staged ? (
          <button
            className="btn-link tiny"
            onClick={(e) => { e.stopPropagation(); actions.onUnstage(c.path); }}
            title="Unstage"
          >
            −
          </button>
        ) : (
          indexChar && (
            <button
              className="btn-link tiny"
              onClick={(e) => { e.stopPropagation(); actions.onStage(c.path); }}
              title="Stage"
            >
              +
            </button>
          )
        )}
      </span>
    </li>
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
