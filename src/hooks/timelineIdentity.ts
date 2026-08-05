import type { TimelineItem } from "../types";
import { lifecycleMirrorKey } from "../utils/subagentTasks";

/**
 * Drop map entries whose keys are not in `keepKeys`.
 * Returns the previous reference when nothing was removed.
 */
export function pruneMapByKeys<T>(
  previous: Map<string, T>,
  keepKeys: ReadonlySet<string>,
): Map<string, T> {
  if (previous.size === 0) return previous;
  let changed = false;
  const next = new Map<string, T>();
  for (const [key, value] of previous) {
    if (keepKeys.has(key)) {
      next.set(key, value);
    } else {
      changed = true;
    }
  }
  return changed ? next : previous;
}

/** Stable merge / memo key for a timeline card (tool, shell, lifecycle, event). */
export function timelineMirrorKey(item: TimelineItem): string | null {
  if (item.kind === "tool" && item.toolCallId) {
    return `tool:${item.toolCallId}`;
  }
  if (item.kind === "shell" && item.shell?.toolCallId) {
    return `shell:${item.shell.toolCallId}`;
  }
  const lifecycle = lifecycleMirrorKey(item);
  if (lifecycle) return lifecycle;
  if (item.sourceEventId) return `event:${item.sourceEventId}`;
  return null;
}

function timelineItemStableKey(item: TimelineItem): string {
  return timelineMirrorKey(item) ?? `id:${item.id}`;
}

/**
 * Reuse previous TimelineItem object refs when content is unchanged so React
 * memo on rows (and expensive Markdown) does not re-run after disk resync.
 */
export function stabilizeTimelineList(
  previous: TimelineItem[],
  next: TimelineItem[],
): TimelineItem[] {
  if (previous === next) return previous;
  if (previous.length === 0 || next.length === 0) return next;
  if (previous.length !== next.length) {
    return stabilizeTimelineListChanged(previous, next);
  }

  const prevByKey = new Map<string, TimelineItem>();
  for (const item of previous) {
    prevByKey.set(timelineItemStableKey(item), item);
  }

  let changed = false;
  const out: TimelineItem[] = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const candidate = next[i];
    const prior = prevByKey.get(timelineItemStableKey(candidate));
    if (prior && timelineItemsContentEqual(prior, candidate)) {
      out[i] = prior;
      if (prior !== previous[i]) changed = true;
    } else {
      out[i] = candidate;
      changed = true;
    }
  }
  return changed ? out : previous;
}

function stabilizeTimelineListChanged(
  previous: TimelineItem[],
  next: TimelineItem[],
): TimelineItem[] {
  const prevByKey = new Map<string, TimelineItem>();
  for (const item of previous) {
    prevByKey.set(timelineItemStableKey(item), item);
  }
  return next.map((candidate) => {
    const prior = prevByKey.get(timelineItemStableKey(candidate));
    return prior && timelineItemsContentEqual(prior, candidate)
      ? prior
      : candidate;
  });
}

/** Field-level equality for memo stability (not full deep-equal). */
export function timelineItemsContentEqual(
  a: TimelineItem,
  b: TimelineItem,
): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.ts !== b.ts ||
    a.kind !== b.kind ||
    a.title !== b.title ||
    a.detail !== b.detail ||
    a.handleId !== b.handleId ||
    a.sessionId !== b.sessionId ||
    a.sourceEventId !== b.sourceEventId ||
    a.streaming !== b.streaming ||
    a.toolCallId !== b.toolCallId ||
    a.toolBase !== b.toolBase ||
    a.toolStatus !== b.toolStatus ||
    a.isEdit !== b.isEdit
  ) {
    return false;
  }
  return (
    sameShell(a.shell, b.shell) &&
    sameSubagent(a.subagent, b.subagent) &&
    sameTask(a.task, b.task)
  );
}

function sameShell(
  a: TimelineItem["shell"],
  b: TimelineItem["shell"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.toolCallId === b.toolCallId &&
    a.command === b.command &&
    a.description === b.description &&
    a.status === b.status &&
    a.output === b.output &&
    a.exitCode === b.exitCode
  );
}

function sameSubagent(
  a: TimelineItem["subagent"],
  b: TimelineItem["subagent"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.subagentId === b.subagentId &&
    a.childSessionId === b.childSessionId &&
    a.parentSessionId === b.parentSessionId &&
    a.description === b.description &&
    a.subagentType === b.subagentType &&
    a.persona === b.persona &&
    a.role === b.role &&
    a.model === b.model &&
    a.capabilityMode === b.capabilityMode &&
    a.isBackground === b.isBackground &&
    a.depth === b.depth &&
    a.status === b.status &&
    a.activityLabel === b.activityLabel &&
    a.error === b.error &&
    a.durationMs === b.durationMs &&
    a.toolCalls === b.toolCalls &&
    a.turns === b.turns &&
    a.tokensUsed === b.tokensUsed
  );
}

function sameTask(
  a: TimelineItem["task"],
  b: TimelineItem["task"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.taskId === b.taskId &&
    a.toolCallId === b.toolCallId &&
    a.command === b.command &&
    a.description === b.description &&
    a.cwd === b.cwd &&
    a.isMonitor === b.isMonitor &&
    a.status === b.status &&
    a.exitCode === b.exitCode &&
    a.error === b.error
  );
}
