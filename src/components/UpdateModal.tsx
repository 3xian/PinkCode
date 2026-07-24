import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "./Markdown";

interface Props {
  update: Update | null;
  onDismiss: () => void;
}

type Phase = "prompt" | "downloading" | "installing" | "done" | "error";

/**
 * In-app update prompt. Changelog is `update.body` from latest.json `notes`
 * (pipeline: prepare-notes → release body → rewrite-updater-json).
 * This component only displays — it does not invent or filter notes.
 */
export function UpdateModal({ update, onDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!update) return;
    setPhase("prompt");
    setDownloaded(0);
    setTotal(null);
    setError(null);
  }, [update?.version, update?.currentVersion]);

  const pct = useMemo(() => {
    if (!total || total <= 0) return null;
    return Math.min(100, Math.round((downloaded / total) * 100));
  }, [downloaded, total]);

  if (!update) return null;

  const notes = update.body?.trim() || null;
  const busy = phase === "downloading" || phase === "installing";

  async function handleInstall() {
    if (!update || busy) return;
    setError(null);
    setPhase("downloading");
    setDownloaded(0);
    setTotal(null);
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setTotal(event.data.contentLength ?? null);
            setDownloaded(0);
            break;
          case "Progress":
            setDownloaded((n) => n + event.data.chunkLength);
            break;
          case "Finished":
            setPhase("installing");
            break;
        }
      });
      setPhase("done");
      // Windows quits during install; on other platforms relaunch the new binary.
      await relaunch();
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onDismiss();
      }}
    >
      <div
        className="modal update-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-labelledby="update-modal-title"
      >
        <div className="modal-header">
          <h2 id="update-modal-title">Update available</h2>
        </div>

        <p className="update-version-line">
          <span className="muted">Current</span>{" "}
          <strong>v{update.currentVersion}</strong>
          <span className="muted"> → </span>
          <strong>v{update.version}</strong>
        </p>

        <div className="update-notes">
          <div className="muted small">
            What&apos;s new in v{update.version}
          </div>
          {notes ? (
            <div className="update-notes-body">
              <Markdown className="compact">{notes}</Markdown>
            </div>
          ) : (
            <p className="muted small update-notes-fallback">
              A newer PinkCode build is ready. Download and install without
              leaving the app.
            </p>
          )}
        </div>

        {(phase === "downloading" || phase === "installing") && (
          <div className="update-progress" aria-live="polite">
            <div className="update-progress-label muted small">
              {phase === "installing"
                ? "Installing…"
                : pct != null
                  ? `Downloading… ${pct}%`
                  : "Downloading…"}
            </div>
            <div className="update-progress-track">
              <div
                className="update-progress-fill"
                style={{
                  width:
                    phase === "installing"
                      ? "100%"
                      : pct != null
                        ? `${pct}%`
                        : "30%",
                }}
                data-indeterminate={
                  phase === "downloading" && pct == null ? "true" : undefined
                }
              />
            </div>
          </div>
        )}

        {error && (
          <p className="error-text small" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={onDismiss}
          >
            Later
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || phase === "done"}
            autoFocus
            onClick={() => void handleInstall()}
          >
            {phase === "downloading"
              ? "Downloading…"
              : phase === "installing"
                ? "Installing…"
                : phase === "error"
                  ? "Retry"
                  : "Download & install"}
          </button>
        </div>
      </div>
    </div>
  );
}
