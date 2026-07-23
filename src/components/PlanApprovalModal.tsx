import { useMemo, useState } from "react";
import type { PendingPermission } from "../types";
import { shortPath } from "../utils/format";
import {
  planContentOf,
  planPathOf,
  type ResolvePermissionFn,
} from "../utils/permissionPayload";
import { useDraggableDialog } from "../hooks/useDraggableDialog";
import { Markdown } from "./Markdown";

interface Props {
  item: PendingPermission;
  busy: boolean;
  onResolve: ResolvePermissionFn;
}

/** Full-app plan approval dialog — draggable, clamped to the window. */
export function PlanApprovalModal({ item, busy, onResolve }: Props) {
  const [comments, setComments] = useState("");
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
          <div className="perm-actions drag-dialog-actions">
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
