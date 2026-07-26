import { useEffect, useState } from "react";
import type { PendingPermission } from "../types";
import { shortPath } from "../utils/format";
import {
  previewContent,
  type ResolvePermissionFn,
} from "../utils/permissionPayload";
import { useDraggableDialog } from "../hooks/useDraggableDialog";

interface Props {
  item: PendingPermission;
  busy: boolean;
  onResolve: ResolvePermissionFn;
  keyboardCancelable?: boolean;
}

function labelKind(kind: PendingPermission["kind"]): string {
  switch (kind) {
    case "fsWrite":
      return "File write";
    case "fsRead":
      return "File read";
    case "toolPermission":
      return "Tool";
    case "planApproval":
      return "Plan";
    case "userQuestion":
      return "Question";
    default:
      return "Request";
  }
}

function formatDetail(item: PendingPermission): string {
  if (item.kind === "fsWrite" || item.kind === "fsRead") {
    return shortPath(item.detail, 96);
  }
  return item.detail;
}

/** Tool / FS permission prompt — draggable, same shell as Plan / Ask. */
export function PermissionModal({
  item,
  busy,
  onResolve,
  keyboardCancelable = true,
}: Props) {
  const [feedback, setFeedback] = useState("");
  const {
    dialogRef,
    pos,
    dialogStyle,
    onDragPointerDown,
    onDragPointerMove,
    onDragPointerUp,
  } = useDraggableDialog();

  const risk = item.risk || "medium";
  const preview = item.kind === "fsWrite" ? previewContent(item) : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const cancelShortcut =
        event.key === "Escape" ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c");
      if (!cancelShortcut || busy || !keyboardCancelable) return;
      // Preserve normal copy when the user has selected feedback/detail text.
      if (event.key.toLowerCase() === "c") {
        const target = event.target;
        const inputHasSelection =
          (target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement) &&
          target.selectionStart !== target.selectionEnd;
        if (inputHasSelection || window.getSelection()?.toString()) return;
      }
      event.preventDefault();
      onResolve(item, "cancelled");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, item, keyboardCancelable, onResolve]);

  return (
    <div className="drag-dialog-overlay" role="presentation">
      <div
        ref={dialogRef}
        className={`drag-dialog permission-dialog risk-${risk}${
          pos ? " is-positioned" : ""
        }`}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`permission-title-${item.requestKey}`}
      >
        <div
          className={`drag-dialog-handle permission-drag-handle risk-${risk}`}
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <div className="drag-dialog-header">
            <span className="plan-approval-grip" aria-hidden title="Drag">
              ⋮⋮
            </span>
            <span className={`permission-mark risk-${risk}`} aria-hidden>
              ●
            </span>
            <strong id={`permission-title-${item.requestKey}`}>
              Permission required
            </strong>
            <span className={`risk-badge risk-${risk}`}>{risk}</span>
            <span className="muted">{labelKind(item.kind)}</span>
          </div>
          {item.title ? (
            <div className="permission-subtitle" title={item.title}>
              {item.title}
            </div>
          ) : null}
        </div>

        <div className="drag-dialog-body permission-body">
          {item.detail ? (
            <div className="perm-detail mono" title={item.detail}>
              {formatDetail(item)}
            </div>
          ) : (
            <p className="muted plan-approval-empty">
              The agent needs approval to continue.
            </p>
          )}
          {preview ? <pre className="perm-preview">{preview}</pre> : null}
        </div>

        <div className="drag-dialog-footer">
          {item.kind === "toolPermission" ? (
            <label className="plan-approval-comments field">
              <span>Rejection feedback (optional)</span>
              <textarea
                rows={2}
                value={feedback}
                disabled={busy}
                placeholder="Tell Grok how to proceed instead…"
                onChange={(event) => setFeedback(event.target.value)}
              />
            </label>
          ) : null}
          <div className="perm-actions drag-dialog-actions">
            {item.options.map((opt) => {
              const isAllow =
                opt.kind.includes("allow") || opt.optionId.includes("allow");
              return (
                <button
                  key={opt.optionId}
                  type="button"
                  className={`btn ${isAllow ? "primary" : "danger-btn"}`}
                  disabled={busy}
                  onClick={() =>
                    onResolve(
                      item,
                      opt.optionId,
                      isAllow ? undefined : feedback,
                    )
                  }
                >
                  {busy ? "…" : opt.name}
                </button>
              );
            })}
            {item.kind === "toolPermission" ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onResolve(item, "cancelled")}
                title="Cancel the current turn (Esc / Cmd+C)"
              >
                Cancel turn
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
