import type { ShellEntry } from "../types";

interface Props {
  entries: ShellEntry[];
}

export function ShellPanel({ entries }: Props) {
  if (entries.length === 0) {
    return (
      <div className="empty-hint">
        No shell commands yet. When the agent runs{" "}
        <code>run_terminal_command</code>, live stdout appears here.
      </div>
    );
  }

  // newest first
  const ordered = [...entries].reverse();

  return (
    <div className="shell-panel">
      {ordered.map((e) => (
        <div key={e.id} className={`shell-card status-${e.status || "unknown"}`}>
          <div className="shell-card-top">
            <span className={`shell-status ${e.status}`}>{e.status || "…"}</span>
            {e.exitCode != null && (
              <span className={`exit-code ${e.exitCode === 0 ? "ok" : "fail"}`}>
                exit {e.exitCode}
              </span>
            )}
            {e.description && (
              <span className="muted small">{e.description}</span>
            )}
          </div>
          <div className="shell-cmd mono">$ {e.command || "(command)"}</div>
          {e.output ? (
            <pre className="shell-out">{e.output}</pre>
          ) : (
            <div className="muted small shell-waiting">waiting for output…</div>
          )}
        </div>
      ))}
    </div>
  );
}
