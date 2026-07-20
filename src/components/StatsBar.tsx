import type { KeyboardEvent } from "react";
import type { DashboardStats, WeekUsage } from "../types";
import { formatTimeUntil, formatTokens } from "../utils/format";
import logo from "../assets/logo.png";

interface Props {
  stats: DashboardStats | null;
  weekUsage: WeekUsage | null;
  managedCount: number;
  pendingPermissions: number;
  onNewTask: () => void;
  onRefreshWeekUsage?: () => void;
}

export function StatsBar({
  stats,
  weekUsage,
  managedCount,
  pendingPermissions,
  onNewTask,
  onRefreshWeekUsage,
}: Props) {
  return (
    <header className="stats-bar">
      <div className="brand">
        <img src={logo} alt="MarsBuild" className="brand-logo" />
        <div>
          <div className="brand-name">MarsBuild</div>
          <div className="brand-sub">Desktop mission control</div>
        </div>
      </div>

      <WeekUsageBar usage={weekUsage} onRefresh={onRefreshWeekUsage} />

      <div className="stat-chips">
        <Chip
          label="Managed"
          value={String(managedCount)}
          accent={managedCount > 0}
        />
        <Chip
          label="Pending"
          value={String(pendingPermissions)}
          accent={pendingPermissions > 0}
          danger={pendingPermissions > 0}
        />
        <Chip
          label="Active"
          value={stats ? String(stats.activeSessions) : "—"}
          accent
        />
        <Chip label="Sessions" value={stats ? String(stats.totalSessions) : "—"} />
        <Chip
          label="Context"
          value={stats ? formatTokens(stats.totalContextTokens) : "—"}
        />
        <Chip
          label="Tools"
          value={stats ? formatTokens(stats.totalToolCalls) : "—"}
        />
        <Chip
          label="Δ Lines"
          value={
            stats
              ? `+${formatTokens(stats.totalLinesAdded)} / −${formatTokens(stats.totalLinesRemoved)}`
              : "—"
          }
        />
      </div>

      <div className="header-actions">
        <button className="btn primary" type="button" onClick={onNewTask}>
          + New task
        </button>
      </div>
    </header>
  );
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

  if (!usage) {
    return (
      <div
        className={`week-usage loading ${clickable ? "clickable" : ""}`}
        title="Loading week usage… · click to refresh"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <div className="week-usage-top">
          <span className="week-usage-label">Week</span>
          <span className="week-usage-value">…</span>
        </div>
        <div className="week-usage-track">
          <div className="week-usage-fill" style={{ width: "0%" }} />
        </div>
      </div>
    );
  }

  if (usage.error) {
    return (
      <div
        className={`week-usage error ${clickable ? "clickable" : ""}`}
        title={`${usage.error} · click to retry`}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <div className="week-usage-top">
          <span className="week-usage-label">Week</span>
          <span className="week-usage-value muted">n/a</span>
        </div>
        <div className="week-usage-track">
          <div className="week-usage-fill empty" style={{ width: "0%" }} />
        </div>
      </div>
    );
  }

  // Prefer Grok Build product remaining; fall back to overall credits.
  const remaining =
    usage.buildRemainingPercent ?? usage.remainingPercent;
  const used = usage.buildUsedPercent ?? usage.usedPercent;
  const level =
    remaining <= 10 ? "critical" : remaining <= 25 ? "low" : remaining <= 50 ? "mid" : "ok";
  const periodLabel = periodTypeLabel(usage.periodType);
  const reset = formatTimeUntil(usage.periodEnd);
  const tip = [
    `${periodLabel} remaining: ${fmtPct(remaining)}`,
    `used: ${fmtPct(used)}`,
    usage.buildUsedPercent != null
      ? `Grok Build ${fmtPct(usage.buildUsedPercent)} · overall ${fmtPct(usage.usedPercent)}`
      : null,
    usage.periodEnd ? `resets in ${reset}` : null,
    "click to refresh",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`week-usage level-${level} ${clickable ? "clickable" : ""}`}
      title={tip}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="week-usage-top">
        <span className="week-usage-label">{periodLabel}</span>
        <span className="week-usage-value">{fmtPct(remaining)} left</span>
      </div>
      <div
        className="week-usage-track"
        role="meter"
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${periodLabel} remaining`}
      >
        <div
          className="week-usage-fill"
          style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
        />
      </div>
      <div className="week-usage-meta">
        <span>{fmtPct(used)} used</span>
        {usage.periodEnd && <span>reset {reset}</span>}
      </div>
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

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}%` : `${r.toFixed(1)}%`;
}

function Chip({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`chip ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-value">{value}</span>
    </div>
  );
}
