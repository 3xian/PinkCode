import { describe, expect, it } from "vitest";
import {
  buildPromptHistory,
  historyBrowseDown,
  historyBrowseUp,
  historyRowPreview,
  openHistoryBrowse,
} from "./promptHistory";

describe("buildPromptHistory", () => {
  it("returns oldest→newest, deduped, local preferred as newest", () => {
    expect(
      buildPromptHistory({
        timelineUserTexts: ["oldest", "middle", "newest"],
        localSentNewestFirst: ["just sent", "newest"],
      }),
    ).toEqual(["oldest", "middle", "newest", "just sent"]);
  });

  it("drops empty and whitespace-only", () => {
    expect(
      buildPromptHistory({
        timelineUserTexts: ["", "  ", "ok"],
        localSentNewestFirst: ["  "],
      }),
    ).toEqual(["ok"]);
  });
});

describe("history browse steps (Grok overlay indices)", () => {
  const hist = ["apple", "cherry"];

  it("Up on empty opens at newest (bottom)", () => {
    expect(openHistoryBrowse(hist)).toBe(1);
    expect(openHistoryBrowse([])).toBe("noop");
  });

  it("Up moves older; clamps at oldest", () => {
    expect(historyBrowseUp(hist, 1)).toBe(0);
    expect(historyBrowseUp(hist, 0)).toBe(0);
  });

  it("Down at newest closes; otherwise moves newer", () => {
    expect(historyBrowseDown(hist, 1)).toBe("close");
    expect(historyBrowseDown(hist, 0)).toBe(1);
  });
});

describe("historyRowPreview", () => {
  it("collapses whitespace and truncates", () => {
    expect(historyRowPreview("hello\n  world")).toBe("hello world");
    expect(historyRowPreview("x".repeat(10), 8)).toBe("xxxxxxx…");
  });
});
