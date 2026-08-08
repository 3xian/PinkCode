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
  dayChartValues,
  dayWeeklyLimitPercent,
  formatDayWeeklyLimitLine,
} from "../utils/dayUsage";
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

/** viewBox size for the 7-day token bar chart. */
const CHART_VB_W = 280;
const CHART_VB_H = 48;

function TokenUsageChart({
  series,
  weekUsage,
}: {
  series: TokenUsageSeries | null;
  weekUsage: WeekUsage | null;
}) {
  const chart = useMemo(() => {
    if (!series || series.days.length === 0) return null;
    // Bar heights follow weekly-limit % (cost-weighted), not raw tokens.
    return buildBarChart(dayChartValues(series, weekUsage));
  }, [series, weekUsage]);

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
      const mx = ((e.clientX - rect.left) / rect.width) * CHART_VB_W;

      let best = -1;
      for (let i = 0; i < chart.bars.length; i++) {
        const b = chart.bars[i];
        // Include half the gap on each side so hover feels continuous.
        const left = b.x - chart.gap / 2;
        const right = b.x + b.width + chart.gap / 2;
        if (mx >= left && mx <= right) {
          best = i;
          break;
        }
      }
      setHoverIdx(best >= 0 ? best : null);
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
  const hoverBar = hoverIdx != null && chart ? chart.bars[hoverIdx] : null;
  const hoverTopPct = hoverBar ? (hoverBar.y / CHART_VB_H) * 100 : 0;
  // Tip is taller than half the plot; flip below when the bar is high.
  const tipBelow = hoverBar != null && hoverTopPct < 52;
  const hoverPct =
    hoverDay != null
      ? dayWeeklyLimitPercent(hoverDay, series, weekUsage)
      : null;
  const hoverUsageLine =
    hoverPct != null ? formatDayWeeklyLimitLine(hoverPct) : null;

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
            <linearGradient id="tokenBarFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--title-selected)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          {chart?.bars.map((b, i) => (
            <rect
              key={days[i]?.date ?? i}
              className={
                "token-chart-bar" +
                (hoverIdx === i ? " token-chart-bar-active" : "")
              }
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              rx={Math.min(2, b.width / 4)}
              fill="url(#tokenBarFill)"
            />
          ))}
        </svg>
        {hoverDay && hoverBar && (
          <div
            className={
              "token-chart-tip" + (tipBelow ? " token-chart-tip-below" : "")
            }
            style={{
              left: `${((hoverBar.x + hoverBar.width / 2) / CHART_VB_W) * 100}%`,
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

/** Build vertical bars for a 280×48 chart. */
function buildBarChart(values: number[]): {
  bars: { x: number; y: number; width: number; height: number }[];
  gap: number;
} {
  const w = CHART_VB_W;
  const h = CHART_VB_H;
  const padX = 4;
  const padY = 2;
  const n = values.length;
  const max = Math.max(1, ...values);
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;
  // ~22% of slot as gap keeps bars readable at 7 days.
  const gap = n > 1 ? (plotW / n) * 0.22 : 0;
  const barW = n > 0 ? (plotW - gap * (n - 1)) / n : plotW;

  const bars = values.map((v, i) => {
    // Tiny stub for zero days so empty slots remain visible/hoverable.
    const height =
      v > 0
        ? Math.max(2, (plotH * v) / max)
        : Math.max(1.5, plotH * 0.04);
    const x = padX + i * (barW + gap);
    const y = h - padY - height;
    return { x, y, width: barW, height };
  });

  return { bars, gap };
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
  const rootRef = useRef<HTMLDivElement>(null);
  const clickable = Boolean(onRefresh);

  /** Imperative class toggle — no React state / duration sync. */
  const playWave = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.remove("is-waving");
    void el.offsetWidth; // reflow so the CSS animation can restart
    el.classList.add("is-waving");
  }, []);

  const onWaveEnd = useCallback(() => {
    rootRef.current?.classList.remove("is-waving");
  }, []);

  const interactive = (withWave: boolean) => {
    if (!clickable) return {};
    const run = () => {
      if (withWave) playWave();
      onRefresh?.();
    };
    return {
      role: "button" as const,
      tabIndex: 0,
      onClick: run,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          run();
        }
      },
    };
  };

  if (!usage) {
    return (
      <div
        className={`week-battery loading${clickable ? " clickable" : ""}`}
        title="Loading week usage… · click to refresh"
        {...interactive(false)}
      >
        <UsageBattery fill={0} label="…" muted />
      </div>
    );
  }

  if (usage.error) {
    const shortErr = summarizeUsageError(usage.error);
    return (
      <div
        className={`week-battery error${clickable ? " clickable" : ""}`}
        title={`${usage.error} · click to retry`}
        {...interactive(false)}
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

  // Wave only on success with visible liquid — not loading/error empty bottles.
  const canWave = remaining > 0;

  return (
    <div
      ref={rootRef}
      className={`week-battery level-${level}${clickable ? " clickable" : ""}`}
      title={tip}
      {...interactive(canWave)}
    >
      <UsageBattery
        fill={remaining}
        label={fmtPct(remaining)}
        meterLabel={`${periodLabel} remaining ${fmtPct(remaining)}`}
        onWaveEnd={canWave ? onWaveEnd : undefined}
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
  onWaveEnd,
}: {
  fill: number;
  label: string;
  muted?: boolean;
  meterLabel?: string;
  /** Fires when the front crest animation finishes (clears .is-waving). */
  onWaveEnd?: () => void;
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
              {/* Dual free-surface crests — sway on click (see .is-waving) */}
              <div className="usage-battery-wave-layer" aria-hidden>
                <svg
                  className="usage-battery-wave usage-battery-wave-back"
                  viewBox="0 0 240 16"
                  preserveAspectRatio="none"
                >
                  <path d="M0 10 C20 4 40 16 60 10 S100 4 120 10 160 16 180 10 220 4 240 10 V16 H0 Z" />
                </svg>
                <svg
                  className="usage-battery-wave usage-battery-wave-front"
                  viewBox="0 0 240 16"
                  preserveAspectRatio="none"
                  onAnimationEnd={onWaveEnd}
                >
                  <path d="M0 9 C15 15 45 3 60 9 S105 15 120 9 165 3 180 9 225 15 240 9 V16 H0 Z" />
                </svg>
              </div>
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


