import { describe, expect, it } from "vitest";
import { mergeUpdatePages } from "./useTimelineHistory";

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
});
