import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  defaultCwd: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (opts: {
    cwd: string;
    prompt: string;
    alwaysApprove: boolean;
  }) => void;
}

export function NewTaskModal({
  open,
  defaultCwd,
  busy,
  onClose,
  onSubmit,
}: Props) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [prompt, setPrompt] = useState("");
  const [alwaysApprove, setAlwaysApprove] = useState(false);
  const [picking, setPicking] = useState(false);

  // Component stays mounted while closed (returns null); re-sync defaults on open.
  useEffect(() => {
    if (open) {
      setCwd(defaultCwd);
      setPrompt("");
      setAlwaysApprove(false);
      setPicking(false);
    }
  }, [open, defaultCwd]);

  async function pickDirectory() {
    if (busy || picking) return;
    setPicking(true);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        // Prefer current path as starting location when it looks absolute.
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
          streams updates live into MarsBuild. Risk policy (right panel) auto
          allows / denies / asks on gated ops.
        </p>

        <label className="field">
          <span>Working directory</span>
          <div className="field-row">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="Click Browse or paste a path…"
              disabled={busy || picking}
            />
            <button
              className="btn"
              type="button"
              onClick={() => void pickDirectory()}
              disabled={busy || picking}
            >
              {picking ? "…" : "Browse"}
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

        <label className="check">
          <input
            type="checkbox"
            checked={alwaysApprove}
            onChange={(e) => setAlwaysApprove(e.target.checked)}
            disabled={busy}
          />
          <span>
            Always approve{" "}
            <span className="muted">
              (off = MarsBuild permission gate for file writes & tool prompts)
            </span>
          </span>
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
                alwaysApprove,
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
