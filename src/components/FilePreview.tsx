import { useEffect, useState } from "react";
import { openProjectPath, readProjectFile } from "../api";
import logo from "../assets/logo.png";
import type { FilePreview as FilePreviewData, FilePreviewKind } from "../types";
import { writeClipboard } from "../utils/clipboard";
import { shortPath } from "../utils/format";
import { pathsEqual } from "../utils/paths";

interface Props {
  root: string | null;
  /** Absolute path under project root (or null when empty). */
  path: string | null;
  /**
   * Active Grok session id — enables preview of session assets
   * (e.g. generated `images/1.jpg` under `~/.grok/sessions/…`).
   */
  sessionId?: string | null;
  onClose: () => void;
  /**
   * After a successful read, adopt the backend display path when it differs
   * (canonicalize / `\\?\` strip) so tree/git selection stays in sync.
   */
  onResolvedPath?: (path: string) => void;
}

export function FilePreview({
  root,
  path,
  sessionId = null,
  onClose,
  onResolvedPath,
}: Props) {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (!root || !path) {
      setData(null);
      setError(null);
      setLoading(false);
      setImgError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setImgError(false);
    void (async () => {
      try {
        const preview = await readProjectFile(root, path, sessionId);
        if (cancelled) return;
        setData(preview);
        setError(null);
        // Align selection with backend path identity (junctions, casing, prefixes).
        if (onResolvedPath && !pathsEqual(path, preview.path)) {
          onResolvedPath(preview.path);
        }
      } catch (e) {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, path, sessionId, onResolvedPath]);

  if (!root || !path) {
    return (
      <div className="workspace-section file-preview-section">
        <div className="panel-header file-preview-header">
          <h2 className="file-preview-title">Preview</h2>
        </div>
        <div className="file-preview-empty" aria-hidden={!root}>
          <img src={logo} alt="" className="file-preview-logo" />
          {!root ? (
            <p className="muted small">Select a session to browse files.</p>
          ) : (
            <p className="muted small">Click a file to preview it here.</p>
          )}
        </div>
      </div>
    );
  }

  const title = data?.path ?? path;
  const kind: FilePreviewKind = data?.kind ?? "text";
  const isImage = kind === "image";
  const imageSrc =
    isImage && data?.content && data.mimeType
      ? `data:${data.mimeType};base64,${data.content}`
      : null;

  async function copyPath() {
    try {
      await writeClipboard(title);
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Copy failed: ${e.message}`
          : "Copy failed: clipboard unavailable",
      );
    }
  }

  return (
    <div className="workspace-section file-preview-section">
      <div className="panel-header file-preview-header">
        <h2 className="file-preview-title" title={title}>
          <span className="file-preview-path">{shortPath(title, 40)}</span>
          {data ? (
            <span className="file-preview-meta mono">
              {formatBytes(data.size)}
              {data.truncated ? " truncated" : ""}
              {isImage ? " image" : ""}
            </span>
          ) : null}
        </h2>
        <div className="file-preview-actions">
          <button
            type="button"
            className="file-preview-btn"
            title="Copy full path"
            onClick={() => void copyPath()}
          >
            Copy path
          </button>
          <button
            type="button"
            className="file-preview-btn"
            title="Open in system"
            disabled={!root}
            onClick={() => {
              if (!root || !path) return;
              void openProjectPath(root, path, sessionId).catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="file-preview-btn file-preview-btn-close"
            title="Close preview"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>
      {error && <div className="empty-hint error-text small">{error}</div>}
      {loading && !data && !error ? (
        <div className="empty-hint small">Loading…</div>
      ) : isImage && data?.truncated && !data.content ? (
        <div className="empty-hint small">
          Image too large ({formatBytes(data.size)}) — use Open to view
          externally.
        </div>
      ) : isImage && imageSrc && !imgError ? (
        <div className="file-preview-image-wrap">
          <img
            className="file-preview-image"
            src={imageSrc}
            alt={title}
            onError={() => setImgError(true)}
          />
        </div>
      ) : isImage && imgError ? (
        <div className="empty-hint small">
          Could not render image — use Open to view externally.
        </div>
      ) : kind === "binary" ? (
        <div className="empty-hint small">
          Binary file ({formatBytes(data?.size ?? 0)}) — use Open to view
          externally.
        </div>
      ) : data ? (
        <pre className="file-preview-body mono">{data.content}</pre>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
