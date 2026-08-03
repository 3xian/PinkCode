/**
 * Grok Build session-event wording for the Timeline.
 *
 * Owns the x.ai `session/update` variants Grok Build renders in scrollback as
 * `SessionEvent` lines (compaction / retry / image / model / goal / hook
 * milestones) and the variants it deliberately keeps out (dedicated panes,
 * persist-only markers, state-only signals). Wording mirrors
 * `xai-grok-pager/src/scrollback/blocks/session_event.rs`.
 *
 * Kept free of imports from `./format` (format.ts imports this module), so
 * every helper it needs lives here.
 */

/**
 * x.ai session/update variants Grok Build never shows in scrollback (they are
 * persist-only, state-only, or rendered by dedicated panes/modals instead).
 * Keeping them out of the Timeline avoids raw protocol-name cards.
 */
const GROK_NO_SCROLLBACK_XAI_UPDATES: Record<string, true> = {
  // ACP control plane (mode chip owns this state).
  current_mode_update: true,
  // Persist-only bookkeeping (replay markers, session storage).
  compaction_checkpoint: true,
  rewind_marker: true,
  // Dedicated panes / modals in Grok Build (workflow blocks, memory browser,
  // tasks pane) — not conversation-scrollback lines.
  workflow_updated: true,
  memory_flush_started: true,
  memory_flush_completed: true,
  memory_dream_completed: true,
  memory_session_saved: true,
  memory_files: true,
  scheduled_task_created: true,
  scheduled_task_fired: true,
  scheduled_task_deleted: true,
  monitor_event: true,
  pending_interaction: true,
  interaction_resolved: true,
  // State-only / advisory signals.
  auto_continue_completed: true,
  session_recap_unavailable: true,
  session_summary_generated: true,
  tool_call_delta_chunk: true,
  hook_execution: true,
  hooks_changed: true,
  plugins_changed: true,
  plugin_updates_installed: true,
  feedback_request: true,
  relay_sync_status: true,
  auto_recovery_started: true,
  auto_recovery_exhausted: true,
  diff_review: true,
  model_changed: true,
};

/** Timeline description shape for event-kind session updates. */
export interface SessionEventDescription {
  kind: "event";
  title: string;
  detail?: string;
  hidden?: boolean;
  /**
   * When set, the timeline reducer is the sole owner of the final title and
   * applies wall-clock elapsed since the last user card (Grok Build "Worked for …").
   */
  turnStopReason?: string;
  /** Goal id for the "Goal complete" milestone; the reducer emits it once. */
  goalId?: string;
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

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
 * Grok `format_duration(Duration)` — compact, no spaces ("1h2m", "5m30s").
 * Used for the "Goal complete — … end-to-end." milestone line.
 */
function formatGrokDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 10) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins}m${secs}s`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h${remainingMins}m`;
}

/** Whether a retry failure is a recoverable auth error (Grok is_reauthable_failure). */
function isReauthableRetry(errorType: string, message: string): boolean {
  return errorType === "auth" || message.includes("Unauthorized (401)");
}

/**
 * Parse one x.ai session event into a Timeline description.
 * Returns `null` for sessionUpdate values owned elsewhere (ACP stream core,
 * tool calls, lifecycle notifications).
 */
export function describeSessionEvent(
  sessionUpdate: string,
  inner: Record<string, unknown>,
): SessionEventDescription | null {
  // Own-key check: a plain Record inherits Object.prototype, so lookups like
  // `record["toString"]` would be truthy for a protocol type named after a
  // built-in. Only own keys are session-update names.
  if (Object.prototype.hasOwnProperty.call(GROK_NO_SCROLLBACK_XAI_UPDATES, sessionUpdate)) {
    return { kind: "event", title: sessionUpdate, hidden: true };
  }

  switch (sessionUpdate) {
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
    case "auto_compact_started": {
      const percentage = numField(inner, "percentage", "percentage");
      return {
        kind: "event",
        title: `Context ${percentage}% full. Compacting…`,
      };
    }
    case "auto_compact_completed": {
      const before = numField(inner, "tokensBefore", "tokens_before");
      const after = numField(inner, "tokensAfter", "tokens_after");
      const elapsedMs = numField(inner, "elapsedMs", "elapsed_ms");
      const preview =
        typeof inner.summary_preview === "string"
          ? inner.summary_preview
          : typeof inner.summaryPreview === "string"
            ? (inner.summaryPreview as string)
            : undefined;
      let detail = "";
      if (before > 0) {
        detail = `${formatTokensShort(before)} → ${formatTokensShort(after)} tokens`;
      } else if (after > 0) {
        detail = `→ ${formatTokensShort(after)} tokens`;
      }
      if (detail && elapsedMs > 0) {
        detail += ` (${(elapsedMs / 1000).toFixed(1)}s)`;
      }
      if (preview) {
        detail = detail ? `${detail}\n${preview}` : preview;
      }
      return {
        kind: "event",
        title: "Context compacted",
        detail: detail || undefined,
      };
    }
    case "auto_compact_failed": {
      const error = String(inner.error ?? "").trim();
      return {
        kind: "event",
        title: error ? `Compaction failed: ${error}` : "Compaction failed.",
      };
    }
    case "auto_compact_cancelled": {
      return { kind: "event", title: "Compaction cancelled." };
    }
    case "retry_state": {
      const retryType = String(inner.type ?? "").trim().toLowerCase();
      // `retrying` is turn-activity state in Grok Build, never a scrollback line.
      if (retryType === "retrying") {
        return { kind: "event", title: "Retrying", hidden: true };
      }
      const reason = String(inner.reason ?? "").trim();
      const message = String(inner.message ?? "").trim();
      const attempts = numField(inner, "attempts", "attempts");
      const isRateLimited =
        inner.is_rate_limited === true || inner.isRateLimited === true;
      const errorType = String(
        inner.error_type ?? inner.errorType ?? "",
      )
        .trim()
        .toLowerCase();
      if (isReauthableRetry(errorType, reason) || isReauthableRetry(errorType, message)) {
        return {
          kind: "event",
          title: "Authentication required",
          detail:
            "Your session has expired or your credentials were rejected. " +
            "Run /login to re-authenticate, then resend your message.",
        };
      }
      if (retryType === "exhausted") {
        if (isRateLimited) {
          return {
            kind: "event",
            title: "Rate limited",
            detail: reason || undefined,
          };
        }
        return {
          kind: "event",
          title: `Retry failed: failed after ${attempts} retries: ${reason || "unknown error"}`,
        };
      }
      if (errorType === "encrypted_content_mismatch") {
        return {
          kind: "event",
          title: "Conversation incompatible with current model",
          detail:
            "This session's conversation history is incompatible with the " +
            "current model. Please start a new session.",
        };
      }
      if (errorType === "context_length") {
        return {
          kind: "event",
          title: "Context too large",
          detail:
            "This conversation is too large for the model's context window. " +
            "Use /new to start a new session.",
        };
      }
      return {
        kind: "event",
        title: `Retry failed: ${message || "unknown error"}`,
      };
    }
    case "image_dropped": {
      const notes = Array.isArray(inner.notes)
        ? inner.notes.map((n) => String(n)).filter((n) => n.trim().length > 0)
        : [];
      if (notes.length === 0) {
        return { kind: "event", title: "Images dropped", hidden: true };
      }
      return {
        kind: "event",
        title: notes.join("\n"),
      };
    }
    case "image_compressed": {
      // Successful compression is log-only in Grok Build; only the re-encode
      // fallback (no images kept) surfaces a scrollback warning.
      const images = Array.isArray(inner.images) ? inner.images : [];
      if (images.length > 0) {
        return { kind: "event", title: "Images compressed", hidden: true };
      }
      const message = String(inner.message ?? "").trim();
      return {
        kind: "event",
        title: message || "Image compression fallback",
        hidden: !message,
      };
    }
    case "model_auto_switched": {
      const reason = String(inner.reason ?? "").trim();
      const newModelId = String(inner.new_model_id ?? inner.newModelId ?? "")
        .trim();
      const title = newModelId
        ? `${reason} Switched to "${newModelId}".`
        : reason || "Model auto-switched";
      return { kind: "event", title };
    }
    case "goal_updated": {
      const status = String(inner.status ?? "").toLowerCase();
      if (status !== "complete") {
        return { kind: "event", title: "Goal updated", hidden: true };
      }
      const elapsedMs = numField(inner, "elapsedMs", "elapsed_ms");
      const goalId = String(inner.goal_id ?? inner.goalId ?? "").trim();
      return {
        kind: "event",
        goalId: goalId || undefined,
        title: `Goal complete — ${formatGrokDuration(elapsedMs)} end-to-end.`,
      };
    }
    case "hook_annotation": {
      const message = String(inner.message ?? "").trim();
      return {
        kind: "event",
        title: message || "Hook annotation",
        hidden: !message,
      };
    }
    default:
      return null;
  }
}
