import type { LiveShellPayload } from "../types";

/** Inline shell command card used inside the Live timeline. */
export function ShellCard({ shell }: { shell: LiveShellPayload }) {
  return (
    <div className={`shell-card status-${shell.status || "unknown"}`}>
      <div className="shell-card-top">
        <span className={`shell-status ${shell.status}`}>
          {shell.status || "…"}
        </span>
        {shell.exitCode != null && (
          <span
            className={`exit-code ${shell.exitCode === 0 ? "ok" : "fail"}`}
          >
            exit {shell.exitCode}
          </span>
        )}
        {shell.description && (
          <span className="muted small">{shell.description}</span>
        )}
      </div>
      <div className="shell-cmd mono">$ {shell.command || "(command)"}</div>
      {shell.output ? (
        <pre className="shell-out">{shell.output}</pre>
      ) : (
        <div className="muted small shell-waiting">waiting for output…</div>
      )}
    </div>
  );
}
