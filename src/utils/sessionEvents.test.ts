import { describe, expect, it } from "vitest";
import {
  describeSessionEvent,
  formatTurnCompletedTitle,
  formatTurnElapsed,
  normalizeStopReason,
} from "./sessionEvents";

describe("turn terminal formatters", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatTurnElapsed(1_200)).toBe("1.2s");
    expect(formatTurnElapsed(9_900)).toBe("9.9s");
    expect(formatTurnElapsed(59_000)).toBe("59.0s");
  });

  it("formats minutes and hours", () => {
    expect(formatTurnElapsed(90_000)).toBe("1m 30s");
    expect(formatTurnElapsed(120_000)).toBe("2m");
    expect(formatTurnElapsed(3_600_000)).toBe("1h");
    expect(formatTurnElapsed(3_720_000)).toBe("1h 2m");
  });

  it("hides protocol end_turn on the happy path", () => {
    expect(formatTurnCompletedTitle("end_turn")).toBe("Turn completed");
    expect(formatTurnCompletedTitle("end_turn", 12_300)).toBe("Worked for 12.3s");
  });

  it("maps cancelled / error / rate_limit / max_tokens", () => {
    expect(formatTurnCompletedTitle("cancelled", 5_200)).toBe(
      "Turn cancelled by user in 5.2s",
    );
    expect(formatTurnCompletedTitle("error", 3_100)).toBe("Turn failed in 3.1s");
    expect(formatTurnCompletedTitle("rate_limit")).toBe("Rate limited");
    expect(formatTurnCompletedTitle("max_tokens", 40_000)).toBe(
      "Worked for 40.0s",
    );
    expect(normalizeStopReason("rate-limit")).toBe("rate_limit");
  });
});

describe("describeSessionEvent", () => {
  it("returns null for updates owned elsewhere", () => {
    expect(describeSessionEvent("agent_message_chunk", {})).toBeNull();
    expect(describeSessionEvent("tool_call", {})).toBeNull();
    expect(describeSessionEvent("subagent_spawned", {})).toBeNull();
    expect(describeSessionEvent("bogus_update", {})).toBeNull();
  });

  it("hides the Grok-scrollback-noise set", () => {
    for (const sessionUpdate of [
      "current_mode_update",
      "compaction_checkpoint",
      "rewind_marker",
      "workflow_updated",
      "memory_flush_started",
      "memory_dream_completed",
      "scheduled_task_created",
      "monitor_event",
      "session_recap_unavailable",
      "auto_continue_completed",
      "tool_call_delta_chunk",
      "hook_execution",
      "model_changed",
      "diff_review",
    ]) {
      const desc = describeSessionEvent(sessionUpdate, {});
      expect(desc?.hidden, sessionUpdate).toBe(true);
    }
  });

  it("renders compaction lifecycle markers with Grok Build wording", () => {
    expect(
      describeSessionEvent("auto_compact_started", { percentage: 85 }),
    ).toMatchObject({ title: "Context 85% full. Compacting…" });
    expect(
      describeSessionEvent("auto_compact_failed", { error: "disk full" }),
    ).toMatchObject({ title: "Compaction failed: disk full" });
    expect(
      describeSessionEvent("auto_compact_cancelled", {}),
    ).toMatchObject({ title: "Compaction cancelled." });
    expect(
      describeSessionEvent("auto_compact_completed", {
        tokens_before: 12_000,
        tokens_after: 4_000,
        elapsed_ms: 500,
      }),
    ).toMatchObject({
      title: "Context compacted",
      detail: "12.0k → 4.0k tokens (0.5s)",
    });
  });

  it("maps retry_state outcomes like Grok Build session events", () => {
    expect(
      describeSessionEvent("retry_state", {
        type: "retrying",
        reason: "connection timeout",
      })?.hidden,
    ).toBe(true);
    expect(
      describeSessionEvent("retry_state", {
        type: "exhausted",
        attempts: 3,
        reason: "connection timeout",
      }),
    ).toMatchObject({
      title: "Retry failed: failed after 3 retries: connection timeout",
    });
    expect(
      describeSessionEvent("retry_state", {
        type: "exhausted",
        attempts: 3,
        reason: "slow down",
        is_rate_limited: true,
      }),
    ).toMatchObject({ title: "Rate limited", detail: "slow down" });
    expect(
      describeSessionEvent("retry_state", {
        type: "failed",
        error_type: "auth",
        message: "bad token",
      }),
    ).toMatchObject({ title: "Authentication required" });
    expect(
      describeSessionEvent("retry_state", {
        type: "failed",
        error_type: "context_length",
        message: "too big",
      }),
    ).toMatchObject({ title: "Context too large" });
    expect(
      describeSessionEvent("retry_state", {
        type: "failed",
        error_type: "api_400",
        message: "bad request",
      }),
    ).toMatchObject({ title: "Retry failed: bad request" });
  });

  it("renders image / model / goal / hook milestones Grok Build shows", () => {
    expect(
      describeSessionEvent("image_dropped", {
        notes: ["image_2.png (2.1 MB) exceeds the 20 MB limit"],
      }),
    ).toMatchObject({
      title: "image_2.png (2.1 MB) exceeds the 20 MB limit",
    });
    expect(
      describeSessionEvent("model_auto_switched", {
        previous_model_id: "grok-4.5",
        new_model_id: "grok-build",
        reason: "Model \"grok-4.5\" is no longer available.",
      }),
    ).toMatchObject({
      title: 'Model "grok-4.5" is no longer available. Switched to "grok-build".',
    });
    expect(
      describeSessionEvent("goal_updated", {
        goal_id: "g1",
        status: "active",
        elapsed_ms: 330_000,
      })?.hidden,
    ).toBe(true);
    // Grok format_duration: compact, no spaces.
    expect(
      describeSessionEvent("goal_updated", {
        goal_id: "g1",
        status: "complete",
        elapsed_ms: 330_000,
      }),
    ).toMatchObject({
      title: "Goal complete — 5m30s end-to-end.",
      goalId: "g1",
    });
    expect(
      describeSessionEvent("hook_annotation", { message: "Running hooks" }),
    ).toMatchObject({ title: "Running hooks" });
  });

  it("carries turn_completed stop reason for the reducer", () => {
    expect(
      describeSessionEvent("turn_completed", { stop_reason: "error" }),
    ).toMatchObject({
      title: "Turn failed",
      turnStopReason: "error",
    });
  });
});
