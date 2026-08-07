/**
 * Lifecycle card settlement for managed ACP handles and kill/cancel RPC outcomes.
 *
 * One map walk + card patch path; call sites only supply a match + terminal fields.
 */

import type {
  BgTaskLifecycleStatus,
  SubagentLifecycleStatus,
  TimelineItem,
} from "../types";
import {
  formatBgTaskDetail,
  formatBgTaskTitle,
  formatSubagentDetail,
  formatSubagentTitle,
  normalizeSubagentStatus,
} from "../utils/subagentTasks";

/** Terminal decision after parsing `x.ai/subagent/cancel`. */
export type CancelSubagentDecision = {
  status: SubagentLifecycleStatus;
  error?: string | null;
  /** Rewrite even when the card is already terminal (already_finished / not_found). */
  force: boolean;
};

/** Terminal decision after parsing `x.ai/task/kill`. */
export type KillTaskDecision = {
  status: BgTaskLifecycleStatus;
  error?: string | null;
  force: boolean;
  taskId?: string;
};

type SubagentPatch = {
  kind: "subagent";
  match: (item: TimelineItem) => boolean;
  status: SubagentLifecycleStatus;
  error?: string | null;
  force?: boolean;
};

type TaskPatch = {
  kind: "task";
  match: (item: TimelineItem) => boolean;
  status: BgTaskLifecycleStatus;
  error?: string | null;
  force?: boolean;
};

type LifecyclePatch = SubagentPatch | TaskPatch;

function patchSubagentCard(
  item: TimelineItem,
  status: SubagentLifecycleStatus,
  error?: string | null,
): TimelineItem {
  if (item.kind !== "subagent" || !item.subagent) return item;
  const subagent = {
    ...item.subagent,
    status,
    activityLabel: null,
    error: error === undefined ? item.subagent.error ?? null : error,
  };
  return {
    ...item,
    subagent,
    toolStatus: subagent.status,
    title: formatSubagentTitle(subagent),
    detail: formatSubagentDetail(subagent),
  };
}

function patchTaskCard(
  item: TimelineItem,
  status: BgTaskLifecycleStatus,
  error?: string | null,
): TimelineItem {
  if (item.kind !== "task" || !item.task) return item;
  const task = {
    ...item.task,
    status,
    error: error === undefined ? item.task.error ?? null : error,
  };
  return {
    ...item,
    task,
    toolStatus: task.status,
    title: formatBgTaskTitle(task),
    detail: formatBgTaskDetail(task),
  };
}

function applyPatchToItem(
  item: TimelineItem,
  patch: LifecyclePatch,
): TimelineItem | null {
  if (patch.kind === "subagent") {
    if (item.kind !== "subagent" || !item.subagent) return null;
    if (!patch.match(item)) return null;
    if (!patch.force && item.subagent.status !== "running") return null;
    return patchSubagentCard(item, patch.status, patch.error);
  }
  if (item.kind !== "task" || !item.task) return null;
  if (!patch.match(item)) return null;
  if (!patch.force && item.task.status !== "running") return null;
  return patchTaskCard(item, patch.status, patch.error);
}

/** Apply one lifecycle patch across every session list owned by `handleId`. */
export function mapLifecycleCards(
  map: Map<string, TimelineItem[]>,
  handleId: string,
  patch: LifecyclePatch,
): Map<string, TimelineItem[]> {
  let changed = false;
  const next = new Map(map);
  for (const [key, list] of map) {
    let listChanged = false;
    const settled = list.map((item) => {
      if (item.handleId !== handleId) return item;
      const patched = applyPatchToItem(item, patch);
      if (!patched || patched === item) return item;
      listChanged = true;
      return patched;
    });
    if (listChanged) {
      next.set(key, settled);
      changed = true;
    }
  }
  return changed ? next : map;
}

/** Settle running lifecycle cards when their managed ACP handle closes. */
export function settleLifecycleItems(
  map: Map<string, TimelineItem[]>,
  handleId: string,
): Map<string, TimelineItem[]> {
  const afterSubs = mapLifecycleCards(map, handleId, {
    kind: "subagent",
    match: (item) => item.subagent?.status === "running",
    status: "finished",
  });
  return mapLifecycleCards(afterSubs, handleId, {
    kind: "task",
    match: (item) => item.task?.status === "running",
    status: "stopped",
  });
}

function outcomeKind(raw: unknown): string {
  if (typeof raw === "string") return raw.trim().toLowerCase();
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "kind" in raw) {
    const kind = raw.kind;
    if (typeof kind === "string") return kind.trim().toLowerCase();
  }
  return "";
}

function outcomeStatus(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "status" in raw) {
    const status = raw.status;
    return typeof status === "string" && status.trim() ? status.trim() : undefined;
  }
  return undefined;
}

/**
 * Parse `x.ai/subagent/cancel` payload into a host decision.
 * Wire: outcome.kind = cancelled | already_finished | not_found (+ legacy `cancelled` bool).
 */
export function parseCancelSubagentDecision(
  result: { cancelled?: boolean; outcome?: unknown } | null | undefined,
): CancelSubagentDecision {
  const kind = outcomeKind(result?.outcome);
  if (kind === "already_finished") {
    return {
      status: normalizeSubagentStatus(outcomeStatus(result?.outcome), "finished"),
      force: true,
    };
  }
  if (kind === "not_found") {
    return {
      status: "cancelled",
      error: "subagent not found",
      force: true,
    };
  }
  if (kind === "cancelled" || result?.cancelled === true || !kind) {
    return { status: "cancelled", force: false };
  }
  // Older shell, cancelled=false, no typed outcome → already terminal.
  return { status: "finished", force: false };
}

/**
 * Parse `x.ai/task/kill` payload into a host decision.
 * Wire outcome: killed | already_exited | not_found (string or {kind}).
 */
export function parseKillTaskDecision(
  result: { outcome?: unknown; taskId?: string | null } | null | undefined,
  fallbackTaskId: string,
): KillTaskDecision {
  const taskId =
    typeof result?.taskId === "string" && result.taskId.trim()
      ? result.taskId.trim()
      : fallbackTaskId.trim();
  const kind = outcomeKind(result?.outcome);
  if (kind === "already_exited") {
    return {
      status: "done",
      force: true,
      taskId,
    };
  }
  if (kind === "not_found") {
    return {
      status: "stopped",
      error: "task not found",
      force: true,
      taskId,
    };
  }
  return { status: "stopped", force: false, taskId };
}

export function applyCancelSubagentDecision(
  map: Map<string, TimelineItem[]>,
  handleId: string,
  subagentId: string,
  decision: CancelSubagentDecision,
): Map<string, TimelineItem[]> {
  const id = subagentId.trim();
  if (!id) return map;
  return mapLifecycleCards(map, handleId, {
    kind: "subagent",
    match: (item) =>
      item.subagent?.subagentId === id || item.subagent?.childSessionId === id,
    status: decision.status,
    error: decision.error,
    force: decision.force,
  });
}

export function applyKillTaskDecision(
  map: Map<string, TimelineItem[]>,
  handleId: string,
  decision: KillTaskDecision,
): Map<string, TimelineItem[]> {
  const id = (decision.taskId ?? "").trim();
  if (!id) return map;
  return mapLifecycleCards(map, handleId, {
    kind: "task",
    match: (item) => item.task?.taskId === id,
    status: decision.status,
    error: decision.error,
    force: decision.force,
  });
}

/** Convenience: parse wire result then settle (tests / thin call sites). */
export function applyCancelSubagentOutcome(
  map: Map<string, TimelineItem[]>,
  handleId: string,
  subagentId: string,
  result: { cancelled?: boolean; outcome?: unknown } | null | undefined,
): Map<string, TimelineItem[]> {
  return applyCancelSubagentDecision(
    map,
    handleId,
    subagentId,
    parseCancelSubagentDecision(result),
  );
}

export function applyKillTaskOutcome(
  map: Map<string, TimelineItem[]>,
  handleId: string,
  taskId: string,
  result: { outcome?: unknown; taskId?: string | null } | null | undefined,
): Map<string, TimelineItem[]> {
  return applyKillTaskDecision(
    map,
    handleId,
    parseKillTaskDecision(result, taskId),
  );
}
