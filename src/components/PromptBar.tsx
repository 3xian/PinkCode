import { useState } from "react";
import type { ManagedAgentInfo, PermissionMode } from "../types";
import { PERMISSION_MODE_OPTIONS } from "../types";

interface Props {
  managed: ManagedAgentInfo | null;
  busy: boolean;
  /** Effective mode for the current task (persisted or live agent). */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSend: (text: string) => void;
}

export function PromptBar({
  managed,
  busy,
  permissionMode,
  onPermissionModeChange,
  onSend,
}: Props) {
  const [text, setText] = useState("");

  const connected =
    managed && managed.status !== "stopped" && managed.status !== "error";
  const running = managed?.status === "running";
  const awaiting = managed?.status === "awaitingPermission";
  const canSend = Boolean(
    connected && !running && !awaiting && !busy && text.trim(),
  );

  const modeHint =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode)?.hint ?? "";

  function sendIfReady() {
    const trimmed = text.trim();
    if (!trimmed || !connected || running || awaiting || busy) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="prompt-bar">
      <div className="prompt-composer">
        <textarea
          className="prompt-input"
          rows={2}
          placeholder={
            connected
              ? awaiting
                ? "Approve or deny the permission request above to continue…"
                : running
                  ? "Agent is working… you can queue another message after it finishes"
                  : "Message the agent… Enter to send · Ctrl+Enter for newline"
              : "Flip the task card switch to attach, then send prompts"
          }
          value={text}
          disabled={!connected || running || awaiting || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;

            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? text.length;
              const end = el.selectionEnd ?? text.length;
              const next = `${text.slice(0, start)}\n${text.slice(end)}`;
              setText(next);
              requestAnimationFrame(() => {
                const pos = start + 1;
                el.selectionStart = pos;
                el.selectionEnd = pos;
              });
              return;
            }

            e.preventDefault();
            sendIfReady();
          }}
        />
        <div className="prompt-toolbar">
          <label className="prompt-perm" title={modeHint}>
            <span className="prompt-perm-label">Permissions</span>
            <select
              className="prompt-perm-select"
              value={permissionMode}
              disabled={busy}
              onChange={(e) =>
                onPermissionModeChange(e.target.value as PermissionMode)
              }
              aria-label="Permission mode"
            >
              {PERMISSION_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn primary prompt-send"
            type="button"
            disabled={!canSend}
            title="Enter to send · Ctrl+Enter for newline"
            onClick={sendIfReady}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
