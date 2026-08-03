import { describe, expect, it } from "vitest";
import { describeUpdate } from "./format";
// Turn-terminal formatter unit tests live in sessionEvents.test.ts (the owning
// module); format.ts re-exports them for callers.

describe("describeUpdate turn_completed", () => {
  it("does not surface end_turn in the title; leaves elapsed to the reducer", () => {
    const desc = describeUpdate({
      sessionUpdate: "turn_completed",
      stop_reason: "end_turn",
      usage: {
        totalTokens: 12400,
        inputTokens: 10100,
        outputTokens: 2300,
        model_calls: 7,
      },
    });
    expect(desc.kind).toBe("event");
    expect(desc.title).toBe("Turn completed");
    expect(desc.title).not.toMatch(/end_turn/);
    expect(desc.turnStopReason).toBe("end_turn");
    expect(desc.detail).toBeUndefined();
  });

  it("surfaces agent_result on error", () => {
    const desc = describeUpdate({
      sessionUpdate: "turn_completed",
      stop_reason: "error",
      agent_result: "connection reset",
    });
    expect(desc.title).toBe("Turn failed");
    expect(desc.turnStopReason).toBe("error");
    expect(desc.detail).toBe("connection reset");
  });

  it("hints max_tokens in detail only", () => {
    const desc = describeUpdate({
      sessionUpdate: "turn_completed",
      stopReason: "max_tokens",
    });
    expect(desc.title).toBe("Turn completed");
    expect(desc.turnStopReason).toBe("max_tokens");
    expect(desc.detail).toBe("Hit output token limit");
  });

  it("ignores wire elapsed fields (timeline owns duration)", () => {
    const desc = describeUpdate({
      sessionUpdate: "turn_completed",
      stop_reason: "end_turn",
      elapsed_ms: 42_500,
    });
    expect(desc.title).toBe("Turn completed");
    expect(desc.turnStopReason).toBe("end_turn");
  });
});

describe("describeUpdate Grok Build scrollback parity", () => {
  it("hides plan and persistence-only timeline markers", () => {
    expect(
      describeUpdate({ sessionUpdate: "plan", entries: [] }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "compaction_checkpoint",
        checkpoint_id: "checkpoint",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "rewind_marker",
        target_prompt_index: 2,
      }).hidden,
    ).toBe(true);
  });

  it("hides control-plane tools but keeps normal tools", () => {
    expect(
      describeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-todo",
        title: "todo_write",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-wait",
        title: "wait_commands_or_subagents",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-kill",
        title: "kill_command_or_subagent",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-read",
        title: "Read `src/main.ts`",
      }).hidden,
    ).toBe(false);
  });

  it("uses Grok Build recap and compaction wording", () => {
    expect(
      describeUpdate({
        sessionUpdate: "session_recap",
        summary: "Where we left off",
      }),
    ).toMatchObject({ title: "Recap", detail: "Where we left off" });
    expect(
      describeUpdate({
        sessionUpdate: "auto_compact_completed",
        tokens_before: 12_000,
        tokens_after: 4_000,
      }),
    ).toMatchObject({
      title: "Context compacted",
      detail: "12.0k → 4.0k tokens",
    });
    expect(
      describeUpdate({
        sessionUpdate: "auto_compact_completed",
        tokens_after: 4_000,
      }),
    ).toMatchObject({
      title: "Context compacted",
      detail: "→ 4.0k tokens",
    });
  });

  it("renders compaction lifecycle markers with Grok Build wording", () => {
    expect(
      describeUpdate({
        sessionUpdate: "auto_compact_started",
        percentage: 85,
      }),
    ).toMatchObject({ title: "Context 85% full. Compacting…" });
    expect(
      describeUpdate({
        sessionUpdate: "auto_compact_failed",
        error: "disk full",
      }),
    ).toMatchObject({ title: "Compaction failed: disk full" });
    expect(
      describeUpdate({ sessionUpdate: "auto_compact_failed", error: "" }),
    ).toMatchObject({ title: "Compaction failed." });
    expect(
      describeUpdate({ sessionUpdate: "auto_compact_cancelled" }),
    ).toMatchObject({ title: "Compaction cancelled." });
    // Elapsed rides the Grok Build "…tokens (0.5s)" suffix.
    expect(
      describeUpdate({
        sessionUpdate: "auto_compact_completed",
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
    // Retrying is turn-activity state, not a scrollback line.
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "retrying",
        attempt: 1,
        max_retries: 3,
        reason: "connection timeout",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "exhausted",
        attempts: 3,
        reason: "connection timeout",
      }),
    ).toMatchObject({
      title: "Retry failed: failed after 3 retries: connection timeout",
    });
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "exhausted",
        attempts: 3,
        reason: "slow down",
        is_rate_limited: true,
      }),
    ).toMatchObject({ title: "Rate limited", detail: "slow down" });
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "failed",
        error_type: "auth",
        message: "bad token",
      }),
    ).toMatchObject({ title: "Authentication required" });
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "failed",
        error_type: "context_length",
        message: "too big",
      }),
    ).toMatchObject({ title: "Context too large" });
    expect(
      describeUpdate({
        sessionUpdate: "retry_state",
        type: "failed",
        error_type: "api_400",
        message: "bad request",
      }),
    ).toMatchObject({ title: "Retry failed: bad request" });
  });

  it("renders image / model / goal / hook milestones Grok Build shows", () => {
    expect(
      describeUpdate({
        sessionUpdate: "image_dropped",
        notes: ["image_2.png (2.1 MB) exceeds the 20 MB limit"],
      }),
    ).toMatchObject({
      title: "image_2.png (2.1 MB) exceeds the 20 MB limit",
    });
    expect(
      describeUpdate({
        sessionUpdate: "image_dropped",
        notes: [],
      }).hidden,
    ).toBe(true);
    // Successful compression is invisible; only the re-encode fallback warns.
    expect(
      describeUpdate({
        sessionUpdate: "image_compressed",
        images: [{ index: 0, original_bytes: 10 }],
        message: "resized",
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "image_compressed",
        images: [],
        message: "Kept original image",
      }),
    ).toMatchObject({ title: "Kept original image" });
    expect(
      describeUpdate({
        sessionUpdate: "model_auto_switched",
        previous_model_id: "grok-4.5",
        new_model_id: "grok-build",
        reason: "Model \"grok-4.5\" is no longer available.",
      }),
    ).toMatchObject({
      title: 'Model "grok-4.5" is no longer available. Switched to "grok-build".',
    });
    expect(
      describeUpdate({
        sessionUpdate: "goal_updated",
        goal_id: "g1",
        status: "active",
        elapsed_ms: 330_000,
      }).hidden,
    ).toBe(true);
    expect(
      describeUpdate({
        sessionUpdate: "goal_updated",
        goal_id: "g1",
        status: "complete",
        elapsed_ms: 330_000,
      }),
    ).toMatchObject({
      title: "Goal complete — 5m30s end-to-end.",
      goalId: "g1",
    });
    expect(
      describeUpdate({ sessionUpdate: "hook_annotation", message: "Running hooks" }),
    ).toMatchObject({ title: "Running hooks" });
  });

  it("wires edit-tool diffs into the tool card detail", () => {
    expect(
      describeUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-edit-1",
        title: "Edit `src/main.ts`",
        kind: "Edit",
        status: "completed",
        rawOutput: {
          type: "SearchReplace",
          EditsApplied: {
            edits: {
              details: [
                {
                  old_string: "let x = 1;",
                  new_string: "let x = 2;",
                  old_line: 5,
                  new_line: 5,
                  context_before: "fn main() {\n",
                  context_after: "}",
                },
              ],
            },
          },
        },
      }),
    ).toMatchObject({
      kind: "tool",
      title: expect.stringContaining("Edit `src/main.ts`"),
      detail: expect.stringContaining("@@ -4,3 +4,3 @@"),
      isEdit: true,
    });
  });

  it("flags non-edit tool cards as not diffs", () => {
    expect(
      describeUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-read-1",
        title: "Read `src/a.ts`",
        kind: "Read",
        status: "completed",
        rawOutput: { type: "ReadFile", content: ["no diff here"] },
      }),
    ).toMatchObject({ kind: "tool", isEdit: false });
  });

  it("parses x.ai updates from the updates.jsonl envelope", () => {
    // Disk lines and live notifications wrap the update in
    // { params: { session_id, update: { sessionUpdate, … }, _meta } }.
    const diskLine = (update: unknown) =>
      describeUpdate({
        method: "_x.ai/session/update",
        params: {
          session_id: "sess-1",
          update,
          _meta: { eventId: "evt-1" },
        },
      });
    expect(
      diskLine({ sessionUpdate: "auto_compact_started", percentage: 71 }),
    ).toMatchObject({ title: "Context 71% full. Compacting…" });
    expect(
      diskLine({
        sessionUpdate: "model_auto_switched",
        new_model_id: "grok-build",
        reason: "Model \"grok-4.5\" is no longer available.",
      }),
    ).toMatchObject({
      title: 'Model "grok-4.5" is no longer available. Switched to "grok-build".',
    });
    expect(
      diskLine({ sessionUpdate: "workflow_updated", status: "running" }).hidden,
    ).toBe(true);
  });

  it("hides x.ai updates Grok Build keeps out of scrollback", () => {
    for (const sessionUpdate of [
      "current_mode_update",
      "workflow_updated",
      "memory_flush_started",
      "memory_flush_completed",
      "memory_dream_completed",
      "memory_session_saved",
      "scheduled_task_created",
      "scheduled_task_fired",
      "scheduled_task_deleted",
      "monitor_event",
      "session_recap_unavailable",
      "auto_continue_completed",
      "tool_call_delta_chunk",
      "hook_execution",
      "model_changed",
      "auto_recovery_started",
      "diff_review",
    ]) {
      expect(
        describeUpdate({ sessionUpdate }).hidden,
        `${sessionUpdate} must be hidden`,
      ).toBe(true);
    }
  });

  it("drops control-plane x.ai extension notifications", () => {
    for (const method of [
      // Both transports: `x.ai/…` and `_x.ai/…`.
      "_x.ai/mcp/servers_updated",
      "_x.ai/models/update",
      "_x.ai/settings/update",
      "_x.ai/announcements/update",
      "_x.ai/mcp_initialized",
      "x.ai/mcp/init_progress",
      "x.ai/mcp/tools_changed",
      "x.ai/mcp/servers_updated",
      "x.ai/sessions/changed",
      "x.ai/queue/changed",
      "x.ai/git_head_changed",
      "x.ai/session/prompt_complete",
      "x.ai/scheduled_task_created",
      "x.ai/follow_ups",
      "x.ai/monitor_event",
    ]) {
      expect(
        describeUpdate({ method, params: {} }).hidden,
        `${method} must be hidden`,
      ).toBe(true);
    }
  });

  it("keeps rendered extension notifications and non-x.ai unknowns", () => {
    // Lifecycle notifications resolve via their inner update.sessionUpdate.
    expect(
      describeUpdate({
        method: "x.ai/session_notification",
        params: {
          sessionId: "parent-1",
          update: {
            sessionUpdate: "subagent_spawned",
            child_session_id: "child-1",
          },
        },
      }),
    ).toMatchObject({ kind: "subagent" });
    // Unknown methods outside the x.ai namespace keep the legacy fallback.
    expect(
      describeUpdate({ method: "acme.custom/thing", params: {} }).hidden,
    ).toBeUndefined();
  });
});
