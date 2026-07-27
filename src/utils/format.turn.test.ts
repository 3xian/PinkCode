import { describe, expect, it } from "vitest";
import {
  describeUpdate,
  formatTurnCompletedTitle,
  formatTurnElapsed,
  normalizeStopReason,
} from "./format";

describe("formatTurnElapsed", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatTurnElapsed(1_200)).toBe("1.2s");
    expect(formatTurnElapsed(9_900)).toBe("9.9s");
    expect(formatTurnElapsed(12_400)).toBe("12.4s");
    expect(formatTurnElapsed(59_000)).toBe("59.0s");
  });

  it("formats minutes and hours", () => {
    expect(formatTurnElapsed(90_000)).toBe("1m 30s");
    expect(formatTurnElapsed(120_000)).toBe("2m");
    expect(formatTurnElapsed(3_600_000)).toBe("1h");
    expect(formatTurnElapsed(3_720_000)).toBe("1h 2m");
  });
});

describe("formatTurnCompletedTitle", () => {
  it("hides protocol end_turn on the happy path", () => {
    expect(formatTurnCompletedTitle("end_turn")).toBe("Turn completed");
    expect(formatTurnCompletedTitle("end_turn", 12_300)).toBe("Worked for 12.3s");
  });

  it("maps cancelled / error / rate_limit", () => {
    expect(formatTurnCompletedTitle("cancelled")).toBe("Turn cancelled by user");
    expect(formatTurnCompletedTitle("cancelled", 5_200)).toBe(
      "Turn cancelled by user in 5.2s",
    );
    expect(formatTurnCompletedTitle("error")).toBe("Turn failed");
    expect(formatTurnCompletedTitle("error", 3_100)).toBe("Turn failed in 3.1s");
    expect(formatTurnCompletedTitle("rate_limit")).toBe("Rate limited");
  });

  it("treats max_tokens like a normal done (no raw enum in title)", () => {
    expect(formatTurnCompletedTitle("max_tokens")).toBe("Turn completed");
    expect(formatTurnCompletedTitle("max_tokens", 40_000)).toBe(
      "Worked for 40.0s",
    );
  });

  it("normalizes kebab-case stop reasons", () => {
    expect(normalizeStopReason("end-turn")).toBe("end_turn");
    expect(formatTurnCompletedTitle("rate-limit")).toBe("Rate limited");
  });
});

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
    expect(desc.detail).toContain("12.4k tok");
    expect(desc.detail).toContain("7 model calls");
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
