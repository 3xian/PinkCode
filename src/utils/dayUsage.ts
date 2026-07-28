import type { TokenDayPoint, TokenUsageSeries, WeekUsage } from "../types";

/**
 * Day share of the billing-period credit limit (Weekly / Monthly limit).
 *
 * ## Grok Build algorithm (source of truth)
 *
 * Period usage % comes from billing credits config:
 *   `credit_usage_percent`  →  PinkCode `WeekUsage.usedPercent`
 * via `GET …/billing?format=credits` and
 * `credit_balance_from_config` (grok-build pager helpers).
 *
 * The billable unit is **cost**, not tokens:
 *   turn_completed.usage.costUsdTicks  (1e10 ticks = $1 USD)
 *
 * ## Local day allocation (estimate)
 *
 * Official API only returns the period aggregate %. Local session logs
 * provide per-day weights. Day share of reported period usage:
 *
 *   day_pct = (day_weight / window_weight) × credit_usage_percent
 *
 * Prefer cost ticks; fall back to fresh tokens when no trusted costs exist.
 * Display is local attribution of period %, not official day billing.
 */
export function dayWeeklyLimitPercent(
  day: Pick<TokenDayPoint, "tokens" | "costUsdTicks">,
  series: TokenUsageSeries,
  weekUsage: WeekUsage | null,
): number | null {
  if (!weekUsage || weekUsage.error) return null;
  const creditUsagePercent = weekUsage.usedPercent;
  if (!Number.isFinite(creditUsagePercent) || creditUsagePercent < 0) {
    return null;
  }

  const totalCost = series.totalCostUsdTicks;
  const useCost =
    totalCost > 0 && series.days.some((d) => d.costUsdTicks > 0);

  if (useCost) {
    const dayCost = day.costUsdTicks;
    if (!(totalCost > 0) || !Number.isFinite(dayCost) || dayCost < 0) {
      return null;
    }
    return (dayCost / totalCost) * creditUsagePercent;
  }

  const totalTokens = series.totalTokens;
  const dayTokens = day.tokens;
  if (!(totalTokens > 0) || !Number.isFinite(dayTokens) || dayTokens < 0) {
    return null;
  }
  return (dayTokens / totalTokens) * creditUsagePercent;
}

/** Values used to size the bar chart (prefer weekly-limit %, else cost, else tokens). */
export function dayChartValues(
  series: TokenUsageSeries,
  weekUsage: WeekUsage | null,
): number[] {
  const pcts = series.days.map((d) =>
    dayWeeklyLimitPercent(d, series, weekUsage),
  );
  if (pcts.every((p): p is number => p != null) && pcts.some((p) => p > 0)) {
    return pcts;
  }
  if (series.totalCostUsdTicks > 0) {
    return series.days.map((d) => d.costUsdTicks);
  }
  return series.days.map((d) => d.tokens);
}

/** Local window attribution of period % (shown without leading ~). */
export function formatDayWeeklyLimitLine(pct: number): string {
  return `${formatUsagePct(pct)} of weekly limit`;
}

function formatUsagePct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
}
