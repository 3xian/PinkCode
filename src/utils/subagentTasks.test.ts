import { describe, expect, it } from "vitest";
import { describeUpdate, isGrokScrollbackSuppressedTool } from "./format";
import {
  SUBAGENT_MAX_DEPTH,
  describeLifecycleNotification,
  describeListedSubagent,
  describeListedTask,
  describePendingInteractionNotification,
  formatSubagentTitle,
  isBgPlumbingTool,
  lifecycleFromListSubagents,
  lifecycleFromListTasks,
  lifecycleMirrorKey,
  listActiveBgTasks,
  listActiveSubagents,
  mergeSubagentPayload,
} from "./subagentTasks";
import type { TimelineItem, TimelineSubagentPayload } from "../types";
import {
  createTimelineReducerState,
  mergeTimelineItems,
  reduceAgentUpdate,
} from "../hooks/liveTimeline";
import { DISK_HANDLE_ID } from "../hooks/liveTimeline";

function baseSub(over: Partial<TimelineSubagentPayload> = {}): TimelineSubagentPayload {
  return {
    subagentId: "sa-1",
    childSessionId: "child-1",
    description: "scan src/",
    subagentType: "explore",
    isBackground: true,
    depth: SUBAGENT_MAX_DEPTH,
    maxDepth: SUBAGENT_MAX_DEPTH,
    status: "running",
    ...over,
  };
}

describe("bg plumbing tool suppression (Grok Build parity)", () => {
  it("suppresses WaitTasks / KillTask / TaskOutput tools", () => {
    for (const title of [
      "wait_commands_or_subagents",
      "kill_command_or_subagent",
      "get_command_or_subagent_output",
      "wait_tasks",
      "kill_task",
      "get_task_output",
    ]) {
      expect(isBgPlumbingTool({ title }), title).toBe(true);
      expect(isGrokScrollbackSuppressedTool({ title }), title).toBe(true);
      expect(
        describeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: `call-${title}`,
          title,
        }).hidden,
      ).toBe(true);
    }
  });

  it("suppresses by rawInput.variant", () => {
    expect(
      isBgPlumbingTool({
        title: "other",
        rawInput: { variant: "WaitTasks" },
      }),
    ).toBe(true);
    expect(
      isGrokScrollbackSuppressedTool({
        title: "other",
        rawInput: { variant: "KillTask" },
      }),
    ).toBe(true);
  });

  it("keeps normal tools visible", () => {
    expect(isBgPlumbingTool({ title: "Read `src/main.ts`" })).toBe(false);
    expect(
      isGrokScrollbackSuppressedTool({
        title: "Read `src/main.ts`",
      }),
    ).toBe(false);
  });

  it("still suppresses spawn_subagent (TaskTool) — SubagentBlock owns UI", () => {
    expect(isGrokScrollbackSuppressedTool({ title: "spawn_subagent" })).toBe(
      true,
    );
    expect(
      isGrokScrollbackSuppressedTool({
        title: "Task",
        rawInput: { variant: "Task" },
      }),
    ).toBe(true);
  });
});

describe("subagent lifecycle notifications", () => {
  it("parses subagent_spawned with hierarchy depth 1", () => {
    const desc = describeLifecycleNotification("x.ai/session_notification", {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "sa-1",
        parent_session_id: "parent-1",
        child_session_id: "child-1",
        subagent_type: "explore",
        description: "scan src/",
        model: "grok-4.5",
      },
    });
    expect(desc).not.toBeNull();
    expect(desc!.kind).toBe("subagent");
    expect(desc!.mergeKey).toBe("child-1");
    expect(desc!.title).toBe('Subagent started: "scan src/"');
    expect(desc!.subagent).toMatchObject({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      subagentType: "explore",
      depth: SUBAGENT_MAX_DEPTH,
      maxDepth: SUBAGENT_MAX_DEPTH,
      status: "running",
    });
    // No toolCallId abuse
    expect(
      (desc as { toolCallId?: string }).toolCallId,
    ).toBeUndefined();
    expect(desc!.detail).toContain("depth 1/1");
  });

  it("honors is_background: false on spawn", () => {
    const desc = describeLifecycleNotification("x.ai/session_notification", {
      update: {
        sessionUpdate: "subagent_spawned",
        child_session_id: "child-sync",
        description: "inline work",
        is_background: false,
      },
    });
    expect(desc!.subagent?.isBackground).toBe(false);
    expect(desc!.title).toBe('Subagent "inline work"');
  });

  it("progress patches are sparse (no default description/type)", () => {
    const progress = describeLifecycleNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "subagent_progress",
          child_session_id: "child-1",
          duration_ms: 1500,
          tool_call_count: 3,
          activity_label: "Reading files",
        },
      },
    )!;
    expect(progress.subagent).toEqual({
      childSessionId: "child-1",
      status: "running",
      activityLabel: "Reading files",
      durationMs: 1500,
      toolCalls: 3,
    });
    expect(progress.subagent).not.toHaveProperty("description");
    expect(progress.subagent).not.toHaveProperty("subagentType");
  });

  it("progress without activity_label does not clear previous activity", () => {
    const state = createTimelineReducerState();
    let map = new Map<string, TimelineItem[]>();
    const nextId = () => "id";

    const spawn = describeLifecycleNotification("x.ai/session_notification", {
      update: {
        sessionUpdate: "subagent_spawned",
        child_session_id: "child-act",
        description: "work",
        subagent_type: "explore",
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "p",
        description: spawn,
        now: 1,
        nextId,
      },
      state,
    );

    const withActivity = describeLifecycleNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "subagent_progress",
          child_session_id: "child-act",
          activity_label: "Reading files",
          tool_call_count: 1,
        },
      },
    )!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "p",
        description: withActivity,
        now: 2,
        nextId,
      },
      state,
    );
    expect(map.get("p")?.[0].subagent?.activityLabel).toBe("Reading files");

    // Metrics-only progress — must not wipe activity via forced null.
    const metricsOnly = describeLifecycleNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "subagent_progress",
          child_session_id: "child-act",
          duration_ms: 2000,
          tool_call_count: 2,
        },
      },
    )!;
    expect(metricsOnly.subagent).not.toHaveProperty("activityLabel");
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "p",
        description: metricsOnly,
        now: 3,
        nextId,
      },
      state,
    );
    const item = map.get("p")?.[0];
    expect(item?.subagent?.activityLabel).toBe("Reading files");
    expect(item?.subagent?.toolCalls).toBe(2);
    expect(item?.subagent?.durationMs).toBe(2000);
  });

  it("merges progress then finish onto one card without clobbering spawn fields", () => {
    const state = createTimelineReducerState();
    let map = new Map<string, TimelineItem[]>();
    let n = 0;
    const nextId = () => `id-${n++}`;

    const spawn = describeLifecycleNotification("x.ai/session_notification", {
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "sa-1",
        parent_session_id: "p",
        child_session_id: "child-1",
        subagent_type: "explore",
        description: "scan src/",
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "p",
        description: spawn,
        now: 1000,
        nextId,
      },
      state,
    );

    const progress = describeLifecycleNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "subagent_progress",
          subagent_id: "sa-1",
          child_session_id: "child-1",
          duration_ms: 1500,
          tool_call_count: 3,
          turn_count: 1,
          activity_label: "Reading files",
        },
      },
    )!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "p",
        description: progress,
        now: 2500,
        nextId,
      },
      state,
    );

    const afterProgress = map.get("p") ?? [];
    expect(afterProgress).toHaveLength(1);
    expect(afterProgress[0].subagent?.description).toBe("scan src/");
    expect(afterProgress[0].subagent?.subagentType).toBe("explore");
    expect(afterProgress[0].subagent?.activityLabel).toBe("Reading files");
    expect(afterProgress[0].toolCallId).toBeUndefined();

    const finish = describeLifecycleNotification("x.ai/session_notification", {
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: "sa-1",
        child_session_id: "child-1",
        status: "completed",
        duration_ms: 5000,
        tool_calls: 4,
        turns: 2,
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "p",
        description: finish,
        now: 6000,
        nextId,
      },
      state,
    );

    const items = map.get("p") ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("subagent");
    expect(items[0].id).toBe("subagent-child-1");
    expect(items[0].title).toBe('Subagent completed in 5.0s: "scan src/"');
    expect(items[0].subagent?.status).toBe("completed");
    expect(items[0].subagent?.toolCalls).toBe(4);
    expect(items[0].subagent?.description).toBe("scan src/");
    expect(items[0].subagent?.activityLabel).toBeNull();
    expect(listActiveSubagents(items)).toHaveLength(0);
  });

  it("formatSubagentTitle matches Grok SubagentBlock wording", () => {
    expect(
      formatSubagentTitle(
        baseSub({ description: "find bugs", status: "running" }),
      ),
    ).toBe('Subagent started: "find bugs"');
    expect(
      formatSubagentTitle(
        baseSub({
          description: "find bugs",
          status: "completed",
          durationMs: 43_000,
        }),
      ),
    ).toBe('Subagent completed in 43s: "find bugs"');
    expect(
      formatSubagentTitle(
        baseSub({
          description: "sync",
          isBackground: false,
          status: "completed",
        }),
      ),
    ).toBe('Subagent "sync"');
  });

  it("mergeSubagentPayload applies sparse patches only", () => {
    const spawned = mergeSubagentPayload(undefined, {
      childSessionId: "c1",
      description: "work",
      subagentType: "explore",
      status: "running",
      isBackground: true,
    });
    const progressed = mergeSubagentPayload(spawned, {
      childSessionId: "c1",
      toolCalls: 2,
      activityLabel: "reading",
    });
    expect(progressed.description).toBe("work");
    expect(progressed.subagentType).toBe("explore");
    expect(progressed.toolCalls).toBe(2);
    expect(progressed.activityLabel).toBe("reading");
  });
});

describe("background task notifications", () => {
  it("parses task_backgrounded and task_completed", () => {
    const started = describeLifecycleNotification("x.ai/task_backgrounded", {
      update: {
        sessionUpdate: "task_backgrounded",
        task_id: "bg-1",
        tool_call_id: "tc-1",
        command: "npm test",
        description: "run tests",
        cwd: "/tmp/proj",
      },
    });
    expect(started).toMatchObject({
      kind: "task",
      mergeKey: "bg-1",
      title: "Background task: run tests",
      task: {
        taskId: "bg-1",
        status: "running",
        isMonitor: false,
        command: "npm test",
      },
    });

    const done = describeLifecycleNotification("x.ai/task_completed", {
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "bg-1",
          command: "npm test",
          description: "run tests",
          exit_code: 0,
          status: "completed",
        },
      },
    });
    expect(done?.task?.status).toBe("done");
    expect(done?.title).toBe("Background task done: run tests");
  });

  it("detects monitor tasks", () => {
    const mon = describeLifecycleNotification("x.ai/task_backgrounded", {
      update: {
        sessionUpdate: "task_backgrounded",
        task_id: "mon-1",
        command: "tail -f log",
        monitor_description: "watch logs",
      },
    });
    expect(mon?.task?.isMonitor).toBe(true);
    expect(mon?.title).toBe("Monitor: watch logs");
  });

  it("merges task lifecycle and tracks active set", () => {
    const state = createTimelineReducerState();
    let map = new Map<string, TimelineItem[]>();
    let n = 0;
    const nextId = () => `t-${n++}`;

    const start = describeLifecycleNotification("x.ai/task_backgrounded", {
      update: {
        sessionUpdate: "task_backgrounded",
        task_id: "bg-9",
        command: "cargo build",
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "s",
        description: start,
        now: 1,
        nextId,
      },
      state,
    );
    expect(listActiveBgTasks(map.get("s") ?? [])).toHaveLength(1);

    const end = describeLifecycleNotification("x.ai/task_completed", {
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "bg-9",
          command: "cargo build",
          exit_code: 1,
          status: "failed",
        },
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "s",
        description: end,
        now: 2,
        nextId,
      },
      state,
    );
    const items = map.get("s") ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("task-bg-9");
    expect(items[0].task?.status).toBe("failed");
    expect(items[0].toolCallId).toBeUndefined();
    expect(listActiveBgTasks(items)).toHaveLength(0);
  });

  it("task_completed without command keeps spawn command via sparse merge", () => {
    const state = createTimelineReducerState();
    let map = new Map<string, TimelineItem[]>();
    const nextId = () => "x";

    const start = describeLifecycleNotification("x.ai/task_backgrounded", {
      update: {
        sessionUpdate: "task_backgrounded",
        task_id: "bg-sparse",
        command: "npm test",
        description: "tests",
      },
    })!;
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "s",
        description: start,
        now: 1,
        nextId,
      },
      state,
    );

    // Finish payload omits command/description (only status + exit).
    const end = describeLifecycleNotification("x.ai/task_completed", {
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "bg-sparse",
          exit_code: 0,
          status: "completed",
        },
      },
    })!;
    expect(end.task).not.toHaveProperty("command");
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h",
        sessionId: "s",
        description: end,
        now: 2,
        nextId,
      },
      state,
    );
    const item = map.get("s")?.[0];
    expect(item?.task?.command).toBe("npm test");
    expect(item?.task?.description).toBe("tests");
    expect(item?.title).toBe("Background task done: tests");
  });
});

describe("live/disk mirror keys for lifecycle cards", () => {
  it("lifecycleMirrorKey is stable across different sourceEventIds", () => {
    const live: TimelineItem = {
      id: "subagent-child-1",
      handleId: "live",
      sessionId: "p",
      kind: "subagent",
      title: "Subagent started",
      ts: 100,
      sourceEventId: "evt-progress",
      subagent: baseSub({ status: "running" }),
    };
    const disk: TimelineItem = {
      ...live,
      id: "disk-sub",
      handleId: DISK_HANDLE_ID,
      ts: 101,
      sourceEventId: "evt-spawn",
      subagent: baseSub({ status: "completed", durationMs: 5000 }),
      title: "Subagent completed",
    };
    expect(lifecycleMirrorKey(live)).toBe("subagent:child-1");
    expect(lifecycleMirrorKey(disk)).toBe("subagent:child-1");
    // Different sourceEventIds must still collapse to one card.
    expect(mergeTimelineItems([disk], [live])).toEqual([disk]);
  });

  it("dedupes task cards by taskId across live and disk", () => {
    const live: TimelineItem = {
      id: "task-bg-1",
      handleId: "live",
      sessionId: "s",
      kind: "task",
      title: "Background task: run",
      ts: 50,
      sourceEventId: "bg-start",
      task: {
        taskId: "bg-1",
        command: "npm test",
        isMonitor: false,
        status: "running",
      },
    };
    const disk: TimelineItem = {
      ...live,
      handleId: DISK_HANDLE_ID,
      ts: 60,
      sourceEventId: "bg-done",
      title: "Background task done: run",
      task: {
        taskId: "bg-1",
        command: "npm test",
        isMonitor: false,
        status: "done",
        exitCode: 0,
      },
    };
    expect(lifecycleMirrorKey(live)).toBe("task:bg-1");
    expect(mergeTimelineItems([live], [disk])).toEqual([disk]);
  });
});

describe("describeUpdate hydrate path", () => {
  it("parses bare subagent_spawned without faking method", () => {
    const desc = describeUpdate({
      sessionUpdate: "subagent_spawned",
      child_session_id: "c-hydrate",
      description: "from disk",
      subagent_type: "explore",
    });
    expect(desc.kind).toBe("subagent");
    expect(desc.mergeKey).toBe("c-hydrate");
    expect(desc.subagent?.description).toBe("from disk");
  });
});

describe("list_running / task/list parsers", () => {
  it("maps list_running camelCase DTO", () => {
    const d = describeListedSubagent({
      subagentId: "sa-9",
      childSessionId: "child-9",
      parentSessionId: "parent",
      description: "explore auth",
      subagentType: "explore",
      durationMs: 1200,
      toolCallCount: 3,
      turnCount: 2,
      tokensUsed: 400,
      toolsUsed: ["read_file", "grep"],
    });
    expect(d?.kind).toBe("subagent");
    expect(d?.mergeKey).toBe("child-9");
    expect(d?.subagent?.status).toBe("running");
    expect(d?.subagent?.activityLabel).toBe("Using read_file, grep");
  });

  it("skips completed tasks and maps outstanding ones", () => {
    expect(
      describeListedTask({
        task_id: "done-1",
        command: "echo hi",
        completed: true,
      }),
    ).toBeNull();

    const d = describeListedTask({
      task_id: "run-1",
      command: "npm test",
      description: "unit",
      cwd: "/tmp/p",
      completed: false,
      kind: "bash",
    });
    expect(d?.kind).toBe("task");
    expect(d?.mergeKey).toBe("run-1");
    expect(d?.task?.status).toBe("running");
    expect(d?.task?.command).toBe("npm test");
  });

  it("lifecycleFromList* filters empty/completed", () => {
    expect(
      lifecycleFromListSubagents({
        subagents: [{ subagentId: "a", childSessionId: "c1", description: "x" }],
      }),
    ).toHaveLength(1);
    expect(
      lifecycleFromListTasks({
        tasks: [
          { task_id: "t1", command: "ls", completed: false },
          { task_id: "t2", command: "x", completed: true },
        ],
      }),
    ).toHaveLength(1);
  });
});

describe("pending_interaction notifications", () => {
  it("parses pending_interaction and interaction_resolved", () => {
    const open = describePendingInteractionNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "pending_interaction",
          tool_call_id: "call-1",
          kind: "permission",
        },
      },
    );
    expect(open).toEqual({
      toolCallId: "call-1",
      kind: "permission",
      resolved: false,
    });

    const done = describePendingInteractionNotification(
      "x.ai/session_notification",
      {
        update: {
          sessionUpdate: "interaction_resolved",
          tool_call_id: "call-1",
        },
      },
    );
    expect(done).toEqual({
      toolCallId: "call-1",
      kind: "unknown",
      resolved: true,
    });
  });

  it("ignores unrelated methods", () => {
    expect(
      describePendingInteractionNotification("x.ai/task_backgrounded", {
        task_id: "t",
      }),
    ).toBeNull();
  });
});
