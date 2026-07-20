import { useState } from "react";
import type { ManagedAgentInfo } from "../types";

interface Props {
  managed: ManagedAgentInfo | null;
  busy: boolean;
  onSend: (text: string) => void;
}

export function PromptBar({ managed, busy, onSend }: Props) {
  const [text, setText] = useState("");

  const connected = managed && managed.status !== "stopped" && managed.status !== "error";
  const running = managed?.status === "running";
  const awaiting = managed?.status === "awaitingPermission";
  const canSend = Boolean(
    connected && !running && !awaiting && !busy && text.trim(),
  );

  function sendIfReady() {
    const trimmed = text.trim();
    if (!trimmed || !connected || running || awaiting || busy) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="prompt-bar">
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
                  : "Enter to send · Ctrl+Enter for newline"
              : "Flip the task card switch to attach, then send prompts"
          }
          value={text}
          disabled={!connected || running || awaiting || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;

            // Ctrl/⌘+Enter → insert newline at cursor
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

            // Enter alone → send
            e.preventDefault();
            sendIfReady();
          }}
        />
        <div className="prompt-actions">
          <button
            className="btn primary"
            type="button"
            disabled={!canSend}
            title="Enter to send · Ctrl+Enter for newline"
            onClick={sendIfReady}
          >
            Send ↵
          </button>
          <span className="prompt-key-hint muted" title="Insert a line break">
            Ctrl+↵ newline
          </span>
        </div>
      </div>
    </div>
  );
}
