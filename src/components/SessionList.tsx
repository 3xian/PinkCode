import { useMemo } from "react";
import type { SessionCard } from "../types";
import {
  contextPct,
  formatRelative,
  formatTokens,
  projectName,
  shortPath,
} from "../utils/format";
import logo from "../assets/logo.png";

interface Props {
  sessions: SessionCard[];
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  managedSessionIds?: Set<string>;
  /** Sessions with a managed agent (includes error; switch is on). */
  attachedSessionIds?: Set<string>;
  onAttach?: (sessionId: string) => void;
  onRequestStop?: (sessionId: string) => void;
  toggleBusy?: boolean;
  /** Session currently attaching — switch breathes until done. */
  attachingSessionId?: string | null;
  onNewTask?: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  query,
  onQuery,
  onSelect,
  managedSessionIds,
  attachedSessionIds,
  onAttach,
  onRequestStop,
  toggleBusy,
  attachingSessionId,
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

    // Attached (ACP / managed) sessions first; keep relative order within groups.
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
          <img src={logo} alt="" className="tasks-logo" />
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
          // error > ACP attached > Grok disk-active > idle.
          // Left bar + badge only (no status dot).
          const managed = managedSessionIds?.has(s.id) ?? false;
          const attached = attachedSessionIds?.has(s.id) ?? false;
          const isAttaching = attachingSessionId === s.id;
          const state = resolveCardState({
            status: s.status,
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
              <div
                className="card-top"
                title={isAttaching ? "Attaching agent…" : stateTitle(state)}
              >
                <span className="card-title" title={s.title}>
                  {s.title}
                </span>
                {(onAttach || onRequestStop) && (
                  <button
                    type="button"
                    className={`attach-switch${attached ? " on" : ""}${
                      isAttaching ? " pending" : ""
                    }`}
                    role="switch"
                    aria-checked={attached}
                    aria-busy={isAttaching || undefined}
                    aria-label={
                      isAttaching
                        ? "Attaching agent…"
                        : attached
                          ? "Detach agent (stop process)"
                          : "Attach agent"
                    }
                    title={
                      isAttaching
                        ? "Attaching…"
                        : attached
                          ? "On — click to stop agent"
                          : "Off — click to attach"
                    }
                    disabled={toggleBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (attached) {
                        onRequestStop?.(s.id);
                      } else {
                        onAttach?.(s.id);
                      }
                    }}
                  >
                    <span className="attach-switch-track" aria-hidden>
                      <span className="attach-switch-thumb" />
                    </span>
                  </button>
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
                <span>{s.toolCallCount} tools</span>
                {(s.agentLinesAdded > 0 || s.agentLinesRemoved > 0) && (
                  <span className="diff-stat">
                    +{s.agentLinesAdded}/−{s.agentLinesRemoved}
                  </span>
                )}
              </div>
              <div className="card-path muted" title={s.cwd}>
                {shortPath(s.cwd, 40)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Visual run-state for a task card (scheme A). */
type CardState = "error" | "live" | "disk-active" | "idle";

function resolveCardState(opts: {
  status: SessionCard["status"];
  managed: boolean;
  diskActive: boolean;
}): CardState {
  // 1) error always wins (overrides ACP / disk-active colors)
  if (opts.status === "error") return "error";
  // 2) MarsBuild ACP attached
  if (opts.managed) return "live";
  // 3) Grok lists session active on disk, not attached here
  if (opts.diskActive) return "disk-active";
  // 4) idle / unknown / anything else → neutral idle
  return "idle";
}

function stateTitle(state: CardState): string {
  switch (state) {
    case "error":
      return "Session error";
    case "live":
      return "Attached (ACP)";
    case "disk-active":
      return "Active in Grok (not attached) — flip switch to attach";
    case "idle":
      return "Idle";
  }
}
