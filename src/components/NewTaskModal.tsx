import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { SessionMode } from "../types";
import { SESSION_MODE_OPTIONS } from "../types";

interface Props {
  open: boolean;
  defaultCwd: string;
  busy: boolean;
  /** Seed for the Mode selector when the modal opens. */
  defaultSessionMode: SessionMode;
  onClose: () => void;
  onSubmit: (opts: {
    cwd: string;
    prompt: string;
    sessionMode: SessionMode;
  }) => void;
}

export function NewTaskModal({
  open,
  defaultCwd,
  busy,
  defaultSessionMode,
  onClose,
  onSubmit,
}: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [prompt, setPrompt] = useState("");
  const [sessionMode, setSessionMode] =
    useState<SessionMode>(defaultSessionMode);
  const [picking, setPicking] = useState(false);

  // Component stays mounted while closed (returns null); re-sync defaults on open.
  useEffect(() => {
    if (open) {
      setCwd(defaultCwd);
      setPrompt("");
      setSessionMode(defaultSessionMode);
      setPicking(false);
    }
  }, [open, defaultCwd, defaultSessionMode]);

  async function pickDirectory() {
    if (busy || picking) return;
    setPicking(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: cwd.trim() || undefined,
        title: "Choose working directory",
      });
      if (typeof selected === "string" && selected.length > 0) {
        setCwd(selected);
      }
    } catch (e) {
      console.error("Directory picker failed:", e);
    } finally {
      setPicking(false);
    }
  }

  if (!open) return null;

  const modeMeta =
    SESSION_MODE_OPTIONS.find((o) => o.value === sessionMode) ??
    SESSION_MODE_OPTIONS[0]!;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="modal-header">
          <h2>New agent task</h2>
        </div>
        <p className="muted small">
          Spawns <code>grok agent stdio</code>, creates an ACP session, and
          streams updates live. Mode matches the composer chip (shift+tab):
          Normal → Plan → Auto → Always approve.
        </p>

        <label className="field">
          <span>Working directory</span>
          <div className="field-row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="Browse folder or paste a path…"
              disabled={busy || picking}
            />
            <button
              className="btn icon-btn"
              type="button"
              onClick={() => void pickDirectory()}
              disabled={busy || picking}
              title="Browse folder"
              aria-label={picking ? "Opening folder picker…" : "Browse folder"}
            >
              {picking ? (
                <span aria-hidden>…</span>
              ) : (
                <svg
                  className="icon"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.1c.3 0 .58.12.79.33L8 4.5h5A1.5 1.5 0 0 1 14.5 6v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V4.5Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </label>

        <label className="field">
          <span>
            Initial prompt{" "}
            <span className="muted" style={{ fontWeight: 400 }}>
              (optional)
            </span>
          </span>
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do? Leave empty to start without a prompt."
            disabled={busy}
          />
        </label>

        <label className="field" title={modeMeta.hint}>
          <span>Mode</span>
          <select
            className="field-select"
            value={sessionMode}
            disabled={busy}
            onChange={(e) => setSessionMode(e.target.value as SessionMode)}
            aria-label="Mode for this task"
          >
            {SESSION_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} title={o.hint}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="field-hint muted small">{modeMeta.hint}</span>
          {sessionMode === "plan" && prompt.trim() && !prompt.trim().startsWith("/") ? (
            <span className="field-hint muted small">
              Initial prompt will be sent as <code>/plan …</code>
            </span>
          ) : null}
        </label>

        <div className="modal-actions">
          <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !cwd.trim()}
            onClick={() =>
              onSubmit({
                cwd: cwd.trim(),
                prompt: prompt.trim(),
                sessionMode,
              })
            }
          >
            {busy ? "Starting…" : "Spawn agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
