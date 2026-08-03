import type {
  TimelineItem,
  ManagedAgentInfo,
  ShellEntry,
} from "../types";
import {
  COALESCE_LIVE_KINDS,
  describeUpdate,
  extractUpdateEventId,
  extractUpdateTsMs,
  formatTurnCompletedTitle,
  mergeToolCardParts,
} from "../utils/format";
import {
  formatBgTaskDetail,
  formatBgTaskTitle,
  formatSubagentDetail,
  formatSubagentTitle,
  lifecycleMirrorKey,
  mergeBgTaskPayload,
  mergeSubagentPayload,
} from "../utils/subagentTasks";

export type UpdateDescription = ReturnType<typeof describeUpdate>;
export type ShellIndexes = Map<string, Map<string, number>>;
export interface TimelineReducerState {
  shellIndexes: ShellIndexes;
  suppressedToolIds: Map<string, Set<string>>;
  /** Goal ids that already emitted their "Goal complete" milestone (Grok just_completed). */
  completedGoalIds: Set<string>;
}
export type TimelineRetention = "live" | "history";

export const MAX_LIVE_ITEMS = 400;
export const MAX_SHELL_OUTPUT_CHARS = 200_000;
/** Synthetic handle for on-disk Grok Build updates (vs ACP / local slash). */
export const DISK_HANDLE_ID = "disk";
export const LOCAL_HANDLE_ID = "local";

export function createTimelineReducerState(): TimelineReducerState {
  return {
    shellIndexes: new Map(),
    suppressedToolIds: new Map(),
    completedGoalIds: new Set(),
  };
}

export function capShellOutput(output: string): string {
  if (output.length <= MAX_SHELL_OUTPUT_CHARS) return output;
  const omittedGuess = output.length - MAX_SHELL_OUTPUT_CHARS;
  let prefix = `…[truncated ${omittedGuess} chars]…\n`;
  let keep = MAX_SHELL_OUTPUT_CHARS - prefix.length;
  if (keep < 1) {
    prefix = "…\n";
    keep = Math.max(1, MAX_SHELL_OUTPUT_CHARS - prefix.length);
  }
  const omitted = output.length - keep;
  prefix = `…[truncated ${omitted} chars]…\n`;
  keep = MAX_SHELL_OUTPUT_CHARS - prefix.length;
  if (keep < 1) return output.slice(-MAX_SHELL_OUTPUT_CHARS);
  return prefix + output.slice(-keep);
}

export function settleStreamingItems(
  map: Map<string, TimelineItem[]>,
  match?: { handleId?: string; key?: string },
): Map<string, TimelineItem[]> {
  let changed = false;
  const next = new Map(map);
  for (const [key, list] of next) {
    if (match?.key && key !== match.key) continue;
    let listChanged = false;
    const output = list.map((item) => {
      if (!item.streaming) return item;
      if (match?.handleId && item.handleId !== match.handleId) return item;
      listChanged = true;
      return { ...item, streaming: false };
    });
    if (listChanged) {
      next.set(key, output);
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
  let changed = false;
  const next = new Map(map);
  for (const [key, list] of map) {
    let listChanged = false;
    const settled = list.map((item) => {
      if (item.handleId !== handleId) return item;
      if (item.kind === "subagent" && item.subagent?.status === "running") {
        listChanged = true;
        const subagent = {
          ...item.subagent,
          status: "finished" as const,
          activityLabel: null,
        };
        return {
          ...item,
          subagent,
          toolStatus: subagent.status,
          title: formatSubagentTitle(subagent),
          detail: formatSubagentDetail(subagent),
        };
      }
      if (item.kind === "task" && item.task?.status === "running") {
        listChanged = true;
        const task = { ...item.task, status: "stopped" as const };
        return {
          ...item,
          task,
          toolStatus: task.status,
          title: formatBgTaskTitle(task),
          detail: formatBgTaskDetail(task),
        };
      }
      return item;
    });
    if (listChanged) {
      next.set(key, settled);
      changed = true;
    }
  }
  return changed ? next : map;
}

/** Enforce the per-session memory bound and invalidate derived shell indexes. */
export function trimLiveList(
  list: TimelineItem[],
  key: string,
  shellIndexByKey: Map<string, Map<string, number>>,
  retention: TimelineRetention = "live",
): void {
  if (retention === "live" && list.length > MAX_LIVE_ITEMS) {
    list.splice(0, list.length - MAX_LIVE_ITEMS);
    shellIndexByKey.delete(key);
  }
}

function sameAvailableModels(
  left: ManagedAgentInfo["availableModels"],
  right: ManagedAgentInfo["availableModels"],
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].modelId !== b[i].modelId || (a[i].name ?? null) !== (b[i].name ?? null)) {
      return false;
    }
  }
  return true;
}

export function sameManagedAgent(
  left: ManagedAgentInfo,
  right: ManagedAgentInfo,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.pid === right.pid &&
    left.pendingPermissionCount === right.pendingPermissionCount &&
    left.alwaysApprove === right.alwaysApprove &&
    left.permissionMode === right.permissionMode &&
    left.modelId === right.modelId &&
    sameAvailableModels(left.availableModels, right.availableModels) &&
    left.title === right.title &&
    left.lastError === right.lastError
  );
}


export function isTextUpdate(description: UpdateDescription): boolean {
  return (
    Boolean(description.coalesce) ||
    COALESCE_LIVE_KINDS.has(description.kind)
  );
}

/** Shared noise filter for ACP stream and disk hydrate. */
export function shouldDropUpdate(description: UpdateDescription): boolean {
  // Hidden tool updates must reach the reducer so suppression survives later
  // title-less updates carrying only the same toolCallId.
  if (description.hidden && description.kind !== "tool") return true;
  if (description.kind === "commands") return true;
  if (
    description.kind === "event" &&
    (!description.title || description.title === "event")
  ) {
    return true;
  }
  if (description.coalesce && !(description.detail && description.detail.length > 0)) {
    return true;
  }
  return false;
}

export function shellCardTitle(
  command: string,
  status: string,
  exitCode?: number | null,
): string {
  const cmd = command || "shell";
  if (status === "completed" || status === "failed") {
    return `$ ${cmd}${exitCode != null ? ` · exit ${exitCode}` : ""}`;
  }
  return `$ ${cmd} · ${status || "in_progress"}`;
}

/**
 * Sole owner of turn_completed titles: apply wall-clock elapsed since the last
 * user card (Grok Build "Worked for …"). Wire payloads rarely carry duration.
 */
export function enrichTurnCompletedDescription(
  description: UpdateDescription,
  list: TimelineItem[],
  now: number,
): UpdateDescription {
  if (!description.turnStopReason) return description;

  let lastUserTs: number | null = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind === "user" && list[i].ts > 0) {
      lastUserTs = list[i].ts;
      break;
    }
  }
  let elapsedMs: number | null = null;
  if (lastUserTs != null && now > lastUserTs) {
    const gap = now - lastUserTs;
    // Ignore absurd gaps (stale ts / clock skew).
    if (gap <= 24 * 60 * 60 * 1000) elapsedMs = gap;
  }
  return {
    ...description,
    title: formatTurnCompletedTitle(description.turnStopReason, elapsedMs),
  };
}

/** Insert or replace a timeline card; trim only on first insert. */
function upsertTimelineItem(
  list: TimelineItem[],
  index: number,
  card: TimelineItem,
  sessionKey: string,
  reducerState: TimelineReducerState,
  retention: TimelineRetention,
): void {
  if (index >= 0) {
    list[index] = { ...list[index], ...card };
  } else {
    list.push(card);
    trimLiveList(list, sessionKey, reducerState.shellIndexes, retention);
  }
}

export function reduceAgentUpdate(
  previous: Map<string, TimelineItem[]>,
  input: {
    handleId: string;
    sessionId?: string | null;
    description: UpdateDescription;
    now: number;
    nextId: () => string;
    sourceEventId?: string | null;
    /** Disk hydrate: never leave cards in streaming state. */
    streaming?: boolean;
  },
  reducerState: TimelineReducerState,
  retention: TimelineRetention = "live",
): Map<string, TimelineItem[]> {
  const { handleId, sessionId, now, nextId, sourceEventId } = input;
  const key = sessionId || handleId;
  const next = new Map(previous);
  const list = [...(next.get(key) ?? [])];
  const description = enrichTurnCompletedDescription(
    input.description,
    list,
    now,
  );
  const textUpdate = isTextUpdate(description);
  const markStreaming =
    input.streaming !== undefined ? input.streaming : textUpdate ? true : undefined;
  let listChanged = false;

  // Emit the "Goal complete" milestone once per goal (Grok Build gates on the
  // just-completed transition; a repeated complete broadcast must not stack).
  if (description.kind === "event" && description.goalId) {
    if (reducerState.completedGoalIds.has(description.goalId)) {
      return previous;
    }
    reducerState.completedGoalIds.add(description.goalId);
  }

  if (!textUpdate) {
    for (let index = 0; index < list.length; index++) {
      if (list[index].streaming && list[index].handleId === handleId) {
        list[index] = { ...list[index], streaming: false };
        listChanged = true;
      }
    }
  }

  if (description.kind === "tool" && description.toolCallId) {
    let suppressed = reducerState.suppressedToolIds.get(key);
    if (description.hidden) {
      const status = description.toolStatus?.toLowerCase();
      const terminal = status === "completed" || status === "failed";
      if (!terminal) {
        if (!suppressed) {
          suppressed = new Set();
          reducerState.suppressedToolIds.set(key, suppressed);
        }
        suppressed.add(description.toolCallId);
      } else if (suppressed) {
        suppressed.delete(description.toolCallId);
        if (suppressed.size === 0) {
          reducerState.suppressedToolIds.delete(key);
        }
      }
      const index = list.findIndex(
        (item) =>
          item.kind === "tool" &&
          item.toolCallId === description.toolCallId,
      );
      if (index >= 0) {
        list.splice(index, 1);
        reducerState.shellIndexes.delete(key);
        listChanged = true;
      }
      if (!listChanged) return previous;
      next.set(key, list);
      return next;
    }
    if (suppressed?.has(description.toolCallId)) {
      const status = description.toolStatus?.toLowerCase();
      if (status === "completed" || status === "failed") {
        suppressed.delete(description.toolCallId);
        if (suppressed.size === 0) {
          reducerState.suppressedToolIds.delete(key);
        }
      }
      if (!listChanged) return previous;
      next.set(key, list);
      return next;
    }
  }

  if (textUpdate) {
    const last = list[list.length - 1];
    if (
      last &&
      last.kind === description.kind &&
      last.handleId === handleId
    ) {
      list[list.length - 1] = {
        ...last,
        sourceEventId: sourceEventId ?? last.sourceEventId,
        detail: (last.detail ?? "") + (description.detail ?? ""),
        ts: now,
        streaming: markStreaming ?? last.streaming,
      };
      next.set(key, list);
      return next;
    }
  }

  if (description.kind === "tool" && description.toolCallId) {
    const index = list.findIndex(
      (item) =>
        item.kind === "tool" && item.toolCallId === description.toolCallId,
    );
    if (index >= 0) {
      const prev = list[index];
      const merged = mergeToolCardParts(
        {
          baseTitle: prev.toolBase ?? prev.title,
          status: prev.toolStatus,
          detail: prev.detail,
          title: prev.title,
        },
        {
          baseTitle: description.toolBase ?? description.title,
          status: description.toolStatus,
          detail: description.detail,
          title: description.title,
        },
      );
      list[index] = {
        ...prev,
        id: description.toolCallId
          ? `tool-${description.toolCallId}`
          : prev.id,
        sourceEventId: sourceEventId ?? prev.sourceEventId,
        title: merged.title,
        detail: merged.detail,
        toolBase: merged.baseTitle,
        toolStatus: merged.status,
        toolCallId: description.toolCallId,
        // `detail` merges as next-wins/fallback-prev; the diff flag must track
        // the same rule so a status-only update keeps the card flagged while a
        // completed update with plain detail clears it.
        isEdit: description.isEdit ?? prev.isEdit,
        ts: now,
      };
      next.set(key, list);
      return next;
    }
  }

  // Subagent / bg-task cards merge by stable mergeKey (child session / task id).
  if (description.kind === "subagent" && description.mergeKey && description.subagent) {
    const mergeKey = description.mergeKey;
    const index = list.findIndex(
      (item) =>
        item.kind === "subagent" && item.subagent?.childSessionId === mergeKey,
    );
    const prev = index >= 0 ? list[index] : null;
    const merged = mergeSubagentPayload(prev?.subagent, description.subagent);
    upsertTimelineItem(
      list,
      index,
      {
        id: `subagent-${mergeKey}`,
        handleId,
        sessionId: sessionId ?? null,
        kind: "subagent",
        title: formatSubagentTitle(merged),
        detail: formatSubagentDetail(merged),
        toolStatus: merged.status,
        ts: now,
        sourceEventId: sourceEventId ?? prev?.sourceEventId,
        streaming: markStreaming,
        subagent: merged,
      },
      key,
      reducerState,
      retention,
    );
    next.set(key, list);
    return next;
  }

  if (description.kind === "task" && description.mergeKey && description.task) {
    const mergeKey = description.mergeKey;
    const index = list.findIndex(
      (item) => item.kind === "task" && item.task?.taskId === mergeKey,
    );
    const prev = index >= 0 ? list[index] : null;
    const merged = mergeBgTaskPayload(prev?.task, description.task);
    upsertTimelineItem(
      list,
      index,
      {
        id: `task-${mergeKey}`,
        handleId,
        sessionId: sessionId ?? null,
        kind: "task",
        title: formatBgTaskTitle(merged),
        detail: formatBgTaskDetail(merged),
        toolStatus: merged.status,
        ts: now,
        sourceEventId: sourceEventId ?? prev?.sourceEventId,
        streaming: markStreaming,
        task: merged,
      },
      key,
      reducerState,
      retention,
    );
    next.set(key, list);
    return next;
  }

  if (description.kind === "plan") {
    const index = list.findIndex(
      (item) => item.kind === "plan" && item.handleId === handleId,
    );
    if (index >= 0) {
      list[index] = {
        ...list[index],
        id: sourceEventId ? `event-${sourceEventId}` : list[index].id,
        sourceEventId: sourceEventId ?? list[index].sourceEventId,
        title: description.title,
        detail: description.detail,
        ts: now,
      };
      next.set(key, list);
      return next;
    }
  }

  list.push({
    id: description.toolCallId
      ? `tool-${description.toolCallId}`
      : sourceEventId
        ? `event-${sourceEventId}`
        : nextId(),
    handleId,
    sessionId: sessionId ?? null,
    kind: description.kind,
    title: description.title,
    detail: description.detail,
    toolCallId: description.toolCallId,
    toolBase: description.toolBase,
    toolStatus: description.toolStatus,
    isEdit: description.isEdit,
    ts: now,
    sourceEventId: sourceEventId ?? undefined,
    streaming: markStreaming,
  });
  trimLiveList(list, key, reducerState.shellIndexes, retention);
  next.set(key, list);
  return next;
}

/**
 * Build Live cards from on-disk `updates.jsonl` by driving the same reducers
 * used for the live ACP stream (no parallel state machine).
 */
export function hydrateLiveFromDiskUpdates(
  updates: unknown[],
  sessionId: string,
): TimelineItem[] {
  if (!updates.length || !sessionId) return [];

  let map = new Map<string, TimelineItem[]>();
  const reducerState = createTimelineReducerState();
  let seq = 0;

  for (const raw of updates) {
    const desc = describeUpdate(raw);
    if (shouldDropUpdate(desc)) continue;

    const ts = extractUpdateTsMs(raw) ?? seq;
    const sourceEventId = extractUpdateEventId(raw);

    if (desc.isShell) {
      const entry = shellEntryFromDiskUpdate(
        raw,
        sessionId,
        desc.toolCallId,
        ts,
      );
      if (entry) {
        map = reduceShellUpdate(map, entry, reducerState, "history");
        seq += 1;
        continue;
      }
      // Incomplete shell payload → fall through as a normal tool card.
    }

    // Live ACP path skips shells here; disk has no agent-shell channel.
    map = reduceAgentUpdate(
      map,
      {
        handleId: DISK_HANDLE_ID,
        sessionId,
        description: desc,
        now: ts,
        nextId: () => `disk-${sessionId}-${seq++}`,
        sourceEventId,
        streaming: false,
      },
      reducerState,
      "history",
    );
  }

  return map.get(sessionId) ?? [];
}

/** Best-effort ShellEntry from a disk ACP update (for reduceShellUpdate). */
export function shellEntryFromDiskUpdate(
  raw: unknown,
  sessionId: string,
  toolCallId?: string,
  ts?: number,
): ShellEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const params = (u.params ?? u) as Record<string, unknown>;
  const inner =
    (params.update as Record<string, unknown> | undefined) ??
    (u.update as Record<string, unknown> | undefined) ??
    (u.sessionUpdate ? u : params);

  const id =
    toolCallId ||
    (typeof inner.toolCallId === "string" ? inner.toolCallId : "") ||
    "";
  if (!id) return null;

  const rawInput = inner.rawInput as Record<string, unknown> | undefined;
  const rawOutput = inner.rawOutput as Record<string, unknown> | undefined;
  const command =
    (typeof rawInput?.command === "string" && rawInput.command) ||
    (typeof rawInput?.cmd === "string" && rawInput.cmd) ||
    "";
  const description =
    (typeof inner.title === "string" && inner.title) ||
    (typeof rawInput?.description === "string" && rawInput.description) ||
    undefined;
  const status =
    (typeof inner.status === "string" && inner.status) || "in_progress";

  let output = "";
  if (rawOutput) {
    if (typeof rawOutput.output === "string") output = rawOutput.output;
    else if (typeof rawOutput.stdout === "string") output = rawOutput.stdout;
    else if (typeof rawOutput.text === "string") output = rawOutput.text;
    else if (Array.isArray(rawOutput.content)) {
      output = rawOutput.content
        .map((c) =>
          c && typeof c === "object" && "text" in c
            ? String((c as { text?: string }).text ?? "")
            : "",
        )
        .join("");
    }
  }

  const exitCode =
    typeof rawOutput?.exitCode === "number"
      ? rawOutput.exitCode
      : typeof rawOutput?.exit_code === "number"
        ? rawOutput.exit_code
        : null;

  return {
    id: `disk-shell-${id}`,
    handleId: DISK_HANDLE_ID,
    sessionId,
    toolCallId: id,
    command,
    description,
    status,
    output: capShellOutput(output),
    exitCode,
    ts: ts ?? Date.now(),
  };
}

export function reduceShellUpdate(
  previous: Map<string, TimelineItem[]>,
  raw: ShellEntry,
  reducerState: TimelineReducerState,
  retention: TimelineRetention = "live",
): Map<string, TimelineItem[]> {
  const shellIndexes = reducerState.shellIndexes;
  const handleId = raw.handleId;
  const sessionId = raw.sessionId ?? null;
  const toolCallId = raw.toolCallId;
  const command = raw.command || "";
  const description = raw.description;
  const status = raw.status || "in_progress";
  const output = capShellOutput(raw.output || "");
  const exitCode = raw.exitCode;
  const now = raw.ts || Date.now();
  const key = sessionId || handleId;
  const title = shellCardTitle(command, status, exitCode);
  const next = new Map(previous);
  const list = [...(next.get(key) ?? [])];
  let index = -1;
  let indexMap = shellIndexes.get(key);
  if (indexMap?.has(toolCallId)) {
    const candidate = indexMap.get(toolCallId)!;
    if (
      candidate >= 0 &&
      candidate < list.length &&
      list[candidate].kind === "shell" &&
      list[candidate].shell?.toolCallId === toolCallId
    ) {
      index = candidate;
    }
  }
  if (index < 0) {
    index = list.findIndex(
      (item) =>
        item.kind === "shell" && item.shell?.toolCallId === toolCallId,
    );
  }
  if (index >= 0) {
    const old = list[index];
    const previousOutput = old.shell?.output ?? "";
    const mergedOutput = raw.outputDelta
      ? capShellOutput(previousOutput + output)
      : output.length >= previousOutput.length
        ? output
        : previousOutput;
    if (
      mergedOutput === previousOutput &&
      status === old.shell?.status &&
      (exitCode ?? old.shell?.exitCode) === old.shell?.exitCode &&
      title === old.title
    ) {
      return previous;
    }
    list[index] = {
      ...old,
      title,
      detail: description || command || old.detail,
      ts: now,
      shell: {
        toolCallId,
        command: command || old.shell?.command || "",
        description: description ?? old.shell?.description,
        status,
        output: capShellOutput(mergedOutput),
        exitCode: exitCode ?? old.shell?.exitCode,
      },
    };
    if (!indexMap) {
      indexMap = new Map();
      shellIndexes.set(key, indexMap);
    }
    indexMap.set(toolCallId, index);
  } else {
    list.push({
      id: `shell-${toolCallId}`,
      handleId,
      sessionId,
      kind: "shell",
      title,
      detail: description || command || undefined,
      ts: now,
      shell: { toolCallId, command, description, status, output, exitCode },
    });
    if (!indexMap) {
      indexMap = new Map();
      shellIndexes.set(key, indexMap);
    }
    indexMap.set(toolCallId, list.length - 1);
  }
  trimLiveList(list, key, shellIndexes, retention);
  if (!shellIndexes.has(key)) {
    const rebuilt = new Map<string, number>();
    list.forEach((item, itemIndex) => {
      if (item.kind === "shell" && item.shell?.toolCallId) {
        rebuilt.set(item.shell.toolCallId, itemIndex);
      }
    });
    if (rebuilt.size) shellIndexes.set(key, rebuilt);
  }
  next.set(key, list);
  return next;
}

/**
 * Replace disk-sourced cards for a session; keep ACP + local slash cards.
 * Returns the previous map reference when nothing changed.
 */
export function mergeDiskLiveIntoMap(
  previous: Map<string, TimelineItem[]>,
  sessionId: string,
  diskItems: TimelineItem[],
): Map<string, TimelineItem[]> {
  const existing = previous.get(sessionId) ?? [];
  const keep = existing.filter((item) => item.handleId !== DISK_HANDLE_ID);
  const nextList = mergeTimelineItems(diskItems, keep);

  if (listsShallowEqual(existing, nextList)) {
    return previous;
  }
  const next = new Map(previous);
  if (nextList.length === 0) {
    next.delete(sessionId);
  } else {
    next.set(sessionId, nextList);
  }
  return next;
}

/**
 * Merge Timeline sources without rendering the persisted copy of an ACP item
 * beside its live copy. IDs are intentionally not used here: disk and live
 * reducers mint different UI IDs for the same ACP notification.
 */
export function mergeTimelineItems(
  ...lists: TimelineItem[][]
): TimelineItem[] {
  const merged = new Map<string, TimelineItem>();
  let anonymous = 0;

  for (const list of lists) {
    for (const item of list) {
      const key = timelineMirrorKey(item) ?? `item:${item.id}:${anonymous++}`;
      const current = merged.get(key);
      // The disk stream mirrors ACP. Prefer the freshest record; exact ties
      // keep the live version because it may still be streaming.
      if (!current || preferTimelineItem(item, current)) {
        merged.set(key, item);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.ts - b.ts);
}

function timelineMirrorKey(item: TimelineItem): string | null {
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

function preferTimelineItem(
  candidate: TimelineItem,
  current: TimelineItem,
): boolean {
  // Exact ACP mirrors represent the same notification. Preserve the live
  // version so its streaming state is not replaced by the persisted copy.
  if (
    candidate.sourceEventId &&
    candidate.sourceEventId === current.sourceEventId
  ) {
    return (
      candidate.handleId !== DISK_HANDLE_ID &&
      current.handleId === DISK_HANDLE_ID
    );
  }
  // Tool and shell cards share a stable call id across several updates. In
  // that case their timestamps, rather than their source, decide freshness.
  if (candidate.ts !== current.ts) return candidate.ts > current.ts;
  return (
    candidate.handleId !== DISK_HANDLE_ID && current.handleId === DISK_HANDLE_ID
  );
}

function listsShallowEqual(
  left: TimelineItem[],
  right: TimelineItem[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (
      a.id !== b.id ||
      a.ts !== b.ts ||
      a.kind !== b.kind ||
      a.title !== b.title ||
      a.detail !== b.detail ||
      a.handleId !== b.handleId ||
      a.sourceEventId !== b.sourceEventId ||
      a.streaming !== b.streaming
    ) {
      return false;
    }
  }
  return true;
}
