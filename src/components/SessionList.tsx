import type { SessionCard } from "../types";
import {
  contextPct,
  formatRelative,
  formatTokens,
  projectName,
  shortPath,
} from "../utils/format";

interface Props {
  sessions: SessionCard[];
  selectedId: string | null;
  filter: "all" | "active" | "idle";
  query: string;
  onFilter: (f: "all" | "active" | "idle") => void;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  managedSessionIds?: Set<string>;
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
    <aside className="session-list">
      <div className="panel-header">
        <h2>Tasks</h2>
        <span className="muted">{filtered.length}</span>
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
          const managed = managedSessionIds?.has(s.id) ?? false;
          return (
          <button
            key={s.id}
            className={`session-card ${selectedId === s.id ? "selected" : ""} ${s.isActive || managed ? "live" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="card-top">
              <StatusDot status={s.status} active={s.isActive || managed} />
              <span className="card-title" title={s.title}>
                {s.title}
              </span>
              {managed && <span className="managed-badge">ACP</span>}
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
    </aside>
  );
}

function StatusDot({
  status,
  active,
}: {
  status: SessionCard["status"];
  active: boolean;
}) {
  const cls =
    status === "error"
      ? "error"
      : active
        ? "active"
        : status === "idle"
          ? "idle"
          : "unknown";
  return <span className={`status-dot ${cls}`} title={status} />;
}
