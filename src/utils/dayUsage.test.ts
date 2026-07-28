import { describe, expect, it } from "vitest";
import {
  dayChartValues,
  dayWeeklyLimitPercent,
  formatDayWeeklyLimitLine,
} from "./dayUsage";
import type { TokenUsageSeries, WeekUsage } from "../types";

function series(
  days: { tokens: number; costUsdTicks?: number }[],
): TokenUsageSeries {
  const points = days.map((d, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    tokens: d.tokens,
    turns: d.tokens > 0 || (d.costUsdTicks ?? 0) > 0 ? 1 : 0,
    costUsdTicks: d.costUsdTicks ?? 0,
  }));
  return {
    days: points,
    totalTokens: points.reduce((s, d) => s + d.tokens, 0),
    totalTurns: points.reduce((s, d) => s + d.turns, 0),
    totalCostUsdTicks: points.reduce((s, d) => s + d.costUsdTicks, 0),
    windowDays: points.length,
  };
}

function week(usedPercent: number): WeekUsage {
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    periodType: "USAGE_PERIOD_TYPE_WEEKLY",
    productUsage: [],
    fetchedAt: "0",
  };
}

describe("dayWeeklyLimitPercent", () => {
  it("allocates credit_usage_percent by costUsdTicks weight", () => {
    const s = series([
      { tokens: 1_000_000, costUsdTicks: 25 },
      { tokens: 1_000_000, costUsdTicks: 75 },
    ]);
    expect(dayWeeklyLimitPercent(s.days[0], s, week(40))).toBeCloseTo(10, 6);
    expect(dayWeeklyLimitPercent(s.days[1], s, week(40))).toBeCloseTo(30, 6);
  });

  it("prefers cost over tokens when both present", () => {
    const s = series([
      { tokens: 100, costUsdTicks: 10 },
      { tokens: 100, costUsdTicks: 90 },
    ]);
    expect(dayWeeklyLimitPercent(s.days[0], s, week(50))).toBeCloseTo(5, 6);
    expect(dayWeeklyLimitPercent(s.days[1], s, week(50))).toBeCloseTo(45, 6);
  });

  it("falls back to fresh-token weight when no cost", () => {
    const s = series([{ tokens: 25 }, { tokens: 75 }]);
    expect(dayWeeklyLimitPercent(s.days[0], s, week(20))).toBeCloseTo(5, 6);
    expect(dayWeeklyLimitPercent(s.days[1], s, week(20))).toBeCloseTo(15, 6);
  });

  it("returns null without billing usage", () => {
    const s = series([{ tokens: 10, costUsdTicks: 10 }]);
    expect(dayWeeklyLimitPercent(s.days[0], s, null)).toBeNull();
    expect(
      dayWeeklyLimitPercent(s.days[0], s, {
        ...week(10),
        error: "offline",
      }),
    ).toBeNull();
  });
});

describe("dayChartValues", () => {
  it("sizes bars by weekly-limit percent when available", () => {
    const s = series([
      { tokens: 1, costUsdTicks: 25 },
      { tokens: 1, costUsdTicks: 75 },
    ]);
    expect(dayChartValues(s, week(40))).toEqual([10, 30]);
  });
});

describe("formatDayWeeklyLimitLine", () => {
  it("labels weekly-limit share", () => {
    expect(formatDayWeeklyLimitLine(12.5)).toBe("12.5% of weekly limit");
    expect(formatDayWeeklyLimitLine(12)).toBe("12% of weekly limit");
  });
});
