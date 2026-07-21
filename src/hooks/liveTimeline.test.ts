import { describe, expect, it } from "vitest";
import {
  capShellOutput,
  reduceAgentUpdate,
  reduceShellUpdate,
  settleStreamingItems,
  type ShellIndexes,
} from "./liveTimeline";

describe("live timeline reducer", () => {
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
});
