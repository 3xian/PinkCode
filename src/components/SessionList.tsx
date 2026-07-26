import { useMemo } from "react";
import type { ManagedStatus, SessionCard } from "../types";
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
  /**
   * ACP-attached sessions (not starting/stopped/error).
   * Used for sort + “live” accent when not actively running.
   */
  managedSessionIds?: Set<string>;
  /** Per-session managed status for run-state chrome (running pulse, etc.). */
  managedStatuses?: Record<string, ManagedStatus>;
  onNewTask?: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  query,
  onQuery,
  onSelect,
  managedSessionIds,
  managedStatuses,
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

    // Mid-turn first, then attached / open elsewhere, keep relative order.
    list.sort((a, b) => {
      const ar = rankCard(a, managedSessionIds, managedStatuses);
      const br = rankCard(b, managedSessionIds, managedStatuses);
      return ar - br;
    });
    return list;
  }, [sessions, query, managedSessionIds, managedStatuses]);

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
          // Priority: running (mid-turn) > awaiting > live > open-elsewhere > idle
          const managed = managedSessionIds?.has(s.id) ?? false;
          const managedStatus = managedStatuses?.[s.id];
          // Live PID in active_sessions.json, not attached here — "open", not mid-turn.
          const openElsewhere = s.isActive && !managed;
          const state = resolveCardState({
            managed,
            managedStatus,
            openElsewhere,
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
              aria-busy={state === "running" ? true : undefined}
            >
              <div className="card-top" title={stateTitle(state)}>
                <span className="card-title" title={s.title}>
                  {s.title}
                </span>
                {state === "awaiting" && (
                  <span className="card-await-label">Waiting</span>
                )}
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

/**
 * Visual run-state for a task card.
 * - running: PinkCode ACP mid-turn only (true "agent is working")
 * - open: Grok Build (or other host) process still open — not mid-turn
 * - awaiting / live: PinkCode attached
 */
type CardState = "running" | "awaiting" | "live" | "open" | "idle";

function resolveCardState(opts: {
  managed: boolean;
  managedStatus?: ManagedStatus;
  openElsewhere: boolean;
}): CardState {
  if (opts.managed) {
    if (opts.managedStatus === "running") return "running";
    if (opts.managedStatus === "awaitingPermission") return "awaiting";
    return "live";
  }
  if (opts.openElsewhere) return "open";
  return "idle";
}

/** Sort rank: lower = higher in list. */
function rankCard(
  session: SessionCard,
  managedIds?: Set<string>,
  statuses?: Record<string, ManagedStatus>,
): number {
  const id = session.id;
  const managed = managedIds?.has(id) ?? false;
  const st = statuses?.[id];
  if (st === "running") return 0;
  if (st === "awaitingPermission") return 1;
  if (managed) return 2;
  if (session.isActive) return 3;
  return 4;
}

function stateTitle(state: CardState): string {
  switch (state) {
    case "running":
      return "Agent is working on this task in PinkCode";
    case "open":
      return "Open in Grok Build — send a message here to connect";
    case "awaiting":
      return "Waiting for permission or input";
    case "live":
      return "Connected in PinkCode";
    case "idle":
      return "Idle";
  }
}
