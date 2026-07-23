import { useMemo } from "react";
import type { SessionCard } from "../types";
import {
  contextPct,
  formatRelative,
  formatTokens,
  projectName,
} from "../utils/format";

interface Props {
  sessions: SessionCard[];
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  /** Live ACP sessions (card accent + sort). No per-card attach control. */
  managedSessionIds?: Set<string>;
  onNewTask?: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  query,
  onQuery,
  onSelect,
  managedSessionIds,
  onNewTask,
}: Props) {
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.headBranch ?? "").toLowerCase().includes(q),
        )
      : sessions.slice();

    // Confirmed attached (ACP) sessions first; keep relative order within groups.
    // Caller excludes mid-attach `starting` so the list only jumps after success.
    list.sort((a, b) => {
      const am = managedSessionIds?.has(a.id) ? 0 : 1;
      const bm = managedSessionIds?.has(b.id) ? 0 : 1;
      return am - bm;
    });
    return list;
  }, [sessions, query, managedSessionIds]);

  return (
    <div className="session-list">
      <div className="panel-header">
        <div className="panel-header-left">
          <h2>Tasks</h2>
        </div>
        <div className="panel-header-right">
          {onNewTask && (
            <button
              className="btn primary"
              type="button"
              onClick={onNewTask}
            >
              + New
            </button>
          )}
        </div>
      </div>

      <div className="list-controls">
        <input
          className="search"
          placeholder="Filter by title, path, id…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>

      <div className="session-cards">
        {visible.length === 0 && (
          <div className="empty-hint">No sessions match.</div>
        )}
        {visible.map((s) => {
          // Scheme A: single visual state (priority order).
          // ACP live > Grok disk-active > idle. (No red/error bar.)
          const managed = managedSessionIds?.has(s.id) ?? false;
          const state = resolveCardState({
            managed,
            diskActive: s.isActive && !managed,
          });
          const cardClass = [
            "session-card",
            selectedId === s.id ? "selected" : "",
            state !== "idle" ? `state-${state}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={s.id}
              className={cardClass}
              onClick={() => onSelect(s.id)}
            >
              <div className="card-top" title={stateTitle(state)}>
                <span className="card-title" title={s.title}>
                  {s.title}
                </span>
              </div>
              <div className="card-meta">
                <span title={s.cwd}>{projectName(s.cwd)}</span>
                {s.headBranch && (
                  <span className="branch">⎇ {s.headBranch}</span>
                )}
                <span className="time">
                  {formatRelative(s.lastActiveAt ?? s.updatedAt)}
                </span>
              </div>
              <div className="card-metrics">
                <span>{formatTokens(s.contextTokensUsed)} tok</span>
                <span>
                  {contextPct(s.contextTokensUsed, s.contextWindowTokens)}% ctx
                </span>
                {(s.agentLinesAdded > 0 || s.agentLinesRemoved > 0) && (
                  <span className="diff-stat">
                    +{s.agentLinesAdded}/−{s.agentLinesRemoved}
                  </span>
                )}
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Visual run-state for a task card (scheme A). */
type CardState = "live" | "disk-active" | "idle";

function resolveCardState(opts: {
  managed: boolean;
  diskActive: boolean;
}): CardState {
  // 1) MarsBuild ACP attached
  if (opts.managed) return "live";
  // 2) Grok lists session active on disk, not attached here
  if (opts.diskActive) return "disk-active";
  // 3) idle / unknown / anything else → neutral idle
  return "idle";
}

function stateTitle(state: CardState): string {
  switch (state) {
    case "live":
      return "Live in MarsBuild";
    case "disk-active":
      return "Active in Grok Build — send a message here to connect";
    case "idle":
      return "Idle";
  }
}
