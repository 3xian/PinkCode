import { createPortal } from "react-dom";
import type { PendingPermission } from "../types";
import { shortPath } from "../utils/format";
import {
  previewContent,
  type ResolvePermissionFn,
} from "../utils/permissionPayload";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { UserQuestionModal } from "./UserQuestionModal";

interface Props {
  items: PendingPermission[];
  busyKey: string | null;
  onResolve: ResolvePermissionFn;
}

export function PermissionGate({ items, busyKey, onResolve }: Props) {
  if (items.length === 0) return null;

  const planItems = items.filter((i) => i.kind === "planApproval");
  const questionItems = items.filter((i) => i.kind === "userQuestion");
  const otherItems = items.filter(
    (i) => i.kind !== "planApproval" && i.kind !== "userQuestion",
  );

  return (
    <>
      {planItems.map((item) =>
        createPortal(
          <PlanApprovalModal
            key={item.requestKey}
            item={item}
            busy={busyKey === item.requestKey}
            onResolve={onResolve}
          />,
          document.body,
        ),
      )}
      {questionItems.map((item) =>
        createPortal(
          <UserQuestionModal
            key={item.requestKey}
            item={item}
            busy={busyKey === item.requestKey}
            onResolve={onResolve}
          />,
          document.body,
        ),
      )}
      {otherItems.length > 0 && (
        <div className="perm-gate">
          <div className="perm-gate-header">
            <span className="perm-pulse">●</span>
            <strong>Permission required</strong>
            <span className="muted">{otherItems.length} pending</span>
          </div>
          <div className="perm-list">
            {otherItems.map((item) => (
              <div
                key={item.requestKey}
                className={`perm-card risk-${item.risk}`}
              >
                <div className="perm-card-top">
                  <span className={`risk-badge risk-${item.risk}`}>
                    {item.risk}
                  </span>
                  <span className="perm-kind">{labelKind(item.kind)}</span>
                  <span className="perm-title">{item.title}</span>
                </div>
                {item.detail && (
                  <div className="perm-detail mono" title={item.detail}>
                    {formatDetail(item)}
                  </div>
                )}
                {item.kind === "fsWrite" && previewContent(item) && (
                  <pre className="perm-preview">{previewContent(item)}</pre>
                )}
                <div className="perm-actions">
                  {item.options.map((opt) => {
                    const isAllow =
                      opt.kind.includes("allow") ||
                      opt.optionId.includes("allow");
                    const isBusy = busyKey === item.requestKey;
                    return (
                      <button
                        key={opt.optionId}
                        type="button"
                        className={`btn ${isAllow ? "primary" : "danger-btn"}`}
                        disabled={isBusy}
                        onClick={() => onResolve(item, opt.optionId)}
                      >
                        {isBusy ? "…" : opt.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function labelKind(kind: PendingPermission["kind"]): string {
  switch (kind) {
    case "fsWrite":
      return "FILE WRITE";
    case "fsRead":
      return "FILE READ";
    case "toolPermission":
      return "TOOL";
    case "planApproval":
      return "PLAN";
    case "userQuestion":
      return "QUESTION";
    default:
      return "REQUEST";
  }
}

function formatDetail(item: PendingPermission): string {
  if (item.kind === "fsWrite" || item.kind === "fsRead") {
    return shortPath(item.detail, 72);
  }
  if (item.detail.length > 180) return item.detail.slice(0, 180) + "…";
  return item.detail;
}
