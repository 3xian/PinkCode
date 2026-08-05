import { describe, expect, it } from "vitest";
import {
  mergeUpdatePages,
  updatesPageFingerprint,
} from "./useTimelineHistory";

function update(eventId: string, text: string) {
  return {
    timestamp: 1,
    params: { update: { sessionUpdate: "agent_message_chunk", text } },
    _meta: { eventId },
  };
}

describe("timeline history pages", () => {
  it("prepends older pages without losing a short session as new updates arrive", () => {
    const initial = [update("a", "a")];
    const refreshed = mergeUpdatePages(initial, [
      update("a", "a"),
      update("b", "b"),
    ]);
    const expanded = mergeUpdatePages(
      [update("older", "older")],
      refreshed,
    );

    expect(
      expanded.map((item) => (item as { _meta: { eventId: string } })._meta.eventId),
    ).toEqual(["older", "a", "b"]);
  });

  it("fingerprints identical update pages the same way", () => {
    const page = [update("a", "a"), update("b", "b"), update("c", "c")];
    expect(updatesPageFingerprint(page)).toBe(
      updatesPageFingerprint([...page]),
    );
    expect(updatesPageFingerprint(page)).not.toBe(
      updatesPageFingerprint([update("a", "a"), update("b", "b")]),
    );
  });

  it("treats same-length pages with a different midpoint as distinct", () => {
    const a = [update("1", "a"), update("2", "b"), update("3", "c")];
    const b = [update("1", "a"), update("x", "b"), update("3", "c")];
    expect(updatesPageFingerprint(a)).not.toBe(updatesPageFingerprint(b));
  });

  it("mergeUpdatePages prefers newer page entries for the same identity", () => {
    const older = [update("a", "old-a"), update("b", "old-b")];
    const newer = [update("b", "new-b"), update("c", "c")];
    const merged = mergeUpdatePages(older, newer);
    expect(
      merged.map((item) => (item as { _meta: { eventId: string } })._meta.eventId),
    ).toEqual(["a", "b", "c"]);
    const b = merged.find(
      (item) =>
        (item as { _meta: { eventId: string } })._meta.eventId === "b",
    ) as { params: { update: { text: string } } };
    expect(b.params.update.text).toBe("new-b");
  });
});
