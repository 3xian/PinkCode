/**
 * Attach/reconnect lifecycle snapshots and descendant-session projection.
 *
 * Wire notification parsing stays in subagentTasks; this module owns the
 * cross-card state operations that need a current timeline snapshot.
 */

import type {
  BgTaskLifecycleStatus,
  ListedSubagent,
  ListedTask,
  ListSubagentsResult,
  ListTasksResult,
  TimelineItem,
} from "../types";
import {
  describeSubagentPatch,
  describeTaskPatch,
  formatSubagentDetail,
  formatSubagentTitle,
  lifecycleMirrorKey,
  sparseBgTask,
  sparseSubagent,
  type LifecycleDescription,
} from "./subagentTasks";

/** Map one active `x.ai/subagent/list_running` row into a lifecycle patch. */
export function describeListedSubagent(
  row: ListedSubagent,
): LifecycleDescription | null {
  const childSessionId = row.childSessionId ?? row.subagentId;
  if (!childSessionId) return null;
  const tools = (row.toolsUsed ?? []).filter(Boolean).slice(0, 3);
  return describeSubagentPatch(
    sparseSubagent(childSessionId, {
      subagentId: row.subagentId ?? childSessionId,
      parentSessionId: row.parentSessionId ?? null,
      description: row.description ?? "subagent",
      subagentType: row.subagentType ?? "general-purpose",
      status: "running",
      durationMs: row.durationMs,
      toolCalls: row.toolCallCount,
      turns: row.turnCount,
      tokensUsed: row.tokensUsed,
      activityLabel: tools.length ? `Using ${tools.join(", ")}` : undefined,
    }),
  );
}

function listedTaskStatus(row: ListedTask): BgTaskLifecycleStatus {
  if (!row.completed) return "running";
  if (row.signal) return "failed";
  if (row.exit_code != null) return row.exit_code === 0 ? "done" : "failed";
  return "stopped";
}

/** Map one complete `x.ai/task/list` TaskSnapshot into a lifecycle patch. */
export function describeListedTask(
  row: ListedTask,
): LifecycleDescription | null {
  const taskId = row.task_id;
  if (!taskId) return null;
  const command = row.display_command ?? row.command ?? "";
  const isMonitor =
    row.kind === "monitor" ||
    Boolean(row.description && command.startsWith("[monitor] "));
  return describeTaskPatch(
    sparseBgTask(taskId, {
      command: isMonitor
        ? command.replace(/^\[monitor\]\s*/, "")
        : command,
      description: row.description ?? null,
      cwd: row.cwd ?? null,
      isMonitor,
      status: listedTaskStatus(row),
      exitCode: row.exit_code ?? null,
      error: row.signal ?? null,
    }),
  );
}

export function lifecycleFromListSubagents(
  result: ListSubagentsResult | null | undefined,
): LifecycleDescription[] {
  return (result?.subagents ?? [])
    .map(describeListedSubagent)
    .filter((item): item is LifecycleDescription => item != null);
}

/**
 * Only materialize outstanding tasks plus terminal rows that replace a card
 * currently known as running. This avoids replaying every completed task in a
 * long-lived session merely because the UI reattached.
 */
export function lifecycleFromListTasks(
  result: ListTasksResult,
  currentRunningIds: Set<string>,
): LifecycleDescription[] {
  return result.tasks
    .filter(
      (row) =>
        !row.completed ||
        (row.task_id != null && currentRunningIds.has(row.task_id)),
    )
    .map(describeListedTask)
    .filter((item): item is LifecycleDescription => item != null);
}

/**
 * Build snapshot patches from the latest committed timeline state.
 *
 * `list_running` is active-only, so an absent running subagent gets a generic
 * terminal state. `task/list` is a full TaskSnapshot list; completed rows carry
 * their exact result and are applied to matching running cards.
 */
export function reconcileLifecycleSnapshots(
  currentItems: TimelineItem[],
  subagents?: ListSubagentsResult,
  tasks?: ListTasksResult,
): LifecycleDescription[] {
  const out: LifecycleDescription[] = [];

  if (subagents) {
    out.push(...lifecycleFromListSubagents(subagents));
    const active = new Set(
      subagents.subagents
        .map((row) => row.childSessionId ?? row.subagentId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const item of currentItems) {
      const subagent = item.subagent;
      if (
        item.kind === "subagent" &&
        subagent?.status === "running" &&
        !active.has(subagent.childSessionId)
      ) {
        out.push(
          describeSubagentPatch(
            sparseSubagent(subagent.childSessionId, {
              status: "finished",
              activityLabel: null,
            }),
          ),
        );
      }
    }
  }

  if (tasks) {
    const running = new Set(
      currentItems
        .filter((item) => item.kind === "task" && item.task?.status === "running")
        .map((item) => item.task!.taskId),
    );
    out.push(...lifecycleFromListTasks(tasks, running));

    const listed = new Set(
      tasks.tasks
        .map((row) => row.task_id)
        .filter((id): id is string => Boolean(id)),
    );
    for (const taskId of running) {
      if (!listed.has(taskId)) {
        out.push(describeTaskPatch(sparseBgTask(taskId, { status: "stopped" })));
      }
    }
  }

  return out;
}

/**
 * Flatten descendant lifecycle cards into the root task view. Agent text and
 * tool output remain scoped to their own session.
 */
export function projectNestedLifecycleItems(
  rootSessionId: string,
  rootItems: TimelineItem[],
  itemsBySession: Map<string, TimelineItem[]>,
): TimelineItem[] {
  const projected: Array<{ item: TimelineItem; depth?: number }> = [];
  const seenCards = new Set<string>();
  const seenSessions = new Set<string>();
  const queue: Array<{ sessionId: string; depth: number; root: boolean }> = [
    { sessionId: rootSessionId, depth: 0, root: true },
  ];

  while (queue.length) {
    const current = queue.shift()!;
    if (seenSessions.has(current.sessionId)) continue;
    seenSessions.add(current.sessionId);
    const items = current.root
      ? rootItems
      : (itemsBySession.get(current.sessionId) ?? []);

    for (const item of items) {
      const lifecycle = item.kind === "subagent" || item.kind === "task";
      if (!current.root && !lifecycle) continue;

      const key = lifecycleMirrorKey(item) ?? `item:${item.id}`;
      if (!seenCards.has(key)) {
        seenCards.add(key);
        projected.push({
          item,
          depth:
            item.kind === "subagent" && item.subagent
              ? current.depth + 1
              : undefined,
        });
      }

      if (item.kind === "subagent" && item.subagent?.childSessionId) {
        queue.push({
          sessionId: item.subagent.childSessionId,
          depth: current.depth + 1,
          root: false,
        });
      }
    }
  }

  return projected
    .map(({ item, depth }) => {
      if (depth == null || !item.subagent) return item;
      const subagent = { ...item.subagent, depth };
      return {
        ...item,
        subagent,
        title: formatSubagentTitle(subagent),
        detail: formatSubagentDetail(subagent),
      };
    })
    .sort((left, right) => left.ts - right.ts);
}
