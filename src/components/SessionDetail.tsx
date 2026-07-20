import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  LiveFilterKind,
  LiveStreamItem,
  MainTab,
  ManagedAgentInfo,
  PendingPermission,
  PermissionMode,
  SessionDetail as Detail,
} from "../types";
import {
  contextPct,
  formatDuration,
  formatRelative,
  formatTokens,
  shortPath,
  describeUpdate,
} from "../utils/format";
import { DiffPanel } from "./DiffPanel";
import { Markdown } from "./Markdown";
import { PermissionGate } from "./PermissionGate";
import { PromptBar } from "./PromptBar";
import { ShellCard } from "./ShellPanel";

interface Props {
  detail: Detail | null;
  loading: boolean;
  error: string | null;
  tab: MainTab;
  onTab: (t: MainTab) => void;
  liveItems: LiveStreamItem[];
  managed: ManagedAgentInfo | null;
  permissions: PendingPermission[];
  permBusyKey: string | null;
  controlBusy: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSendPrompt: (text: string) => void;
  onResolvePermission: (item: PendingPermission, optionId: string) => void;
  /** Bump after attach/spawn to force Live stream to the bottom. */
  pinLiveBottomSeq?: number;
}

const LIVE_FILTER_LABELS: Record<string, string> = {
  all: "All",
  user: "User",
  agent: "Agent",
  thought: "Thought",
  tool: "Tool",
  shell: "Shell",
  plan: "Plan",
  event: "Event",
  unknown: "Other",
};

const LIVE_FILTER_ORDER: LiveFilterKind[] = [
  "all",
  "user",
  "agent",
  "thought",
  "tool",
  "shell",
  "plan",
  "event",
  "unknown",
];

export function SessionDetailView({
  detail,
  loading,
  error,
  tab,
  onTab,
  liveItems,
  managed,
  permissions,
  permBusyKey,
  controlBusy,
  permissionMode,
  onPermissionModeChange,
  onSendPrompt,
  onResolvePermission,
  pinLiveBottomSeq = 0,
}: Props) {
  const tabBodyRef = useRef<HTMLDivElement>(null);

  // Live pins to bottom; History / Diff / Raw expect top. Shared .tab-body
  // scroll container otherwise keeps Live's scrollTop and hides content.
  // useLayoutEffect: reset before paint so History is not blank for a frame.
  useLayoutEffect(() => {
    if (tab === "live") return;
    const el = tabBodyRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [tab, detail?.card.id]);

  if (loading && !detail) {
    return (
      <section className="detail-panel">
        <div className="empty-state">Loading session…</div>
      </section>
    );
  }

  if (error && !detail) {
    return (
      <section className="detail-panel">
        <div className="empty-state error-text">{error}</div>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="detail-panel">
        <div className="empty-state">
          <h2>Select a task</h2>
          <p>
            Pick a session from the left, or spawn a new agent with{" "}
            <strong>New task</strong>. Live ACP streams appear in the Live tab.
          </p>
        </div>
      </section>
    );
  }

  const { card } = detail;
  const pct = contextPct(card.contextTokensUsed, card.contextWindowTokens);
  const isManagedLive =
    managed &&
    managed.status !== "stopped" &&
    managed.status !== "error";
  const awaiting =
    managed?.status === "awaitingPermission" || permissions.length > 0;

  return (
    <section className="detail-panel">
      <PermissionGate
        items={permissions}
        busyKey={permBusyKey}
        onResolve={onResolvePermission}
      />

      <div className="detail-header">
        <div>
          <div className="detail-status-row">
            <span
              className={`pill ${
                awaiting
                  ? "danger"
                  : isManagedLive || card.isActive
                    ? "live"
                    : "idle"
              }`}
            >
              {awaiting
                ? `◆ AWAITING PERMISSION (${permissions.length || managed?.pendingPermissionCount || 0})`
                : isManagedLive
                  ? `● ${managed.status.toUpperCase()}${managed.pid ? ` · pid ${managed.pid}` : ""}`
                  : card.isActive
                    ? `● LIVE · pid ${card.activePid}`
                    : "○ idle"}
            </span>
            {card.modelId && <span className="pill muted-pill">{card.modelId}</span>}
            {card.agentName && (
              <span className="pill muted-pill">{card.agentName}</span>
            )}
            {card.errorCount > 0 && (
              <span className="pill danger">{card.errorCount} errors</span>
            )}
          </div>
          <h1>{card.title}</h1>
          <div className="detail-sub">
            <span title={card.cwd}>{shortPath(card.cwd, 64)}</span>
            {card.headBranch && <span>⎇ {card.headBranch}</span>}
            <span>updated {formatRelative(card.lastActiveAt ?? card.updatedAt)}</span>
            <span className="mono">{card.id.slice(0, 13)}…</span>
          </div>
        </div>

        <div className="metric-grid">
          <Metric
            label="Context"
            value={`${formatTokens(card.contextTokensUsed)} / ${formatTokens(card.contextWindowTokens)}`}
            bar={pct}
          />
          <Metric label="Turns" value={String(card.turnCount)} />
          <Metric label="Tools" value={String(card.toolCallCount)} />
          <Metric
            label="Diff"
            value={`+${card.agentLinesAdded} / −${card.agentLinesRemoved}`}
          />
          <Metric label="Files" value={String(card.agentFilesTouched)} />
          <Metric
            label="Duration"
            value={formatDuration(card.sessionDurationSeconds)}
          />
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ["live", "Live"],
            ["timeline", "History"],
            ["diff", "File changes"],
            ["raw", "Raw stream"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => onTab(id)}
          >
            {label}
            {id === "live" && liveItems.length > 0 && (
              <span className="tab-count">{liveItems.length}</span>
            )}
            {id === "diff" && detail.hunks.length > 0 && (
              <span className="tab-count">{detail.hunks.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="tab-body" ref={tabBodyRef}>
        {tab === "live" && (
          <LiveTimeline
            items={liveItems}
            managed={managed}
            pinToBottomSeq={pinLiveBottomSeq}
          />
        )}
        {tab === "timeline" && <HistoryTimeline detail={detail} />}
        {tab === "diff" && <DiffPanel hunks={detail.hunks} />}
        {tab === "raw" && <RawStream detail={detail} />}
      </div>

      <PromptBar
        managed={managed}
        busy={controlBusy}
        permissionMode={permissionMode}
        onPermissionModeChange={onPermissionModeChange}
        onSend={onSendPrompt}
      />
    </section>
  );
}

function Metric({
  label,
  value,
  bar,
}: {
  label: string;
  value: string;
  bar?: number;
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {typeof bar === "number" && (
        <div className="meter">
          <div className="meter-fill" style={{ width: `${bar}%` }} />
        </div>
      )}
    </div>
  );
}

function LiveTimeline({
  items,
  managed,
  pinToBottomSeq = 0,
}: {
  items: LiveStreamItem[];
  managed: ManagedAgentInfo | null;
  pinToBottomSeq?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<LiveFilterKind>("all");

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const k = item.kind || "unknown";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filterChips = useMemo(() => {
    const present = LIVE_FILTER_ORDER.filter(
      (k) => k === "all" || (kindCounts.get(k) ?? 0) > 0,
    );
    // Any unexpected kinds (not in order list)
    for (const k of kindCounts.keys()) {
      if (!present.includes(k as LiveFilterKind)) {
        present.push(k as LiveFilterKind);
      }
    }
    return present;
  }, [kindCounts]);

  // If active filter has zero items, fall back to All
  useEffect(() => {
    if (filter === "all") return;
    if ((kindCounts.get(filter) ?? 0) === 0) setFilter("all");
  }, [filter, kindCounts]);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => (i.kind || "unknown") === filter);
  }, [items, filter]);

  const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
    const end = endRef.current;
    const parent = scrollParentRef.current;
    if (end) {
      end.scrollIntoView({ block: "end", behavior });
      return;
    }
    if (parent) {
      parent.scrollTop = parent.scrollHeight;
    }
  };

  // Terminal-style: follow the tail unless the user scrolls up
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let scrollParent: HTMLElement | null = root.parentElement;
    while (scrollParent) {
      const { overflowY } = getComputedStyle(scrollParent);
      if (overflowY === "auto" || overflowY === "scroll") break;
      scrollParent = scrollParent.parentElement;
    }
    if (!scrollParent) return;
    scrollParentRef.current = scrollParent;
    const el = scrollParent;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = dist < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [filtered.length > 0]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollToEnd("auto");
  }, [filtered]);

  // Attach / spawn: always jump to bottom (even if user had scrolled up earlier).
  useEffect(() => {
    if (!pinToBottomSeq) return;
    stickToBottom.current = true;
    // Wait for tab switch + first paint, then again after stream content may land.
    const t0 = window.requestAnimationFrame(() => scrollToEnd("smooth"));
    const t1 = window.setTimeout(() => scrollToEnd("smooth"), 80);
    const t2 = window.setTimeout(() => scrollToEnd("auto"), 320);
    return () => {
      window.cancelAnimationFrame(t0);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [pinToBottomSeq]);

  if (items.length === 0) {
    return (
      <div className="empty-hint">
        {managed
          ? "Waiting for ACP stream… send a prompt or wait for the agent."
          : "Flip the task card switch to attach, or spawn a new task, to stream thought / tool / shell / message chunks."}
      </div>
    );
  }

  // Chronological (oldest → newest), like a terminal tail
  return (
    <div className="live-timeline-wrap">
      <div className="live-filters" role="toolbar" aria-label="Live content filter">
        {filterChips.map((k) => {
          const count = k === "all" ? items.length : (kindCounts.get(k) ?? 0);
          const label = LIVE_FILTER_LABELS[k] ?? k;
          return (
            <button
              key={k}
              type="button"
              className={`live-filter-chip ${filter === k ? "active" : ""}`}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
            >
              {label}
              <span className="live-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-hint">
          No <strong>{LIVE_FILTER_LABELS[filter] ?? filter}</strong> items in
          this stream.
        </div>
      ) : (
        <div className="timeline live-timeline" ref={rootRef}>
          {filtered.map((item) => (
            <div key={item.id} className={`tl-item kind-${item.kind}`}>
              <div className="tl-kind">{item.kind}</div>
              <div className="tl-body">
                {item.kind === "shell" && item.shell ? (
                  <ShellCard shell={item.shell} />
                ) : (
                  <>
                    <div className="tl-title">{item.title}</div>
                    {item.detail && (
                      <div className="tl-detail">
                        {item.kind === "agent" ||
                        item.kind === "user" ||
                        item.kind === "thought" ? (
                          <Markdown>{item.detail}</Markdown>
                        ) : (
                          item.detail
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} className="live-timeline-end" aria-hidden />
        </div>
      )}
    </div>
  );
}

function HistoryTimeline({ detail }: { detail: Detail }) {
  const source =
    detail.recentUpdates.length > 0
      ? detail.recentUpdates
      : detail.recentEvents;

  const items = source
    .map((u, i) => ({ ...describeUpdate(u), key: i }))
    .filter((x) => x.kind !== "thought" || (x.detail && x.detail.length > 8));

  const ordered = [...items].reverse();

  if (ordered.length === 0) {
    return <div className="empty-hint">No stream events recorded on disk yet.</div>;
  }

  return (
    <div className="timeline">
      {ordered.map((item) => (
        <div key={item.key} className={`tl-item kind-${item.kind}`}>
          <div className="tl-kind">{item.kind}</div>
          <div className="tl-body">
            <div className="tl-title">{item.title}</div>
            {item.detail && <div className="tl-detail">{item.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function RawStream({ detail }: { detail: Detail }) {
  const sample = detail.recentUpdates.slice(-5);
  return (
    <div className="raw-stream">
      <p className="muted small">
        Last {sample.length} ACP <code>session/update</code> records (tail of
        updates.jsonl).
      </p>
      <pre>{JSON.stringify(sample, null, 2)}</pre>
    </div>
  );
}
