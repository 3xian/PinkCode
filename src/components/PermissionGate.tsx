import { createPortal } from "react-dom";
import type { PendingPermission } from "../types";
import type { ResolvePermissionFn } from "../utils/permissionPayload";
import { PermissionModal } from "./PermissionModal";
import { PlanApprovalModal } from "./PlanApprovalModal";
import { UserQuestionModal } from "./UserQuestionModal";

interface Props {
  items: PendingPermission[];
  busyKey: string | null;
  onResolve: ResolvePermissionFn;
}

/**
 * Host permission overlays. Plan / Ask / tool-FS all use the same draggable
 * dialog shell (portaled to document.body).
 */
export function PermissionGate({ items, busyKey, onResolve }: Props) {
  if (items.length === 0) return null;

  return (
    <>
      {items.map((item, index) => {
        const busy = busyKey === item.requestKey;
        if (item.kind === "planApproval") {
          return createPortal(
            <PlanApprovalModal
              key={item.requestKey}
              item={item}
              busy={busy}
              onResolve={onResolve}
            />,
            document.body,
          );
        }
        if (item.kind === "userQuestion") {
          return createPortal(
            <UserQuestionModal
              key={item.requestKey}
              item={item}
              busy={busy}
              onResolve={onResolve}
            />,
            document.body,
          );
        }
        return createPortal(
          <PermissionModal
            key={item.requestKey}
            item={item}
            busy={busy}
            onResolve={onResolve}
            keyboardCancelable={index === 0}
          />,
          document.body,
        );
      })}
    </>
  );
}
