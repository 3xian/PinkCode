import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { TokenUsageSeries, WeekUsage } from "../types";
import {
  formatResetCountdown,
  formatTimeUntil,
  formatTokens,
} from "../utils/format";

interface Props {
  tokenSeries: TokenUsageSeries | null;
  weekUsage: WeekUsage | null;
  onRefreshWeekUsage?: () => void;
}

/** Compact status card for the left rail (above the task list). */
export function StatsBar({
  tokenSeries,
  weekUsage,
  onRefreshWeekUsage,
}: Props) {
  return (
    <section className="status-card">
      <div className="status-card-row">
        <WeekUsageBar usage={weekUsage} onRefresh={onRefreshWeekUsage} />
        <TokenUsageChart series={tokenSeries} weekUsage={weekUsage} />
      </div>
    </section>
  );
}

/** viewBox size — HTML dots use % so they stay circles under preserveAspectRatio=none. */
const CHART_VB_W = 280;
const CHART_VB_H = 48;
/** Max distance (in plot %) from a point to show its tooltip. */
const HOVER_PROXIMITY_PCT = 12;

function TokenUsageChart({
  series,
  weekUsage,
}: {
  series: TokenUsageSeries | null;
  weekUsage: WeekUsage | null;
}) {
  const chart = useMemo(() => {
    if (!series || series.days.length === 0) return null;
    return buildSmoothChart(series.days.map((d) => d.tokens));
  }, [series]);

  const plotRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const onPlotMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!chart || !series) {
        setHoverIdx(null);
        return;
      }
      const el = plotRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const mx = ((e.clientX - rect.left) / rect.width) * 100;
      const my = ((e.clientY - rect.top) / rect.height) * 100;

      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < chart.points.length; i++) {
        const p = chart.points[i];
        const px = (p.x / CHART_VB_W) * 100;
        const py = (p.y / CHART_VB_H) * 100;
        const dx = mx - px;
        const dy = my - py;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      setHoverIdx(best >= 0 && bestDist <= HOVER_PROXIMITY_PCT ? best : null);
    },
    [chart, series],
  );

  const onPlotLeave = useCallback(() => setHoverIdx(null), []);

  const resetLabel = resetHeaderLabel(weekUsage);

  if (!series) {
    return (
      <div className="token-chart loading">
        <div className="token-chart-top">
          <span
            className="token-chart-reset"
            title={resetTooltip(weekUsage)}
          >
            {resetLabel}
          </span>
        </div>
        <div className="token-chart-plot" />
      </div>
    );
  }

  const days = series.days;
  const hoverDay = hoverIdx != null ? days[hoverIdx] : null;
  const hoverPt = hoverIdx != null && chart ? chart.points[hoverIdx] : null;
  const hoverTopPct = hoverPt ? (hoverPt.y / CHART_VB_H) * 100 : 0;
  // Tip is taller than half the plot; flip below when the point is high.
  const tipBelow = hoverPt != null && hoverTopPct < 52;
  const hoverUsageLine =
    hoverDay != null
      ? dayUsageEstimateLine(hoverDay.tokens, series, weekUsage)
      : null;

  return (
    <div className="token-chart">
      <div className="token-chart-top">
        <span className="token-chart-reset" title={resetTooltip(weekUsage)}>
          {resetLabel}
        </span>
      </div>
      <div
        ref={plotRef}
        className="token-chart-plot"
        onMouseMove={onPlotMove}
        onMouseLeave={onPlotLeave}
      >
        <svg
          className="token-chart-svg"
          viewBox={`0 0 ${CHART_VB_W} ${CHART_VB_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Token usage over the last 7 days"
        >
          <defs>
            <linearGradient id="tokenStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--title-selected)" />
            </linearGradient>
          </defs>
          {chart && (
            <path
              d={chart.line}
              fill="none"
              stroke="url(#tokenStroke)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {chart && (
          <div className="token-chart-dots" aria-hidden>
            {chart.points.map((p, i) => (
              <span
                key={days[i]?.date ?? i}
                className={
                  "token-chart-dot" +
                  (hoverIdx === i ? " token-chart-dot-active" : "")
                }
                style={{
                  left: `${(p.x / CHART_VB_W) * 100}%`,
                  top: `${(p.y / CHART_VB_H) * 100}%`,
                }}
              />
            ))}
          </div>
        )}
        {hoverDay && hoverPt && (
          <div
            className={
              "token-chart-tip" + (tipBelow ? " token-chart-tip-below" : "")
            }
            style={{
              left: `${(hoverPt.x / CHART_VB_W) * 100}%`,
              top: `${hoverTopPct}%`,
            }}
            role="tooltip"
          >
            <div className="token-chart-tip-date">{hoverDay.date}</div>
            <div className="token-chart-tip-row">
              {formatTokens(hoverDay.tokens)} tokens
            </div>
            {hoverUsageLine && (
              <div className="token-chart-tip-row muted">
                {hoverUsageLine}
              </div>
            )}
            <div className="token-chart-tip-row">{hoverDay.turns} turns</div>
          </div>
        )}
      </div>
      <div className="token-chart-meta">
        <span>{shortDay(days[0]?.date)}</span>
        <span>{shortDay(days[days.length - 1]?.date)}</span>
      </div>
    </div>
  );
}

/** Build smooth cubic path (Catmull-Rom → Bezier) for a 280×48 chart. */
function buildSmoothChart(values: number[]): {
  line: string;
  area: string;
  points: { x: number; y: number }[];
} {
  const w = 280;
  const h = 48;
  // Extra pad so larger dots / halos are not clipped at the edges.
  const padX = 10;
  const padY = 10;
  const n = values.length;
  const max = Math.max(1, ...values);
  const span = Math.max(1, n - 1);

  const points = values.map((v, i) => {
    const x = padX + ((w - padX * 2) * i) / span;
    const y = h - padY - ((h - padY * 2) * v) / max;
    return { x, y };
  });

  if (points.length === 1) {
    const p = points[0];
    return {
      line: `M ${p.x} ${p.y}`,
      area: `M ${p.x} ${h - padY} L ${p.x} ${p.y} L ${p.x} ${h - padY} Z`,
      points,
    };
  }

  let line = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const area = `${line} L ${last.x.toFixed(2)} ${(h - padY).toFixed(2)} L ${first.x.toFixed(2)} ${(h - padY).toFixed(2)} Z`;

  return { line, area, points };
}

function shortDay(iso?: string): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  return iso;
}

/** Chart header: "Reset: 2d" / "Reset: 5h" / "Reset: 12m". */
function resetHeaderLabel(usage: WeekUsage | null): string {
  if (!usage) return "Reset: …";
  if (usage.error || !usage.periodEnd) return "Reset: —";
  const unit = formatResetCountdown(usage.periodEnd);
  if (unit === "now") return "Reset: now";
  if (unit === "—") return "Reset: —";
  return `Reset: ${unit}`;
}

function resetTooltip(usage: WeekUsage | null): string {
  if (!usage) return "Loading period reset…";
  if (usage.error) return usage.error;
  if (!usage.periodEnd) return "No period end from billing API";
  return `Resets in ${formatTimeUntil(usage.periodEnd)}`;
}

function WeekUsageBar({
  usage,
  onRefresh,
}: {
  usage: WeekUsage | null;
  onRefresh?: () => void;
}) {
  const clickable = Boolean(onRefresh);
  const onClick = clickable
    ? () => {
        onRefresh?.();
      }
    : undefined;
  const onKeyDown = clickable
    ? (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRefresh?.();
        }
      }
    : undefined;
  const interactive = {
    role: clickable ? ("button" as const) : undefined,
    tabIndex: clickable ? 0 : undefined,
    onClick,
    onKeyDown,
  };

  if (!usage) {
    return (
      <div
        className={`week-battery loading ${clickable ? "clickable" : ""}`}
        title="Loading week usage… · click to refresh"
        {...interactive}
      >
        <UsageBattery fill={0} label="…" muted />
      </div>
    );
  }

  if (usage.error) {
    const shortErr = summarizeUsageError(usage.error);
    return (
      <div
        className={`week-battery error ${clickable ? "clickable" : ""}`}
        title={`${usage.error} · click to retry`}
        {...interactive}
      >
        <UsageBattery fill={0} label="n/a" muted />
        <span className="week-battery-hint">{shortErr}</span>
      </div>
    );
  }

  // Overall weekly credit remaining (matches Grok "weekly limit left").
  // Do NOT prefer GrokBuild product % — that is only one slice of the budget.
  const remaining = Math.max(0, Math.min(100, usage.remainingPercent));
  const level =
    remaining <= 10
      ? "critical"
      : remaining <= 25
        ? "low"
        : remaining <= 50
          ? "mid"
          : "ok";
  const periodLabel = periodTypeLabel(usage.periodType);
  const reset = formatTimeUntil(usage.periodEnd);
  const tip = [
    `${periodLabel} remaining: ${fmtPct(remaining)}`,
    usage.buildRemainingPercent != null
      ? `Grok Build left: ${fmtPct(usage.buildRemainingPercent)}`
      : null,
    usage.periodEnd ? `resets in ${reset}` : null,
    "click to refresh",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`week-battery level-${level} ${clickable ? "clickable" : ""}`}
      title={tip}
      {...interactive}
    >
      <UsageBattery
        fill={remaining}
        label={fmtPct(remaining)}
        meterLabel={`${periodLabel} remaining ${fmtPct(remaining)}`}
      />
    </div>
  );
}

/** 3D transparent battery — purple fill = remaining charge. */
function UsageBattery({
  fill,
  label,
  muted,
  meterLabel,
}: {
  fill: number;
  label: string;
  muted?: boolean;
  meterLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, fill));
  return (
    <div
      className="usage-battery"
      role={meterLabel ? "meter" : undefined}
      aria-valuenow={meterLabel ? pct : undefined}
      aria-valuemin={meterLabel ? 0 : undefined}
      aria-valuemax={meterLabel ? 100 : undefined}
      aria-label={meterLabel}
    >
      <div className="usage-battery-nub" aria-hidden />
      <div className="usage-battery-body" aria-hidden>
        <div className="usage-battery-shell">
          <div className="usage-battery-glass">
            <div className="usage-battery-shine" />
            <div className="usage-battery-edge" />
            <div
              className="usage-battery-fill"
              style={{ height: `${pct}%` }}
            >
              <div className="usage-battery-fill-sheen" />
            </div>
          </div>
        </div>
      </div>
      <span className={`usage-battery-pct${muted ? " muted" : ""}`}>{label}</span>
    </div>
  );
}

function periodTypeLabel(t: string): string {
  if (!t) return "Week";
  if (t.includes("WEEKLY") || t.toLowerCase().includes("week")) return "Week";
  if (t.includes("MONTHLY") || t.toLowerCase().includes("month")) return "Month";
  if (t.includes("DAILY") || t.toLowerCase().includes("day")) return "Day";
  return "Period";
}

function summarizeUsageError(err: string): string {
  const e = err.toLowerCase();
  if (e.includes("timed out") || e.includes("timeout") || e.includes("connection failed")) {
    return "network timeout";
  }
  if (e.includes("auth.json") || e.includes("session token") || e.includes("login")) {
    return "auth missing";
  }
  if (e.includes("http 401") || e.includes("http 403")) {
    return "auth failed";
  }
  if (e.includes("proxy")) {
    return "proxy error";
  }
  return "fetch failed";
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
}

/**
 * Rough day share of the billing period (local tokens only):
 * (dayTokens / seriesTotal) * credit_usage_percent → "~12% usage".
 * Leading ~ marks this as an estimate, not official Grok day accounting.
 */
function dayUsageEstimateLine(
  dayTokens: number,
  series: TokenUsageSeries,
  weekUsage: WeekUsage | null,
): string | null {
  if (!weekUsage || weekUsage.error) return null;
  const creditUsagePercent = weekUsage.usedPercent;
  if (!Number.isFinite(creditUsagePercent) || creditUsagePercent <= 0) {
    return null;
  }
  const total =
    series.totalTokens > 0
      ? series.totalTokens
      : series.days.reduce((s, d) => s + d.tokens, 0);
  if (!(total > 0) || !Number.isFinite(dayTokens) || dayTokens < 0) return null;
  const pct = (dayTokens / total) * creditUsagePercent;
  return `~${fmtPct(pct)} usage`;
}


