import { useMemo, type KeyboardEvent } from "react";
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

  const resetLabel = resetHeaderLabel(weekUsage);

  if (!series) {
    return (
      <div className="token-chart loading" title="Loading 7-day token usage…">
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
  const tip = days
    .map(
      (d) =>
        `${d.date.slice(5)}: ${formatTokens(d.tokens)} tok · ${d.turns} turns`,
    )
    .join("\n");

  // viewBox size — used to place HTML dots as % so they stay perfect circles
  // (SVG preserveAspectRatio="none" would squash <circle> into ellipses).
  const vbW = 280;
  const vbH = 48;

  return (
    <div
      className="token-chart"
      title={`${tip}\n\nTotal ${formatTokens(series.totalTokens)} tok · ${series.totalTurns} turns\n(fresh input + output; cache hits excluded)`}
    >
      <div className="token-chart-top">
        <span className="token-chart-reset" title={resetTooltip(weekUsage)}>
          {resetLabel}
        </span>
      </div>
      <div className="token-chart-plot">
        <svg
          className="token-chart-svg"
          viewBox={`0 0 ${vbW} ${vbH}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Token usage over the last 7 days"
        >
          <defs>
            <linearGradient id="tokenStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#a78bfa" />
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
                className="token-chart-dot"
                style={{
                  left: `${(p.x / vbW) * 100}%`,
                  top: `${(p.y / vbH) * 100}%`,
                }}
                title={
                  days[i]
                    ? `${days[i].date}: ${formatTokens(days[i].tokens)} tok`
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
      <div className="token-chart-meta">
        <span>{shortDay(days[0]?.date)}</span>
        <span>{series.totalTurns} turns</span>
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


