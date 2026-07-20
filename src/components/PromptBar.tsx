import { useState } from "react";
import type { ManagedAgentInfo } from "../types";

interface Props {
  managed: ManagedAgentInfo | null;
  busy: boolean;
  onSend: (text: string) => void;
  onAttach: () => void;
  onStop: () => void;
  canAttach: boolean;
}

export function PromptBar({
  managed,
  busy,
  onSend,
  onAttach,
  onStop,
  canAttach,
}: Props) {
  const [text, setText] = useState("");

  const connected = managed && managed.status !== "stopped" && managed.status !== "error";
  const running = managed?.status === "running";
  const awaiting = managed?.status === "awaitingPermission";

  return (
    <div className="prompt-bar">
      <div className="prompt-meta">
        {connected ? (
          <span className={`pill ${awaiting ? "danger" : running ? "live" : "idle"}`}>
            {awaiting
              ? "◆ awaiting permission"
              : running
                ? "● running"
                : "● attached"}{" "}
            · {managed.handleId.slice(0, 8)}
            {managed.pid ? ` · pid ${managed.pid}` : ""}
            {managed.alwaysApprove
              ? " · process yolo (restart to re-gate)"
              : " · gated"}
          </span>
        ) : (
          <span className="pill idle">○ not attached</span>
        )}
        {managed?.lastError && (
          <span className="pill danger" title={managed.lastError}>
            error
          </span>
        )}
      </div>

      <div className="prompt-row">
        <textarea
          className="prompt-input"
          rows={2}
          placeholder={
            connected
              ? awaiting
                ? "Approve or deny the permission request above to continue…"
                : running
                  ? "Agent is working… you can queue another message after it finishes"
                  : "Send a follow-up prompt to this agent…"
              : "Attach or spawn an agent to send prompts"
          }
          value={text}
          disabled={!connected || running || awaiting || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (text.trim() && connected && !running && !awaiting) {
                onSend(text.trim());
                setText("");
              }
            }
          }}
        />
        <div className="prompt-actions">
          {!connected && canAttach && (
            <button className="btn" type="button" onClick={onAttach} disabled={busy}>
              Attach
            </button>
          )}
          {connected && (
            <button className="btn danger-btn" type="button" onClick={onStop} disabled={busy}>
              Stop
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={!connected || running || awaiting || busy || !text.trim()}
            onClick={() => {
              const trimmed = text.trim();
              if (!trimmed || !connected || running || awaiting || busy) return;
              onSend(trimmed);
              setText("");
            }}
          >
            {typeof navigator !== "undefined" &&
            /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
              ? "Send ⌘↵"
              : "Send Ctrl+↵"}
          </button>
        </div>
      </div>
    </div>
  );
}
