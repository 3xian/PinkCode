import { useMemo, type CSSProperties } from "react";
import type { ManagedStatus, SessionCard } from "../types";
import {
  contextPct,
  formatRelative,
  formatTokens,
  projectName,
} from "../utils/format";
import {
  isPinkcodeAttached,
  rankManagedCard,
  resolveCardState,
  stateLabel,
  stateTitle,
} from "../utils/managedChrome";

interface Props {
  sessions: SessionCard[];
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  /**
   * sessionId → PinkCode managed status (any non-terminal attach state,
   * including `starting`). Sort + card chrome derive from this alone.
   */
  managedStatuses?: Record<string, ManagedStatus>;
  onNewTask?: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  query,
  onQuery,
  onSelect,
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
      const ar = rankManagedCard(managedStatuses?.[a.id], a.isActive);
      const br = rankManagedCard(managedStatuses?.[b.id], b.isActive);
      return ar - br;
    });
    return list;
  }, [sessions, query, managedStatuses]);

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
          const managedStatus = managedStatuses?.[s.id];
          const attached = isPinkcodeAttached(managedStatus);
          // Live PID in active_sessions.json, not attached here — "open", not mid-turn.
          const openElsewhere = s.isActive && !attached;
          const state = resolveCardState(managedStatus, openElsewhere);
          const cardClass = [
            "session-card",
            selectedId === s.id ? "selected" : "",
            `state-${state}`,
          ]
            .filter(Boolean)
            .join(" ");
          const ctxPct = contextPct(
            s.contextTokensUsed,
            s.contextWindowTokens,
          );
          const ctxLevel =
            ctxPct >= 90 ? "high" : ctxPct >= 70 ? "mid" : "ok";
          const ctxStyle = {
            "--ctx-pct": `${Math.min(100, Math.max(0, ctxPct))}%`,
          } as CSSProperties;
          return (
            <div
              key={s.id}
              className={cardClass}
              onClick={() => onSelect(s.id)}
              title={stateTitle(state)}
              aria-busy={
                state === "running" || state === "starting"
                  ? true
                  : undefined
              }
            >
              {state !== "idle" && (
                <div className="card-status">
                  <span className="card-status-text">{stateLabel(state)}</span>
                </div>
              )}
              <div className="card-body">
                <div className="card-title" title={s.title}>
                  {s.title}
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
                  <span
                    className="card-chip"
                    title={
                      !s.tokenUsageAvailable
                        ? "Completed-turn token usage is not available for this session"
                        : s.tokenUsageIncomplete
                          ? "Approximate completed-turn total tokens; one or more turns may be incomplete"
                          : "Completed-turn total tokens (input + output, including cached reads)"
                    }
                  >
                    {!s.tokenUsageAvailable
                      ? "? tok"
                      : `${s.tokenUsageIncomplete ? "≈" : ""}${formatTokens(s.totalTokens)} tok`}
                  </span>
                  <span
                    className={`card-chip card-chip-ctx level-${ctxLevel}`}
                    style={ctxStyle}
                    title={`Context ${ctxPct}% (${formatTokens(s.contextTokensUsed, { decimals: false })} / ${formatTokens(s.contextWindowTokens, { decimals: false })})`}
                  >
                    {ctxPct}% ctx
                  </span>
                  {(s.agentLinesAdded > 0 || s.agentLinesRemoved > 0) && (
                    <span className="card-chip diff-stat">
                      +{s.agentLinesAdded}/−{s.agentLinesRemoved}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


