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
  filter: "all" | "active" | "idle";
  query: string;
  onFilter: (f: "all" | "active" | "idle") => void;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  managedSessionIds?: Set<string>;
  onNewTask?: () => void;
}

export function SessionList({
  sessions,
  selectedId,
  filter,
  query,
  onFilter,
  onQuery,
  onSelect,
  managedSessionIds,
  onNewTask,
}: Props) {
  const filtered = sessions.filter((s) => {
    if (filter === "active" && !s.isActive) return false;
    if (filter === "idle" && s.isActive) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.headBranch ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="session-list">
      <div className="panel-header">
        <div className="panel-header-left">
          <img src={logo} alt="" className="tasks-logo" />
          <h2>Tasks</h2>
        </div>
        <div className="panel-header-right">
          <span className="muted">{filtered.length}</span>
          {onNewTask && (
            <button
              className="btn primary tasks-new-btn"
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
        <div className="segmented">
          {(["all", "active", "idle"] as const).map((f) => (
            <button
              key={f}
              className={filter === f ? "active" : ""}
              onClick={() => onFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="session-cards">
        {filtered.length === 0 && (
          <div className="empty-hint">No sessions match.</div>
        )}
        {filtered.map((s) => {
          // managed = MarsBuild has ACP attached/spawned for this session.
          // isActive = listed in Grok's active_sessions.json (process may exist,
          // but we are not necessarily attached). Green border is ACP-only so
          // users don't confuse disk-active with attached.
          const managed = managedSessionIds?.has(s.id) ?? false;
          const cardClass = [
            "session-card",
            selectedId === s.id ? "selected" : "",
            managed ? "live" : "",
            s.isActive && !managed ? "disk-active" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
          <button
            key={s.id}
            className={cardClass}
            onClick={() => onSelect(s.id)}
          >
            <div className="card-top">
              <StatusDot
                status={s.status}
                active={managed}
                diskActive={s.isActive && !managed}
              />
              <span className="card-title" title={s.title}>
                {s.title}
              </span>
              {managed && <span className="managed-badge">ACP</span>}
              {s.isActive && !managed && (
                <span className="disk-active-badge" title="Listed in Grok active_sessions — Attach to stream">
                  active
                </span>
              )}
            </div>
            <div className="card-meta">
              <span title={s.cwd}>{projectName(s.cwd)}</span>
              {s.headBranch && <span className="branch">⎇ {s.headBranch}</span>}
              <span className="time">{formatRelative(s.lastActiveAt ?? s.updatedAt)}</span>
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
          </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusDot({
  status,
  active,
  diskActive,
}: {
  status: SessionCard["status"];
  /** MarsBuild ACP attached */
  active: boolean;
  /** Grok marks session active on disk, not attached here */
  diskActive?: boolean;
}) {
  const cls =
    status === "error"
      ? "error"
      : active
        ? "active"
        : diskActive
          ? "disk-active"
          : status === "idle"
            ? "idle"
            : "unknown";
  const title = active
    ? "Attached (ACP)"
    : diskActive
      ? "Active in Grok (not attached)"
      : status;
  return <span className={`status-dot ${cls}`} title={title} />;
}
