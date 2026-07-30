import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "../types";
import { shortPath } from "../utils/format";
import {
  planContentOf,
  planPathOf,
  type ResolvePermissionFn,
} from "../utils/permissionPayload";
import { writeClipboard } from "../utils/clipboard";
import { useDraggableDialog } from "../hooks/useDraggableDialog";
import { Markdown } from "./Markdown";

interface Props {
  item: PendingPermission;
  busy: boolean;
  onResolve: ResolvePermissionFn;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Full-app plan approval dialog — draggable, clamped to the window. */
export function PlanApprovalModal({ item, busy, onResolve }: Props) {
  const [comments, setComments] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const planMarkdown = useMemo(() => planContentOf(item), [item]);
  const planPath = useMemo(() => planPathOf(item), [item]);
  const {
    dialogRef,
    pos,
    dialogStyle,
    onDragPointerDown,
    onDragPointerMove,
    onDragPointerUp,
  } = useDraggableDialog();

  const copyPlan = useCallback(async () => {
    const text = planMarkdown.trim();
    if (!text) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [planMarkdown]);

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  // Align with Grok TUI: y copy · a approve · s request · q quit.
  // Escape is intentionally not bound (TUI uses q; PermissionModal keeps Escape).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "y") {
        event.preventDefault();
        void copyPlan();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        onResolve(item, "approve", comments);
        return;
      }
      if (key === "s") {
        event.preventDefault();
        onResolve(item, "request-changes", comments);
        return;
      }
      if (key === "q") {
        event.preventDefault();
        onResolve(item, "abandon", comments);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, comments, copyPlan, item, onResolve]);

  const canCopy = Boolean(planMarkdown.trim());

  return (
    <div className="drag-dialog-overlay" role="presentation">
      <div
        ref={dialogRef}
        className={`drag-dialog plan-approval-dialog${pos ? " is-positioned" : ""}`}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`plan-approval-title-${item.requestKey}`}
      >
        <div
          className="drag-dialog-handle plan-approval-drag-handle"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <div className="drag-dialog-header">
            <span className="plan-approval-grip" aria-hidden title="Drag">
              ⋮⋮
            </span>
            <span className="plan-approval-mark">◆</span>
            <strong id={`plan-approval-title-${item.requestKey}`}>
              Plan approval
            </strong>
            <span className="muted">Grok plan mode · review before implement</span>
          </div>
          {planPath && (
            <div className="plan-approval-path mono" title={planPath}>
              {shortPath(planPath, 80)}
            </div>
          )}
        </div>

        <div className="drag-dialog-body">
          {planMarkdown.trim() ? (
            <Markdown className="compact">{planMarkdown}</Markdown>
          ) : (
            <p className="muted plan-approval-empty">
              No plan written yet. You can still approve to start implementing,
              or request changes so the agent keeps planning.
            </p>
          )}
        </div>

        <div className="drag-dialog-footer">
          <label className="plan-approval-comments field">
            <span>Comments (optional)</span>
            <textarea
              rows={2}
              value={comments}
              disabled={busy}
              placeholder="With Approve: review notes after approval. With Request changes: revise feedback…"
              onChange={(e) => setComments(e.target.value)}
            />
          </label>
          <p className="plan-approval-hints muted">
            y copy · a approve · s request changes · q quit
          </p>
          <div className="perm-actions drag-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !canCopy}
              onClick={() => void copyPlan()}
              title="Copy full plan (y)"
            >
              {copied ? "Copied" : "Copy plan"}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => onResolve(item, "approve", comments)}
              title="Approve and start building (a)"
            >
              {busy ? "…" : "Approve"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onResolve(item, "request-changes", comments)}
              title="Keep plan mode; send revision notes (s)"
            >
              Request changes
            </button>
            <button
              type="button"
              className="btn danger-btn"
              disabled={busy}
              onClick={() => onResolve(item, "abandon", comments)}
              title="Quit plan mode without implementing (q)"
            >
              Quit plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
