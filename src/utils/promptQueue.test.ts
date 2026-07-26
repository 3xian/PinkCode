import { describe, expect, it } from "vitest";
import { moveQueuedPromptIds, normalizePromptQueue } from "./promptQueue";

describe("prompt queue wire state", () => {
  it("normalizes and sorts the server-authoritative entries", () => {
    expect(
      normalizePromptQueue({
        sessionId: "s1",
        entries: [
          { id: "b", text: "second", position: 1, version: 2, kind: "prompt" },
          { id: "a", text: "first", position: 0 },
        ],
      }),
    ).toEqual({
      sessionId: "s1",
      entries: [
        { id: "a", text: "first", position: 0, version: 0, kind: "prompt" },
        { id: "b", text: "second", position: 1, version: 2, kind: "prompt" },
      ],
    });
  });

  it("builds a complete reordered id list and rejects boundary moves", () => {
    const state = normalizePromptQueue({
      sessionId: "s1",
      entries: [
        { id: "a", text: "a", position: 0 },
        { id: "b", text: "b", position: 1 },
        { id: "c", text: "c", position: 2 },
      ],
    })!;
    expect(moveQueuedPromptIds(state.entries, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveQueuedPromptIds(state.entries, 0, -1)).toBeNull();
    expect(moveQueuedPromptIds(state.entries, 2, 1)).toBeNull();
  });
});
