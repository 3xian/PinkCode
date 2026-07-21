import type {
  LiveStreamItem,
  ManagedAgentInfo,
  ShellEntry,
} from "../types";
import { COALESCE_LIVE_KINDS, describeUpdate } from "../utils/format";

export type UpdateDescription = ReturnType<typeof describeUpdate>;
export type ShellIndexes = Map<string, Map<string, number>>;

export const MAX_LIVE_ITEMS = 400;
export const MAX_SHELL_OUTPUT_CHARS = 200_000;

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
  map: Map<string, LiveStreamItem[]>,
  match?: { handleId?: string; key?: string },
): Map<string, LiveStreamItem[]> {
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

/** Enforce the per-session memory bound and invalidate derived shell indexes. */
export function trimLiveList(
  list: LiveStreamItem[],
  key: string,
  shellIndexByKey: Map<string, Map<string, number>>,
): void {
  if (list.length > MAX_LIVE_ITEMS) {
    list.splice(0, list.length - MAX_LIVE_ITEMS);
    shellIndexByKey.delete(key);
  }
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

export function reduceAgentUpdate(
  previous: Map<string, LiveStreamItem[]>,
  input: {
    handleId: string;
    sessionId?: string | null;
    description: UpdateDescription;
    now: number;
    nextId: () => string;
  },
  shellIndexes: ShellIndexes,
): Map<string, LiveStreamItem[]> {
  const { handleId, sessionId, description, now, nextId } = input;
  const key = sessionId || handleId;
  const textUpdate = isTextUpdate(description);
  const next = new Map(previous);
  const list = [...(next.get(key) ?? [])];

  if (!textUpdate) {
    for (let index = 0; index < list.length; index++) {
      if (list[index].streaming && list[index].handleId === handleId) {
        list[index] = { ...list[index], streaming: false };
      }
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
        detail: (last.detail ?? "") + (description.detail ?? ""),
        ts: now,
        streaming: last.streaming === true,
      };
      next.set(key, list);
      return next;
    }
  }

  if (description.kind === "tool" && description.toolCallId) {
    const index = list.findIndex(
      (item) =>
        item.kind === "tool" &&
        (item.detail === description.toolCallId ||
          item.title.includes(description.toolCallId!)),
    );
    if (index >= 0) {
      list[index] = {
        ...list[index],
        title: description.title || list[index].title,
        detail: description.toolCallId,
        ts: now,
      };
      next.set(key, list);
      return next;
    }
  }

  if (description.kind === "plan") {
    const index = list.findIndex(
      (item) => item.kind === "plan" && item.handleId === handleId,
    );
    if (index >= 0) {
      list[index] = {
        ...list[index],
        title: description.title,
        detail: description.detail,
        ts: now,
      };
      next.set(key, list);
      return next;
    }
  }

  list.push({
    id: nextId(),
    handleId,
    sessionId: sessionId ?? null,
    kind: description.kind,
    title: description.title,
    detail: description.detail,
    ts: now,
    streaming: textUpdate ? true : undefined,
  });
  trimLiveList(list, key, shellIndexes);
  next.set(key, list);
  return next;
}

export function reduceShellUpdate(
  previous: Map<string, LiveStreamItem[]>,
  raw: ShellEntry,
  shellIndexes: ShellIndexes,
): Map<string, LiveStreamItem[]> {
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
  const title =
    status === "completed" || status === "failed"
      ? `$ ${command || "shell"}${exitCode != null ? ` · exit ${exitCode}` : ""}`
      : `$ ${command || "shell"} · ${status}`;
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
    const mergedOutput =
      output.length >= previousOutput.length ? output : previousOutput;
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
      id: `shell-${toolCallId}-${now}`,
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
  trimLiveList(list, key, shellIndexes);
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
