import type { DashboardStats } from "../types";
import { formatTokens } from "../utils/format";
import logo from "../assets/logo.png";

interface Props {
  stats: DashboardStats | null;
  managedCount: number;
  pendingPermissions: number;
  onNewTask: () => void;
}

export function StatsBar({
  stats,
  managedCount,
  pendingPermissions,
  onNewTask,
}: Props) {
  return (
    <header className="stats-bar">
      <div className="brand">
        <img src={logo} alt="MarsBuild" className="brand-logo" />
        <div>
          <div className="brand-name">MarsBuild</div>
          <div className="brand-sub">Grok Control Plane</div>
        </div>
      </div>

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
