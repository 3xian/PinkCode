import type {
  AvailableCommand,
  BgTaskLifecyclePatch,
  SubagentLifecyclePatch,
} from "../types";
import {
  describeLifecycleNotification,
  isBgPlumbingTool,
} from "./subagentTasks";
import { extractToolMeta, formatToolCardParts } from "./toolTitle";

export type { ToolCardParts } from "./toolTitle";
export {
  composeToolTitle,
  formatToolCardParts,
  isToolCallId,
  mergeToolCardParts,
  toolPrimaryTarget,
} from "./toolTitle";

/** Compact token counts. Pass `decimals: false` for integer units (e.g. Context). */
export function formatTokens(n: number, opts?: { decimals?: boolean }): string {
  const decimals = opts?.decimals !== false;
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${decimals ? v.toFixed(1) : String(Math.round(v))}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${decimals ? v.toFixed(1) : String(Math.round(v))}k`;
  }
  return String(Math.round(n));
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Local wall-clock for timeline cards (HH:mm:ss). Accepts ms or unix seconds. */
export function formatClockTime(ts?: number | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return "";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Best-effort timestamp (ms) from an on-disk updates.jsonl / events record.
 * Mirrors Rust `extract_update_unix_secs` fields when present.
 */
export function extractUpdateTsMs(update: unknown): number | null {
  if (!update || typeof update !== "object") return null;
  const u = update as Record<string, unknown>;
  const params = (u.params ?? null) as Record<string, unknown> | null;
  const inner =
    (params?.update as Record<string, unknown> | undefined) ??
    (u.update as Record<string, unknown> | undefined) ??
    null;

  const metaCandidates: unknown[] = [
    (inner?._meta as Record<string, unknown> | undefined)?.agentTimestampMs,
    ((inner?._meta as Record<string, unknown> | undefined)?.["x.ai"] as
      | Record<string, unknown>
      | undefined)?.agentTimestampMs,
    (params?._meta as Record<string, unknown> | undefined)?.agentTimestampMs,
    (u._meta as Record<string, unknown> | undefined)?.agentTimestampMs,
  ];
  for (const raw of metaCandidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return n > 1e12 ? n : n * 1000;
    }
  }

  const ts = u.timestamp ?? params?.timestamp ?? inner?.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return ts > 1e12 ? ts : ts * 1000;
  }
  if (typeof ts === "string" && ts.trim()) {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
    const n = Number(ts);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  }
  return null;
}

export function extractUpdateEventId(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const value = update as Record<string, unknown>;
  const params = value.params as Record<string, unknown> | undefined;
  const candidates = [
    (value._meta as Record<string, unknown> | undefined)?.eventId,
    (value._meta as Record<string, unknown> | undefined)?.event_id,
    (params?._meta as Record<string, unknown> | undefined)?.eventId,
    (params?._meta as Record<string, unknown> | undefined)?.event_id,
  ];
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    ) ?? null
  );
}

/** Split on `/` or `\` so Windows and Unix paths display correctly. */
function pathParts(path: string): string[] {
  return path.split(/[/\\]+/).filter(Boolean);
}

export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = pathParts(path);
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`;
  return `…/${parts.slice(-2).join("/")}`;
}

export function projectName(cwd: string): string {
  const parts = pathParts(cwd.replace(/[/\\]+$/, ""));
  return parts[parts.length - 1] || cwd;
}

export function contextPct(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 1000) / 10);
}

/** Parse ISO / unix-seconds / unix-ms into epoch ms, or null. */
function parseDeadlineMs(isoOrUnix?: string | null): number | null {
  if (!isoOrUnix) return null;
  let t = Date.parse(isoOrUnix);
  if (Number.isNaN(t)) {
    const n = Number(isoOrUnix);
    if (!Number.isFinite(n)) return null;
    t = n < 1e12 ? n * 1000 : n;
  }
  return t;
}

/** Human remaining time until ISO timestamp (or unix-seconds string). */
export function formatTimeUntil(isoOrUnix?: string | null): string {
  const t = parseDeadlineMs(isoOrUnix);
  if (t == null) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "resetting…";
  const sec = Math.floor(diff / 1000);
  const day = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (day > 0) return `${day}d ${hr}h`;
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
}

/**
 * Compact countdown for the usage header:
 * ≥1 day → "Nd"; &lt;1 day → "Nh"; &lt;1 hour → "Nm".
 */
export function formatResetCountdown(isoOrUnix?: string | null): string {
  const t = parseDeadlineMs(isoOrUnix);
  if (t == null) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  const day = Math.floor(sec / 86400);
  if (day >= 1) return `${day}d`;
  const hr = Math.floor(sec / 3600);
  if (hr >= 1) return `${hr}h`;
  const min = Math.max(1, Math.floor(sec / 60));
  return `${min}m`;
}

/** Stream kinds that arrive as many tiny chunks and should be coalesced. */
export const COALESCE_LIVE_KINDS = new Set(["user", "agent", "thought"]);

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Read a numeric field that may arrive as camelCase or snake_case. */
function numField(
  obj: Record<string, unknown>,
  camel: string,
  snake: string,
): number {
  const v = obj[camel] ?? obj[snake];
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Wall-clock duration for turn-terminal markers (Grok Build style).
 * Sub-minute values always keep one decimal; longer spans use m/h.
 */
export function formatTurnElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = ms / 1000;
  // Sub-minute: always one decimal (Grok Build "Worked for 12.3s").
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) {
    if (m > 0) return `${h}h ${m}m`;
    if (s > 0) return `${h}h ${s}s`;
    return `${h}h`;
  }
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Normalize ACP stop_reason / stopReason enums for display mapping. */
export function normalizeStopReason(stopReason: string): string {
  return (stopReason || "end_turn").trim().toLowerCase().replace(/-/g, "_");
}

/**
 * Human title for turn_completed — mirrors Grok Build session markers.
 * Does not surface protocol enums like `end_turn` in the happy path.
 * Elapsed comes from the timeline reducer (last user card → now), not the wire.
 */
export function formatTurnCompletedTitle(
  stopReason: string,
  elapsedMs?: number | null,
): string {
  const stop = normalizeStopReason(stopReason);
  const elapsed =
    elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs > 0
      ? formatTurnElapsed(elapsedMs)
      : "";

  switch (stop) {
    case "cancelled":
    case "canceled":
      return elapsed
        ? `Turn cancelled by user in ${elapsed}`
        : "Turn cancelled by user";
    case "error":
      return elapsed ? `Turn failed in ${elapsed}` : "Turn failed";
    case "rate_limit":
      return "Rate limited";
    // end_turn / max_tokens / max_turn_requests / refusal / unknown → done
    // (same mapping as Grok Build session markers — no protocol enums in title)
    default:
      return elapsed ? `Worked for ${elapsed}` : "Turn completed";
  }
}

function formatTurnCompletedDetail(
  stopReason: string,
  agentResult: string | undefined,
): string | undefined {
  const stop = normalizeStopReason(stopReason);
  const parts: string[] = [];
  if (stop === "error" && agentResult) {
    parts.push(agentResult);
  } else if (
    (stop === "max_tokens" || stop === "max_turn_requests") &&
    !agentResult
  ) {
    // Subtle hint only when useful; title stays "Worked for…" / "Turn completed"
    parts.push(
      stop === "max_tokens" ? "Hit output token limit" : "Hit max turn requests",
    );
  } else if (
    agentResult &&
    stop !== "end_turn" &&
    stop !== "cancelled" &&
    stop !== "canceled"
  ) {
    parts.push(agentResult);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * Whether Rust `maybe_emit_shell` would emit an `agent-shell` event for this
 * ACP update. Keep in sync with `agent_manager.rs` (title / meta / raw I/O).
 */
export function isShellToolUpdate(inner: Record<string, unknown>): boolean {
  const sessionUpdate = String(inner.sessionUpdate ?? "");
  if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") {
    return false;
  }

  const tool = extractToolMeta(inner);
  const toolMetaName = String(tool?.name ?? "");
  const toolKind = String(
    (inner.kind as string | undefined) ?? (tool?.kind as string | undefined) ?? "",
  );
  const title = String(inner.title ?? "");
  const titleLower = title.toLowerCase();

  const flagged =
    toolMetaName === "run_terminal_command" ||
    toolKind === "execute" ||
    title.includes("run_terminal") ||
    titleLower.includes("execute `");

  if (flagged) return true;

  if (sessionUpdate === "tool_call") {
    const rawInput = inner.rawInput as Record<string, unknown> | undefined;
    return typeof rawInput?.command === "string" && rawInput.command.length > 0;
  }

  // tool_call_update: only shell if Bash-shaped output
  const rawOutput = inner.rawOutput as Record<string, unknown> | undefined;
  return rawOutput?.type === "Bash";
}

/**
 * Grok Build keeps control-plane tools out of scrollback because their state is
 * represented by dedicated UI (todo/task/goal/workflow panes and blocks).
 */
export function isGrokScrollbackSuppressedTool(
  inner: Record<string, unknown>,
): boolean {
  const rawInput = inner.rawInput as Record<string, unknown> | undefined;
  const meta = extractToolMeta(inner);
  const rawTitle = String(inner.title ?? "").trim();
  const name = String(meta.name ?? "").trim();
  const variant = String(
    rawInput?.variant ??
      (meta.input as Record<string, unknown> | undefined)?.variant ??
      "",
  ).trim();
  const identifiers = [rawTitle, name];

  if (
    identifiers.some((value) =>
      ["todo_write", "TodoWrite", "Updating plan"].includes(value),
    ) ||
    variant === "TodoWrite"
  ) {
    return true;
  }
  if (
    identifiers.some((value) =>
      ["task", "Task", "spawn_subagent"].includes(value),
    ) ||
    variant === "Task"
  ) {
    return true;
  }
  // WaitTasks / KillTask / TaskOutput — status lives on Subagent / BgTask UI.
  if (isBgPlumbingTool(inner)) {
    return true;
  }
  if (
    identifiers.some(
      (value) => value === "update_goal" || value.startsWith("Goal:"),
    ) ||
    variant === "UpdateGoal" ||
    variant === "WorkflowSignal"
  ) {
    return true;
  }
  if (
    identifiers.some((value) => value.startsWith("scheduler_")) ||
    variant.startsWith("Scheduler")
  ) {
    return true;
  }

  const isWorkflow =
    identifiers.includes("workflow") || variant === "Workflow";
  const validateOnly =
    rawTitle.startsWith("Validating workflow") ||
    rawInput?.validate_only === true;
  return isWorkflow && !validateOnly;
}

/** Best-effort parse of ACP session/update stream for timeline display. */
export function describeUpdate(update: unknown): {
  kind: string;
  title: string;
  detail?: string;
  /** Grok Build does not render this protocol/control-plane update in scrollback. */
  hidden?: boolean;
  /** True when this is a text stream chunk (merge with previous same kind). */
  coalesce?: boolean;
  toolCallId?: string;
  /** Structured tool title parts when kind is `"tool"`. */
  toolBase?: string;
  toolStatus?: string;
  /** True when this update is a shell tool (Live uses agent-shell card only). */
  isShell?: boolean;
  /** Slash commands from `available_commands_update` (not shown as a live card). */
  availableCommands?: AvailableCommand[];
  /**
   * When set, the timeline reducer is the sole owner of the final title and
   * applies wall-clock elapsed since the last user card (Grok Build "Worked for …").
   */
  turnStopReason?: string;
  /**
   * Stable card identity for subagent/task lifecycle (childSessionId / taskId).
   * Not an ACP toolCallId.
   */
  mergeKey?: string;
  /** Sparse patch for `kind === "subagent"` lifecycle cards. */
  subagent?: SubagentLifecyclePatch;
  /** Sparse patch for `kind === "task"` background-task cards. */
  task?: BgTaskLifecyclePatch;
} {
  if (!update || typeof update !== "object") {
    return { kind: "unknown", title: String(update) };
  }
  const u = update as Record<string, unknown>;
  const method = u.method as string | undefined;
  const params = (u.params ?? u) as Record<string, unknown>;
  // Accept either full JSON-RPC envelope or bare update object
  const inner =
    (params.update as Record<string, unknown> | undefined) ??
    (u.update as Record<string, unknown> | undefined) ??
    (u.sessionUpdate ? u : (params as Record<string, unknown>));
  const sessionUpdate =
    (inner.sessionUpdate as string) ||
    (u.sessionUpdate as string) ||
    method ||
    "event";

  switch (sessionUpdate) {
    case "user_message_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ??
        (inner as { content?: { text?: string } }).content?.text ??
        "";
      return {
        kind: "user",
        title: "User",
        detail: text,
        coalesce: true,
      };
    }
    case "agent_message_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ?? "";
      return {
        kind: "agent",
        title: "Agent",
        detail: text,
        coalesce: true,
      };
    }
    case "agent_thought_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ?? "";
      return {
        kind: "thought",
        title: "Thinking",
        detail: text,
        coalesce: true,
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId =
        (inner.toolCallId as string | undefined) ?? undefined;
      const parts = formatToolCardParts(inner);
      const hidden = isGrokScrollbackSuppressedTool(inner);
      return {
        kind: "tool",
        title: parts.title,
        detail: parts.detail,
        hidden,
        toolCallId,
        toolBase: parts.baseTitle,
        toolStatus: parts.status,
        isShell: isShellToolUpdate({
          ...inner,
          sessionUpdate,
        }),
      };
    }
    case "plan": {
      return {
        kind: "plan",
        title: "Plan update",
        hidden: true,
      };
    }
    case "turn_completed": {
      const stop = normalizeStopReason(
        String(inner.stop_reason ?? inner.stopReason ?? "end_turn"),
      );
      const agentResultRaw =
        inner.agent_result ?? inner.agentResult ?? undefined;
      const agentResult =
        typeof agentResultRaw === "string"
          ? agentResultRaw.trim()
          : agentResultRaw != null
            ? String(agentResultRaw).trim()
            : undefined;
      // Title without elapsed; reducer applies last-user → now wall-clock.
      return {
        kind: "event",
        title: formatTurnCompletedTitle(stop),
        detail: formatTurnCompletedDetail(
          stop,
          agentResult || undefined,
        ),
        turnStopReason: stop,
      };
    }
    case "session_recap": {
      const summary = String(inner.summary ?? "").trim();
      const auto = inner.auto === true;
      return {
        kind: "event",
        title: auto ? "Recap (auto)" : "Recap",
        detail: summary || undefined,
      };
    }
    case "auto_compact_completed": {
      const before = numField(inner, "tokensBefore", "tokens_before");
      const after = numField(inner, "tokensAfter", "tokens_after");
      const preview =
        typeof inner.summary_preview === "string"
          ? inner.summary_preview
          : typeof inner.summaryPreview === "string"
            ? (inner.summaryPreview as string)
            : undefined;
      return {
        kind: "event",
        title: "Context compacted",
        detail:
          before > 0
            ? `${formatTokensShort(before)} → ${formatTokensShort(after)} tokens${preview ? `\n${preview}` : ""}`
            : after > 0
              ? `→ ${formatTokensShort(after)} tokens${preview ? `\n${preview}` : ""}`
              : preview,
      };
    }
    case "compaction_checkpoint": {
      const id = String(
        inner.checkpoint_id ?? inner.checkpointId ?? "",
      ).slice(0, 8);
      const idx =
        inner.prompt_index_at_compaction ?? inner.promptIndexAtCompaction;
      return {
        kind: "event",
        title: id ? `Compaction checkpoint · ${id}…` : "Compaction checkpoint",
        detail: typeof idx === "number" ? `At prompt index ${idx}` : undefined,
        hidden: true,
      };
    }
    case "rewind_marker": {
      const idx = inner.target_prompt_index ?? inner.targetPromptIndex;
      return {
        kind: "event",
        title: "Rewind marker",
        detail: typeof idx === "number" ? `Target prompt index ${idx}` : undefined,
        hidden: true,
      };
    }
    case "available_commands_update": {
      const raw = inner.availableCommands ?? inner.available_commands;
      const commands = parseAvailableCommands(raw);
      return {
        kind: "commands",
        title: "available_commands_update",
        availableCommands: commands,
      };
    }
    case "FileWritten": {
      const inner = params as Record<string, unknown>;
      const path = (inner.path as string) ?? (inner.file_path as string) ?? "";
      const content = (inner.content as string) ?? "";
      const previous = (inner.previous_content as string) ?? (inner.previousContent as string) ?? "";
      const isNew = inner.is_new_file === true || inner.isNewFile === true;
      const title = isNew ? `Created file: ${path}` : `Modified file: ${path}`;
      let detail = content || undefined;
      if (previous) {
        detail = `Previous:\n${previous}\n\nCurrent:\n${content}`;
      }
      return {
        kind: "event",
        title,
        detail,
      };
    }
    // Subagent / bg-task lifecycle on session/update or disk hydrate.
    // Same parser as agent-notification; bare update object is enough.
    case "subagent_spawned":
    case "subagent_progress":
    case "subagent_finished":
    case "task_backgrounded":
    case "task_completed": {
      const lifecycle = describeLifecycleNotification(null, inner);
      if (lifecycle) return lifecycle;
      return { kind: "event", title: sessionUpdate };
    }
    default: {
      const type = (u.type as string) || sessionUpdate;
      // Noise phase/events — skip empty ones in the listener
      return {
        kind: "event",
        title: type,
        detail:
          (inner.phase as string) ||
          (u.phase as string) ||
          (inner.model_id as string) ||
          (u.model_id as string) ||
          undefined,
      };
    }
  }
}

function parseAvailableCommands(raw: unknown): AvailableCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: AvailableCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? "").trim().replace(/^\//, "");
    if (!name) continue;
    const description = String(o.description ?? "").trim();
    const input = o.input as { hint?: string } | undefined;
    const inputHint =
      (typeof input?.hint === "string" && input.hint) ||
      (typeof o.inputHint === "string" ? o.inputHint : undefined) ||
      (typeof o.input_hint === "string" ? o.input_hint : undefined);
    out.push({ name, description, inputHint: inputHint || undefined });
  }
  return out;
}
