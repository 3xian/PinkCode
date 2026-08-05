import { describe, expect, it } from "vitest";
import {
  computeVirtualRange,
  prependHeightDelta,
  VIRTUAL_WINDOW_MIN_COUNT,
} from "./useVirtualWindow";

describe("prependHeightDelta", () => {
  const heightOf = (key: string) => {
    if (key.startsWith("old-")) return 100;
    if (key.startsWith("new-")) return 40;
    return 96;
  };

  it("returns 0 when the list did not grow at the head", () => {
    expect(prependHeightDelta(["a", "b"], ["a", "b"], heightOf)).toBe(0);
    expect(prependHeightDelta(["a", "b"], ["a", "b", "c"], heightOf)).toBe(0);
    expect(prependHeightDelta([], ["a"], heightOf)).toBe(0);
  });

  it("sums heights of keys inserted above the previous head", () => {
    const prev = ["old-1", "old-2", "old-3"];
    const next = ["new-a", "new-b", "old-1", "old-2", "old-3"];
    expect(prependHeightDelta(prev, next, heightOf)).toBe(80);
  });

  it("returns 0 when the previous head is missing (full replace)", () => {
    expect(
      prependHeightDelta(["a", "b"], ["x", "y", "z"], heightOf),
    ).toBe(0);
  });
});

describe("computeVirtualRange", () => {
  /** 10 items, each 100px → total 1000. */
  function offsetsOf(count: number, h = 100): number[] {
    const offs = new Array<number>(count + 1);
    offs[0] = 0;
    for (let i = 0; i < count; i++) offs[i + 1] = offs[i] + h;
    return offs;
  }

  it("returns empty range for empty list", () => {
    expect(computeVirtualRange([0], 0, 0, 400, 2)).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it("windows the visible slice with overscan", () => {
    const offs = offsetsOf(20);
    // Viewport covers items 5–8 (scroll 500, height 400) → overscan 2 → 3..11
    const range = computeVirtualRange(offs, 20, 500, 400, 2);
    expect(range.start).toBe(3);
    expect(range.end).toBe(11);
    expect(range.offsetTop).toBe(300);
    expect(range.totalHeight).toBe(2000);
  });

  it("clamps to list bounds at the top", () => {
    const offs = offsetsOf(10);
    const range = computeVirtualRange(offs, 10, 0, 250, 4);
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThan(0);
    expect(range.offsetTop).toBe(0);
  });

  it("clamps to list bounds at the bottom", () => {
    const offs = offsetsOf(10);
    const range = computeVirtualRange(offs, 10, 900, 200, 2);
    expect(range.end).toBe(10);
    expect(range.start).toBeLessThan(10);
    expect(range.totalHeight).toBe(1000);
  });
});

describe("VIRTUAL_WINDOW_MIN_COUNT", () => {
  it("is a positive threshold below which full render is preferred", () => {
    expect(VIRTUAL_WINDOW_MIN_COUNT).toBeGreaterThan(0);
    expect(VIRTUAL_WINDOW_MIN_COUNT).toBeLessThan(200);
  });
});
