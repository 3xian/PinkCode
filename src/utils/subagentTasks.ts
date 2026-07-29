/**
 * Grok Build subagent + background-task lifecycle (host-side).
 *
 * Source of truth: xai-grok-pager tracker + session_notification handler.
 *
 * - TaskTool (`spawn_subagent`) is suppressed from scrollback; UI comes from
 *   `x.ai/session_notification` → `subagent_spawned` / `progress` / `finished`.
 * - WaitTasks / KillTask / TaskOutput are bg plumbing — suppressed; status
 *   lives on Subagent / BgTask cards.
 * - Background shell/monitor: `x.ai/task_backgrounded` + `x.ai/task_completed`.
 * - Nesting: only top-level sessions spawn children (max depth = 1).
 *
 * Parsers emit sparse patches (omit unchanged fields). The timeline reducer
 * merges onto the previous card — no sentinel defaults in the reducer.
 */

import type {
  BgTaskLifecyclePatch,
  BgTaskLifecycleStatus,
  SubagentLifecyclePatch,
  SubagentLifecycleStatus,
  TimelineBgTaskPayload,
  TimelineItem,
  TimelineSubagentPayload,
} from "../types";
import { SUBAGENT_MAX_DEPTH } from "../types";
import { extractToolMeta } from "./toolTitle";

export { SUBAGENT_MAX_DEPTH };

/** Description shape for liveTimeline.reduceAgentUpdate (lifecycle cards). */
export interface LifecycleDescription {
  kind: "subagent" | "task";
  title: string;
  detail?: string;
  hidden?: boolean;
  /**
   * Stable card identity: childSessionId (subagent) or taskId (bg task).
   * Not an ACP toolCallId — do not reuse toolCallId for this.
   */
  mergeKey: string;
  subagent?: SubagentLifecyclePatch;
  task?: BgTaskLifecyclePatch;
}

const BG_PLUMBING_TITLES = new Set([
  "get_command_or_subagent_output",
  "kill_command_or_subagent",
  "wait_commands_or_subagents",
  // Legacy / mid-rename names (persisted sessions)
  "get_task_output",
  "kill_task",
  "wait_tasks",
  "get_task_or_subagent_output",
  "kill_task_or_subagent",
  "wait_tasks_or_subagents",
  "AwaitShell",
  "Await",
]);

const BG_PLUMBING_VARIANTS = new Set(["TaskOutput", "KillTask", "WaitTasks"]);

function str(
  obj: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function num(
  obj: Record<string, unknown> | null | undefined,
  ...keys: string[]
): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function bool(
  obj: Record<string, unknown> | null | undefined,
  ...keys: string[]
): boolean | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/** Drop keys whose value is `undefined` so sparse merges keep previous data. */
export function definedFields<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Grok Build `is_bg_plumbing_tool` — wait/kill/poll tools are not scrollback;
 * the dedicated task/subagent UI owns their status.
 */
export function isBgPlumbingTool(inner: Record<string, unknown>): boolean {
  const rawInput = asRecord(inner.rawInput);
  const meta = extractToolMeta(inner);
  const rawTitle = String(inner.title ?? "").trim();
  const name = String(meta.name ?? "").trim();
  const variant = String(
    rawInput?.variant ??
      (asRecord(meta.input)?.variant as string | undefined) ??
      "",
  ).trim();

  if (BG_PLUMBING_VARIANTS.has(variant)) return true;
  for (const id of [rawTitle, name]) {
    if (!id) continue;
    if (BG_PLUMBING_TITLES.has(id)) return true;
    if (id.startsWith("Await:")) return true;
    if (id.startsWith("Sleep ")) return true;
    if (id.startsWith("Wait tasks:")) return true;
    if (id.startsWith("Kill task:")) return true;
  }
  return false;
}

function normalizeSubagentStatus(raw?: string | null): SubagentLifecycleStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "completed" || s === "done" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "interrupted") {
    return "cancelled";
  }
  return "running";
}

function normalizeBgStatus(
  raw?: string | null,
  exitCode?: number | null,
): BgTaskLifecycleStatus {
  const s = (raw ?? "").toLowerCase();
  if (s === "done" || s === "completed" || s === "success") return "done";
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled") {
    return "failed";
  }
  if (exitCode != null) return exitCode === 0 ? "done" : "failed";
  return "running";
}

function formatDurationMs(ms?: number | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return undefined;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

/** Title line mirroring Grok SubagentBlock wording. */
export function formatSubagentTitle(p: TimelineSubagentPayload): string {
  const quote = p.description ? `"${p.description}"` : "subagent";
  const elapsed = formatDurationMs(p.durationMs);
  if (!p.isBackground) {
    return `Subagent ${quote}`;
  }
  switch (p.status) {
    case "completed":
      return `Subagent completed${elapsed ? ` in ${elapsed}` : ""}: ${quote}`;
    case "failed":
      return `Subagent failed${elapsed ? ` in ${elapsed}` : ""}: ${quote}`;
    case "cancelled":
      return `Subagent cancelled${elapsed ? ` in ${elapsed}` : ""}: ${quote}`;
    default:
      return `Subagent started: ${quote}`;
  }
}

export function formatSubagentDetail(
  p: TimelineSubagentPayload,
): string | undefined {
  const bits: string[] = [];
  if (p.subagentType) bits.push(p.subagentType);
  if (p.model) bits.push(p.model);
  if (p.capabilityMode) bits.push(p.capabilityMode);
  if (p.persona) bits.push(`persona ${p.persona}`);
  if (p.role) bits.push(`role ${p.role}`);
  bits.push(`depth ${p.depth}/${p.maxDepth}`);
  if (p.activityLabel && p.status === "running") {
    bits.push(p.activityLabel);
  }
  if (p.status === "running") bits.push("running");
  else if (p.status) bits.push(p.status);
  if (p.toolCalls != null) bits.push(`${p.toolCalls} tools`);
  if (p.turns != null) bits.push(`${p.turns} turns`);
  if (p.tokensUsed != null && p.tokensUsed > 0) {
    bits.push(`${p.tokensUsed} tok`);
  }
  if (p.error) bits.push(p.error);
  if (p.childSessionId) {
    bits.push(`child ${p.childSessionId.slice(0, 8)}…`);
  }
  return bits.length ? bits.join(" · ") : undefined;
}

export function formatBgTaskTitle(p: TimelineBgTaskPayload): string {
  const label = p.isMonitor ? "Monitor" : "Background task";
  const subject =
    (p.description && p.description.trim()) ||
    (p.command && p.command.trim()) ||
    p.taskId ||
    "task";
  switch (p.status) {
    case "done":
      return `${label} done: ${subject}`;
    case "failed":
      return `${label} failed: ${subject}`;
    default:
      return `${label}: ${subject}`;
  }
}

export function formatBgTaskDetail(
  p: TimelineBgTaskPayload,
): string | undefined {
  const bits: string[] = [];
  if (p.isMonitor) bits.push("monitor");
  if (p.status) bits.push(p.status);
  if (p.exitCode != null) bits.push(`exit ${p.exitCode}`);
  if (p.command && p.description) bits.push(`$ ${p.command}`);
  if (p.cwd) bits.push(p.cwd);
  if (p.error) bits.push(p.error);
  if (p.taskId) bits.push(`id ${p.taskId}`);
  return bits.length ? bits.join(" · ") : undefined;
}

/** Defaults for first sight of a subagent card (spawn missing, progress first). */
export function defaultSubagent(
  patch: SubagentLifecyclePatch,
): TimelineSubagentPayload {
  return {
    subagentId: patch.subagentId ?? patch.childSessionId,
    childSessionId: patch.childSessionId,
    parentSessionId: patch.parentSessionId ?? null,
    description: patch.description ?? "subagent",
    subagentType: patch.subagentType ?? "general-purpose",
    persona: patch.persona ?? null,
    role: patch.role ?? null,
    model: patch.model ?? null,
    capabilityMode: patch.capabilityMode ?? null,
    isBackground: patch.isBackground ?? true,
    depth: patch.depth ?? SUBAGENT_MAX_DEPTH,
    maxDepth: patch.maxDepth ?? SUBAGENT_MAX_DEPTH,
    status: patch.status ?? "running",
    activityLabel: patch.activityLabel ?? null,
    error: patch.error ?? null,
    durationMs: patch.durationMs ?? null,
    toolCalls: patch.toolCalls ?? null,
    turns: patch.turns ?? null,
    tokensUsed: patch.tokensUsed ?? null,
  };
}

export function mergeSubagentPayload(
  prev: TimelineSubagentPayload | undefined,
  patch: SubagentLifecyclePatch,
): TimelineSubagentPayload {
  const base = prev ?? defaultSubagent(patch);
  const next: TimelineSubagentPayload = {
    ...base,
    ...definedFields(patch),
    childSessionId: patch.childSessionId,
  };
  // Terminal statuses drop in-progress activity.
  if (next.status !== "running") {
    next.activityLabel = null;
  }
  return next;
}

export function defaultBgTask(patch: BgTaskLifecyclePatch): TimelineBgTaskPayload {
  return {
    taskId: patch.taskId,
    toolCallId: patch.toolCallId ?? null,
    command: patch.command ?? "",
    description: patch.description ?? null,
    cwd: patch.cwd ?? null,
    isMonitor: patch.isMonitor ?? false,
    status: patch.status ?? "running",
    exitCode: patch.exitCode ?? null,
    error: patch.error ?? null,
  };
}

export function mergeBgTaskPayload(
  prev: TimelineBgTaskPayload | undefined,
  patch: BgTaskLifecyclePatch,
): TimelineBgTaskPayload {
  const base = prev ?? defaultBgTask(patch);
  return {
    ...base,
    ...definedFields(patch),
    taskId: patch.taskId,
  };
}

/**
 * Build a sparse subagent patch. `undefined` fields are omitted (keep previous);
 * pass `null` only when a field should be explicitly cleared.
 */
export function sparseSubagent(
  childSessionId: string,
  fields: Omit<Partial<TimelineSubagentPayload>, "childSessionId"> = {},
): SubagentLifecyclePatch {
  return { childSessionId, ...definedFields(fields) };
}

/**
 * Build a sparse bg-task patch. Same undefined/null semantics as sparseSubagent.
 */
export function sparseBgTask(
  taskId: string,
  fields: Omit<Partial<TimelineBgTaskPayload>, "taskId"> = {},
): BgTaskLifecyclePatch {
  return { taskId, ...definedFields(fields) };
}

/**
 * Lifecycle description for the reducer. Title/detail are a best-effort preview
 * (spawn/finish with full fields); the reducer always reformats after merge.
 */
function subagentDesc(patch: SubagentLifecyclePatch): LifecycleDescription {
  const preview = mergeSubagentPayload(undefined, patch);
  return {
    kind: "subagent",
    title: formatSubagentTitle(preview),
    detail: formatSubagentDetail(preview),
    mergeKey: patch.childSessionId,
    subagent: patch,
  };
}

function taskDesc(patch: BgTaskLifecyclePatch): LifecycleDescription {
  const preview = mergeBgTaskPayload(undefined, patch);
  return {
    kind: "task",
    title: formatBgTaskTitle(preview),
    detail: formatBgTaskDetail(preview),
    mergeKey: patch.taskId,
    task: patch,
  };
}

/**
 * Parse lifecycle notifications into a sparse timeline description.
 * Accepts either the raw method + params envelope, or a bare update object
 * (disk hydrate / session/update path).
 */
export function describeLifecycleNotification(
  method: string | undefined | null,
  params: unknown,
): LifecycleDescription | null {
  if (!method && !params) return null;
  const root = asRecord(params);
  if (!root) return null;

  const update =
    asRecord(root.update) ??
    // Bare sessionUpdate object (hydrate / describeUpdate inner)
    (str(root, "sessionUpdate", "session_update") ? root : null) ??
    root;

  const sessionUpdate = str(update, "sessionUpdate", "session_update");

  if (
    method === "x.ai/task_backgrounded" ||
    sessionUpdate === "task_backgrounded"
  ) {
    const taskId = str(update, "task_id", "taskId");
    if (!taskId) return null;
    const monitorDescription = str(
      update,
      "monitor_description",
      "monitorDescription",
    );
    const command = str(update, "command") ?? "";
    const description =
      monitorDescription ?? str(update, "description") ?? undefined;
    const isMonitor =
      Boolean(monitorDescription) || command.startsWith("[monitor] ");
    return taskDesc(
      sparseBgTask(taskId, {
        toolCallId: str(update, "tool_call_id", "toolCallId") ?? null,
        command: isMonitor ? command.replace(/^\[monitor\]\s*/, "") : command,
        description: description ?? null,
        cwd: str(update, "cwd") ?? null,
        isMonitor,
        status: "running",
      }),
    );
  }

  if (
    method === "x.ai/task_completed" ||
    sessionUpdate === "task_completed"
  ) {
    const snapshot =
      asRecord(update.task_snapshot) ??
      asRecord(update.taskSnapshot) ??
      update;
    const taskId = str(snapshot, "task_id", "taskId");
    if (!taskId) return null;
    const exitCode = num(snapshot, "exit_code", "exitCode");
    const statusRaw = str(snapshot, "status");
    const command = str(snapshot, "command");
    const description = str(snapshot, "description");
    const monDesc = str(snapshot, "monitor_description", "monitorDescription");
    const isMonitor =
      Boolean(monDesc) ||
      (command != null && command.startsWith("[monitor] "));
    // Sparse finish: omit absent fields so merge keeps task_backgrounded values.
    return taskDesc(
      sparseBgTask(taskId, {
        toolCallId: str(snapshot, "tool_call_id", "toolCallId"),
        command:
          command != null
            ? isMonitor
              ? command.replace(/^\[monitor\]\s*/, "")
              : command
            : undefined,
        description: description ?? monDesc,
        cwd: str(snapshot, "cwd"),
        isMonitor:
          monDesc != null || command?.startsWith("[monitor] ")
            ? true
            : undefined,
        status: normalizeBgStatus(statusRaw, exitCode ?? null),
        exitCode,
        error: str(snapshot, "error", "signal"),
      }),
    );
  }

  if (
    method &&
    method !== "x.ai/session_notification" &&
    method !== "x.ai/session/update" &&
    !sessionUpdate?.startsWith("subagent_")
  ) {
    return null;
  }

  if (sessionUpdate === "subagent_spawned") {
    const childSessionId = str(
      update,
      "child_session_id",
      "childSessionId",
      "subagent_id",
      "subagentId",
    );
    if (!childSessionId) return null;
    const subagentId =
      str(update, "subagent_id", "subagentId") ?? childSessionId;
    const description = str(update, "description") ?? "subagent";
    const isBackground =
      bool(update, "is_background", "isBackground") ?? true;
    return subagentDesc(
      sparseSubagent(childSessionId, {
        subagentId,
        parentSessionId:
          str(update, "parent_session_id", "parentSessionId") ?? null,
        description,
        subagentType:
          str(update, "subagent_type", "subagentType") ?? "general-purpose",
        persona: str(update, "persona") ?? null,
        role: str(update, "role") ?? null,
        model: str(update, "model") ?? null,
        capabilityMode:
          str(update, "capability_mode", "capabilityMode") ?? null,
        isBackground,
        depth: SUBAGENT_MAX_DEPTH,
        maxDepth: SUBAGENT_MAX_DEPTH,
        status: "running",
      }),
    );
  }

  if (sessionUpdate === "subagent_progress") {
    const childSessionId = str(
      update,
      "child_session_id",
      "childSessionId",
      "subagent_id",
      "subagentId",
    );
    if (!childSessionId) return null;
    const toolsUsed = Array.isArray(update.tools_used)
      ? (update.tools_used as unknown[])
          .filter((t): t is string => typeof t === "string")
          .slice(0, 3)
      : [];
    // Only write activity when the event carries one — never force null.
    const activityLabel =
      str(update, "activity_label", "activityLabel") ??
      (toolsUsed.length ? `Using ${toolsUsed.join(", ")}` : undefined);
    return subagentDesc(
      sparseSubagent(childSessionId, {
        subagentId: str(update, "subagent_id", "subagentId"),
        parentSessionId: str(update, "parent_session_id", "parentSessionId"),
        description: str(update, "description"),
        subagentType: str(update, "subagent_type", "subagentType"),
        status: "running",
        activityLabel,
        durationMs: num(update, "duration_ms", "durationMs"),
        toolCalls: num(
          update,
          "tool_call_count",
          "toolCallCount",
          "tool_calls",
        ),
        turns: num(update, "turn_count", "turnCount", "turns"),
        tokensUsed: num(update, "tokens_used", "tokensUsed"),
      }),
    );
  }

  if (sessionUpdate === "subagent_finished") {
    const childSessionId = str(
      update,
      "child_session_id",
      "childSessionId",
      "subagent_id",
      "subagentId",
    );
    if (!childSessionId) return null;
    return subagentDesc(
      sparseSubagent(childSessionId, {
        subagentId: str(update, "subagent_id", "subagentId"),
        parentSessionId: str(update, "parent_session_id", "parentSessionId"),
        description: str(update, "description"),
        subagentType: str(update, "subagent_type", "subagentType"),
        status: normalizeSubagentStatus(str(update, "status")),
        // Explicit clear only for terminal activity; error only when present.
        error: str(update, "error"),
        durationMs: num(update, "duration_ms", "durationMs"),
        toolCalls: num(update, "tool_calls", "toolCalls"),
        turns: num(update, "turns"),
        tokensUsed: num(update, "tokens_used", "tokensUsed"),
        activityLabel: null,
      }),
    );
  }

  return null;
}

/** Active (running) subagents currently visible in a parent timeline. */
export function listActiveSubagents(
  items: TimelineItem[],
): TimelineSubagentPayload[] {
  return items
    .filter(
      (item): item is TimelineItem & { subagent: TimelineSubagentPayload } =>
        item.kind === "subagent" &&
        item.subagent != null &&
        item.subagent.status === "running",
    )
    .map((item) => item.subagent);
}

/** Active background tasks (bash / monitor) in a parent timeline. */
export function listActiveBgTasks(items: TimelineItem[]): TimelineBgTaskPayload[] {
  return items
    .filter(
      (item): item is TimelineItem & { task: TimelineBgTaskPayload } =>
        item.kind === "task" &&
        item.task != null &&
        item.task.status === "running",
    )
    .map((item) => item.task);
}

export function isLifecycleNotificationMethod(method?: string | null): boolean {
  if (!method) return false;
  return (
    method === "x.ai/session_notification" ||
    method === "x.ai/session/update" ||
    method === "x.ai/task_backgrounded" ||
    method === "x.ai/task_completed"
  );
}

/** Stable live/disk mirror key for lifecycle cards. */
export function lifecycleMirrorKey(item: TimelineItem): string | null {
  if (item.kind === "subagent" && item.subagent?.childSessionId) {
    return `subagent:${item.subagent.childSessionId}`;
  }
  if (item.kind === "task" && item.task?.taskId) {
    return `task:${item.task.taskId}`;
  }
  return null;
}
