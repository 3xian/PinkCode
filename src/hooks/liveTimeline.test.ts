import { describe, expect, it } from "vitest";
import {
  DISK_HANDLE_ID,
  LOCAL_HANDLE_ID,
  capShellOutput,
  hydrateLiveFromDiskUpdates,
  mergeDiskLiveIntoMap,
  mergeTimelineItems,
  reduceAgentUpdate,
  reduceShellUpdate,
  settleStreamingItems,
  type ShellIndexes,
} from "./liveTimeline";
import type { TimelineItem } from "../types";

describe("live timeline reducer", () => {
  it("hydrates disk live items via shared reducers and coalesces chunks", () => {
    const updates = [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          },
        },
        timestamp: "2026-07-21T12:00:00Z",
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          },
        },
        timestamp: "2026-07-21T12:00:01Z",
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read file",
            status: "completed",
          },
        },
        timestamp: "2026-07-21T12:00:02Z",
      },
    ];
    const items = hydrateLiveFromDiskUpdates(updates, "sess-1");
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("agent");
    expect(items[0].detail).toBe("Hello world");
    expect(items[0].handleId).toBe(DISK_HANDLE_ID);
    expect(items[0].streaming).toBe(false);
    expect(items[1].kind).toBe("tool");
    expect(items[1].title).toContain("Read file");
  });

  it("does not apply the live-stream item cap to paged disk history", () => {
    const updates = Array.from({ length: 450 }, (_, index) => ({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${index}`,
          title: `Tool ${index}`,
          status: "completed",
        },
      },
      timestamp: new Date(index * 1_000).toISOString(),
    }));

    const items = hydrateLiveFromDiskUpdates(updates, "long-session");
    expect(items).toHaveLength(450);
    expect(items[0].toolCallId).toBe("tool-0");
    expect(items[449].toolCallId).toBe("tool-449");
  });

  it("merges tool updates without clobbering friendly titles with call ids", () => {
    const updates = [
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
            title: "read_file",
            rawInput: {
              target_file: "D:\\code\\PinkCode\\src\\utils\\format.ts",
            },
            _meta: {
              "x.ai/tool": {
                name: "read_file",
                label: "Read",
                kind: "read",
              },
            },
          },
        },
        timestamp: "2026-07-21T12:00:00Z",
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
            title: "Read `D:\\code\\PinkCode\\src\\utils\\format.ts`",
            kind: "read",
            locations: [
              { path: "D:\\code\\PinkCode\\src\\utils\\format.ts" },
            ],
          },
        },
        timestamp: "2026-07-21T12:00:01Z",
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
            status: "completed",
          },
        },
        timestamp: "2026-07-21T12:00:02Z",
      },
    ];
    const items = hydrateLiveFromDiskUpdates(updates, "sess-tool");
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("tool");
    expect(items[0].toolCallId).toBe(
      "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
    );
    expect(items[0].toolBase).toBe(
      "Read `D:\\code\\PinkCode\\src\\utils\\format.ts`",
    );
    expect(items[0].toolStatus).toBe("completed");
    expect(items[0].title).toBe(
      "Read `D:\\code\\PinkCode\\src\\utils\\format.ts` ✓",
    );
    expect(items[0].title).not.toMatch(/call-f8b05138/);
    expect(items[0].detail ?? "").not.toMatch(/^call-/);
  });

  it("enriches turn_completed with elapsed since last user card", () => {
    const shells: ShellIndexes = new Map();
    let map = new Map<string, TimelineItem[]>();
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "sess-1",
        description: {
          kind: "user",
          title: "User",
          detail: "do the thing",
          coalesce: true,
        },
        now: 1_000,
        nextId: () => "u1",
      },
      shells,
    );
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "sess-1",
        description: {
          kind: "event",
          title: "Turn completed",
          turnStopReason: "end_turn",
          detail: "1.2k tok",
        },
        now: 13_500,
        nextId: () => "t1",
      },
      shells,
    );
    const items = map.get("sess-1") ?? [];
    const terminal = items.find((i) => i.kind === "event");
    expect(terminal?.title).toBe("Worked for 12.5s");
    expect(terminal?.detail).toBe("1.2k tok");
  });

  it("timeline elapsed always owns turn_completed title", () => {
    const shells: ShellIndexes = new Map();
    let map = new Map<string, TimelineItem[]>();
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "sess-1",
        description: {
          kind: "user",
          title: "User",
          detail: "hi",
          coalesce: true,
        },
        now: 1_000,
        nextId: () => "u1",
      },
      shells,
    );
    map = reduceAgentUpdate(
      map,
      {
        handleId: "h1",
        sessionId: "sess-1",
        description: {
          kind: "event",
          title: "Turn completed",
          turnStopReason: "end_turn",
        },
        now: 4_000,
        nextId: () => "t1",
      },
      shells,
    );
    const terminal = (map.get("sess-1") ?? []).find((i) => i.kind === "event");
    expect(terminal?.title).toBe("Worked for 3.0s");
  });

  it("merges disk hydrate without dropping local slash cards", () => {
    const local: TimelineItem = {
      id: "local-1",
      handleId: LOCAL_HANDLE_ID,
      sessionId: "sess-1",
      kind: "event",
      title: "Usage",
      detail: "50%",
      ts: 9_999,
    };
    const prev = new Map<string, TimelineItem[]>([["sess-1", [local]]]);
    const disk = hydrateLiveFromDiskUpdates(
      [
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "from disk" },
            },
          },
          timestamp: "2026-07-21T12:00:00Z",
        },
      ],
      "sess-1",
    );
    const next = mergeDiskLiveIntoMap(prev, "sess-1", disk);
    const list = next.get("sess-1") ?? [];
    expect(list.some((i) => i.handleId === LOCAL_HANDLE_ID)).toBe(true);
    expect(list.some((i) => i.handleId === DISK_HANDLE_ID)).toBe(true);
    expect(list.find((i) => i.handleId === LOCAL_HANDLE_ID)?.detail).toBe(
      "50%",
    );
  });

  it("does not render disk and ACP mirrors of the same update twice", () => {
    const disk: TimelineItem = {
      id: "disk-card",
      handleId: DISK_HANDLE_ID,
      sessionId: "sess-1",
      kind: "agent",
      title: "Agent",
      detail: "Hello",
      ts: 100,
      sourceEventId: "evt-1",
    };
    const live: TimelineItem = {
      ...disk,
      id: "live-card",
      handleId: "agent-handle",
      streaming: true,
    };

    const merged = mergeTimelineItems([disk], [live]);
    expect(merged).toEqual([live]);

    const state = mergeDiskLiveIntoMap(
      new Map([["sess-1", [live]]]),
      "sess-1",
      [disk],
    );
    expect(state.get("sess-1")).toEqual([live]);
  });

  it("deduplicates tool mirrors when an ACP event id is unavailable", () => {
    const disk: TimelineItem = {
      id: "disk-tool",
      handleId: DISK_HANDLE_ID,
      sessionId: "sess-1",
      kind: "tool",
      title: "Read file ✓",
      toolCallId: "tool-1",
      ts: 100,
    };
    const live: TimelineItem = {
      ...disk,
      id: "live-tool",
      handleId: "agent-handle",
      title: "Read file · running",
      ts: 101,
    };

    expect(mergeTimelineItems([disk], [live])).toEqual([live]);
  });

  it("keeps a newer persisted tool update over a stale ACP mirror", () => {
    const live: TimelineItem = {
      id: "live-tool",
      handleId: "agent-handle",
      sessionId: "sess-1",
      kind: "tool",
      title: "Read file · running",
      toolCallId: "tool-1",
      ts: 100,
    };
    const disk: TimelineItem = {
      ...live,
      id: "disk-tool",
      handleId: DISK_HANDLE_ID,
      title: "Read file ✓",
      ts: 101,
    };

    expect(mergeTimelineItems([live], [disk])).toEqual([disk]);
  });

  it("keeps same-timestamp events distinct and gives mirrors stable ids", () => {
    const indexes: ShellIndexes = new Map();
    let state = reduceAgentUpdate(
      new Map(),
      {
        handleId: "live",
        sessionId: "session",
        description: { kind: "event", title: "First" },
        now: 20,
        nextId: () => "fallback-a",
        sourceEventId: "event-a",
      },
      indexes,
    );
    state = reduceAgentUpdate(
      state,
      {
        handleId: "live",
        sessionId: "session",
        description: { kind: "event", title: "Second" },
        now: 20,
        nextId: () => "fallback-b",
        sourceEventId: "event-b",
      },
      indexes,
    );

    expect(state.get("session")?.map((item) => item.id)).toEqual([
      "event-event-a",
      "event-event-b",
    ]);
  });

  it("coalesces text chunks and settles them", () => {
    const indexes: ShellIndexes = new Map();
    let state = reduceAgentUpdate(
      new Map(),
      {
        handleId: "handle",
        sessionId: "session",
        description: {
          kind: "agent",
          title: "Agent",
          detail: "hello ",
          coalesce: true,
        },
        now: 1,
        nextId: () => "one",
      },
      indexes,
    );
    state = reduceAgentUpdate(
      state,
      {
        handleId: "handle",
        sessionId: "session",
        description: {
          kind: "agent",
          title: "Agent",
          detail: "world",
          coalesce: true,
        },
        now: 2,
        nextId: () => "two",
      },
      indexes,
    );
    expect(state.get("session")).toHaveLength(1);
    expect(state.get("session")?.[0].detail).toBe("hello world");
    expect(
      settleStreamingItems(state, { handleId: "handle" }).get("session")?.[0]
        .streaming,
    ).toBe(false);
  });

  it("keeps a coalesced row identity stable while text is streaming", () => {
    const indexes: ShellIndexes = new Map();
    let state = reduceAgentUpdate(
      new Map(),
      {
        handleId: "handle",
        sessionId: "session",
        description: {
          kind: "agent",
          title: "Agent",
          detail: "# Long answer\n\n",
          coalesce: true,
        },
        now: 1,
        nextId: () => "stable-row",
        sourceEventId: "chunk-1",
      },
      indexes,
    );
    state = reduceAgentUpdate(
      state,
      {
        handleId: "handle",
        sessionId: "session",
        description: {
          kind: "agent",
          title: "Agent",
          detail: "- more content",
          coalesce: true,
        },
        now: 2,
        nextId: () => "unused",
        sourceEventId: "chunk-2",
      },
      indexes,
    );

    const item = state.get("session")?.[0];
    expect(item?.id).toBe("event-chunk-1");
    expect(item?.sourceEventId).toBe("chunk-2");
    expect(item?.detail).toBe("# Long answer\n\n- more content");
    expect(item?.streaming).toBe(true);
  });

  it("merges shell snapshots without regressing output", () => {
    const indexes: ShellIndexes = new Map();
    let state = reduceShellUpdate(
      new Map(),
      {
        id: "one",
        handleId: "handle",
        sessionId: "session",
        toolCallId: "tool",
        command: "npm test",
        status: "in_progress",
        output: "long output",
        ts: 1,
      },
      indexes,
    );
    state = reduceShellUpdate(
      state,
      {
        id: "two",
        handleId: "handle",
        sessionId: "session",
        toolCallId: "tool",
        command: "npm test",
        status: "completed",
        output: "short",
        exitCode: 0,
        ts: 2,
      },
      indexes,
    );
    const item = state.get("session")?.[0];
    expect(state.get("session")).toHaveLength(1);
    expect(item?.shell?.output).toBe("long output");
    expect(item?.shell?.status).toBe("completed");
    expect(item?.shell?.exitCode).toBe(0);
  });

  it("bounds shell output", () => {
    const result = capShellOutput("x".repeat(250_000));
    expect(result.length).toBeLessThanOrEqual(200_000);
    expect(result).toContain("truncated");
  });

  it("appends shell deltas without replacing prior output", () => {
    const indexes: ShellIndexes = new Map();
    let state = reduceShellUpdate(
      new Map(),
      {
        id: "one",
        handleId: "handle",
        sessionId: "session",
        toolCallId: "tool",
        command: "build",
        status: "in_progress",
        output: "first",
        ts: 1,
      },
      indexes,
    );
    state = reduceShellUpdate(
      state,
      {
        id: "two",
        handleId: "handle",
        sessionId: "session",
        toolCallId: "tool",
        command: "build",
        status: "in_progress",
        output: " second",
        outputDelta: true,
        ts: 2,
      },
      indexes,
    );
    expect(state.get("session")?.[0].shell?.output).toBe("first second");
  });
});
