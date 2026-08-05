import type { ManagedAgentInfo } from "../types";

/** Agent is attached and can own the live ACP tail / timeline buffers. */
export function isLiveManagedStatus(
  status: ManagedAgentInfo["status"],
): boolean {
  return (
    status === "ready" ||
    status === "running" ||
    status === "awaitingPermission"
  );
}
