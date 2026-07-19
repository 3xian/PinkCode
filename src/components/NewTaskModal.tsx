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

  // Component stays mounted while closed (returns null); re-sync defaults on open.
  useEffect(() => {
    if (open) {
      setCwd(defaultCwd);
      setPrompt("");
      setAlwaysApprove(false);
    }
  }, [open, defaultCwd]);

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
          <button className="btn ghost" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <p className="muted small">
          Spawns <code>grok agent stdio</code>, creates an ACP session, and
          streams updates live into MarsBuild. Risk policy (right panel) auto
          allows / denies / asks on gated ops.
        </p>

        <label className="field">
          <span>Working directory</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>Initial prompt</span>
          <textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
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
            disabled={busy || !cwd.trim() || !prompt.trim()}
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
