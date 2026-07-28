import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AvailableCommand,
  TimelineFilterKind,
  TimelineItem,
  MainTab,
  ManagedAgentInfo,
  PendingPermission,
  SessionMode,
  SessionDetail as Detail,
} from "../types";
import { writeClipboard } from "../utils/clipboard";
import {
  contextPct,
  formatDuration,
  formatRelative,
  formatTokens,
  shortPath,
} from "../utils/format";
import type { ResolvePermissionFn } from "../utils/permissionPayload";
import type { PromptQueueController } from "../hooks/usePromptQueueController";
import { extractToolPath } from "../utils/paths";
import { DiffPanel } from "./DiffPanel";
import { FilePathLink } from "./FilePathLink";
import { Markdown } from "./Markdown";
import { PermissionGate } from "./PermissionGate";
import { PromptBar } from "./PromptBar";
import { PromptQueue } from "./PromptQueue";
import { ShellCard } from "./ShellPanel";
import { TimelineRowChrome, timelineStackClass } from "./TimelineRow";
import { TurnStatusBar } from "./TurnStatusBar";

interface Props {
  detail: Detail | null;
  loading: boolean;
  error: string | null;
  tab: MainTab;
  onTab: (t: MainTab) => void;
  timelineItems: TimelineItem[];
  timelineHasMore: boolean;
  timelineHistoryLoading: boolean;
  onLoadOlderTimeline: () => Promise<void>;
  managed: ManagedAgentInfo | null;
  permissions: PendingPermission[];
  permBusyKey: string | null;
  controlBusy: boolean;
  sessionMode: SessionMode;
  onSessionModeChange: (mode: SessionMode) => void;
  onSendPrompt: (text: string) => void;
  promptQueue: PromptQueueController;
  onResolvePermission: ResolvePermissionFn;
  /** Stop the live agent for this task (confirm handled by parent). */
  onStopAgent?: () => void;
  /** Bump after connect/spawn to pin Timeline to the bottom. */
  pinTimelineBottomSeq?: number;
  /** Agent-advertised slash commands for the prompt autocomplete. */
  availableCommands?: AvailableCommand[];
  /** Open a project file path in the right-rail preview pane. */
  onOpenFile?: (path: string) => void;
}

const TIMELINE_FILTER_LABELS: Record<string, string> = {
  all: "All",
  user: "User",
  agent: "Agent",
  thought: "Thought",
  tool: "Tool",
  shell: "Shell",
  event: "Event",
  unknown: "Other",
};

const TIMELINE_FILTER_ORDER: TimelineFilterKind[] = [
  "all",
  "user",
  "agent",
  "thought",
  "tool",
  "shell",
  "event",
  "unknown",
];

export function SessionDetailView({
  detail,
  loading,
  error,
  tab,
  onTab,
  timelineItems,
  timelineHasMore,
  timelineHistoryLoading,
  onLoadOlderTimeline,
  managed,
  permissions,
  permBusyKey,
  controlBusy,
  sessionMode,
  onSessionModeChange,
  onSendPrompt,
  promptQueue,
  onResolvePermission,
  onStopAgent,
  pinTimelineBottomSeq = 0,
  availableCommands = [],
  onOpenFile,
}: Props) {
  const tabBodyRef = useRef<HTMLDivElement>(null);

  // Timeline pins to bottom; Diff / Raw expect top. Shared .tab-body
  // scroll container otherwise keeps Timeline scrollTop and hides content.
  useLayoutEffect(() => {
    if (tab === "timeline") return;
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
            Pick a session from the left, or create one with{" "}
            <strong>New</strong>. Timeline mirrors Grok Build on disk; send a
            message to connect live.
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
  const canStop =
    Boolean(onStopAgent) &&
    managed &&
    managed.status !== "stopped" &&
    managed.status !== "stopping";
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
        <div className="detail-header-main">
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
            {canStop && (
              <button
                type="button"
                className="btn danger-btn detail-stop-btn"
                disabled={controlBusy}
                title="Stop the agent process for this task"
                onClick={onStopAgent}
              >
                Stop
              </button>
            )}
          </div>
          <h1 title={card.title || undefined}>{card.title}</h1>
          <div className="detail-sub">
            <span title={card.cwd}>{shortPath(card.cwd, 64)}</span>
            {card.headBranch && (
              <span title={card.headBranch}>⎇ {card.headBranch}</span>
            )}
            <span>
              updated {formatRelative(card.lastActiveAt ?? card.updatedAt)}
            </span>
            <span className="mono" title={card.id}>
              {card.id.slice(0, 13)}…
            </span>
          </div>
        </div>

        <div className="metric-grid">
          <Metric
            label="Context"
            value={`${formatTokens(card.contextTokensUsed, { decimals: false })} / ${formatTokens(card.contextWindowTokens, { decimals: false })}`}
            bar={Math.round(pct)}
          />
          <Metric label="Turns" value={String(card.turnCount)} />
          <Metric
            label="Diff"
            value={`+${card.agentLinesAdded} / −${card.agentLinesRemoved}`}
          />
          <Metric
            label="Duration"
            value={formatDuration(card.sessionDurationSeconds)}
          />
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ["timeline", "Timeline"],
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
            {id === "timeline" && timelineItems.length > 0 && (
              <span className="tab-count">{timelineItems.length}</span>
            )}
            {id === "diff" && detail.recentHunks.hunks.length > 0 && (
              <span className="tab-count">
                {detail.recentHunks.hunks.length}
                {detail.recentHunks.hasMore ? "+" : ""}
              </span>
            )}
          </button>
        ))}
      </div>

      <div
        className={`tab-body${tab === "timeline" ? " tab-body-timeline" : ""}`}
        ref={tabBodyRef}
      >
        {tab === "timeline" && (
          <TimelinePanel
            items={timelineItems}
            managed={managed}
            pinBottomSeq={pinTimelineBottomSeq}
            onOpenFile={onOpenFile}
            hasMore={timelineHasMore}
            loadingOlder={timelineHistoryLoading}
            onLoadOlder={onLoadOlderTimeline}
          />
        )}
        {tab === "diff" && (
          <DiffPanel
            hunks={detail.recentHunks.hunks}
            totalFilesTouched={card.agentFilesTouched}
            hasMore={detail.recentHunks.hasMore}
            onOpenFile={onOpenFile}
          />
        )}
        {tab === "raw" && <RawStream detail={detail} />}
      </div>

      <PromptQueue controller={promptQueue} />
      <TurnStatusBar
        managed={managed}
        timelineItems={timelineItems}
        sessionIsActive={Boolean(card?.isActive)}
      />
      <PromptBar
        managed={managed}
        busy={controlBusy}
        sessionMode={sessionMode}
        onSessionModeChange={onSessionModeChange}
        onSend={onSendPrompt}
        availableCommands={availableCommands}
        timelineItems={timelineItems}
        sessionId={card?.id ?? null}
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
  /** 0–100: fill the whole block as a progress background (no inner bar). */
  bar?: number;
}) {
  const fill =
    typeof bar === "number"
      ? Math.max(0, Math.min(100, Math.round(bar)))
      : null;
  return (
    <div
      className={`metric${fill != null ? " metric-progress" : ""}`}
      style={
        fill != null
          ? ({ "--metric-pct": `${fill}%` } as CSSProperties)
          : undefined
      }
      title={fill != null ? `${fill}% context used` : undefined}
    >
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function TimelinePanel({
  items,
  managed,
  pinBottomSeq = 0,
  onOpenFile,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: {
  items: TimelineItem[];
  managed: ManagedAgentInfo | null;
  pinBottomSeq?: number;
  onOpenFile?: (path: string) => void;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const [filter, setFilter] = useState<TimelineFilterKind>("all");

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const k = item.kind || "unknown";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filterChips = useMemo(() => {
    const present = TIMELINE_FILTER_ORDER.filter(
      (k) => k === "all" || (kindCounts.get(k) ?? 0) > 0,
    );
    // Any unexpected kinds (not in order list)
    for (const k of kindCounts.keys()) {
      if (!present.includes(k as TimelineFilterKind)) {
        present.push(k as TimelineFilterKind);
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
    const indexed = items.map((item, sourceIndex) => ({ item, sourceIndex }));
    if (filter === "all") return indexed;
    return indexed.filter(
      ({ item }) => (item.kind || "unknown") === filter,
    );
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

  // Connect / spawn: always jump to bottom (even if user had scrolled up earlier).
  useEffect(() => {
    if (!pinBottomSeq) return;
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
  }, [pinBottomSeq]);

  if (items.length === 0 && !hasMore) {
    return (
      <div className="empty-hint">
        {managed
          ? "Waiting for ACP stream… send a prompt or wait for the agent."
          : "No stream yet. Timeline mirrors Grok Build on disk; send a message to connect live."}
      </div>
    );
  }

  // Chronological (oldest → newest), like a terminal tail
  return (
    <div className="timeline-panel-wrap">
      {hasMore && (
        <div className="timeline-history-control">
          <button
            type="button"
            className="btn"
            disabled={loadingOlder}
            onClick={() => {
              stickToBottom.current = false;
              void onLoadOlder();
            }}
          >
            {loadingOlder ? "Loading…" : "Load earlier activity"}
          </button>
        </div>
      )}
      <div className="timeline-filters" role="toolbar" aria-label="Timeline content filter">
        {filterChips.map((k) => {
          const count = k === "all" ? items.length : (kindCounts.get(k) ?? 0);
          const label = TIMELINE_FILTER_LABELS[k] ?? k;
          return (
            <button
              key={k}
              type="button"
              className={`timeline-filter-chip filter-${k}${
                filter === k ? " active" : ""
              }`}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
            >
              {label}
              <span className="timeline-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-hint">
          No <strong>{TIMELINE_FILTER_LABELS[filter] ?? filter}</strong> items in
          this stream.
        </div>
      ) : (
        <div
          className={`timeline stream-timeline${
            filter === "all" ? "" : " is-filtered"
          }`}
          ref={rootRef}
        >
          {filtered.map(({ item, sourceIndex }) => (
            <LiveItemRow
              key={item.id}
              item={item}
              stackClass={timelineStackClass(
                items[sourceIndex - 1]?.kind,
                item.kind,
                items[sourceIndex + 1]?.kind,
              )}
              onOpenFile={onOpenFile}
            />
          ))}
          <div ref={endRef} className="timeline-panel-end" aria-hidden />
        </div>
      )}
    </div>
  );
}

/**
 * One Timeline row. Memoized so streaming updates to the tail card do not
 * re-parse Markdown / re-layout every prior item.
 */
const LiveItemRow = memo(function LiveItemRow({
  item,
  stackClass,
  onOpenFile,
}: {
  item: TimelineItem;
  stackClass: string;
  onOpenFile?: (path: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const isMdKind =
    item.kind === "agent" || item.kind === "user" || item.kind === "thought";
  // While chunks are still coalescing, skip react-markdown (O(len) per frame).
  const useMarkdown = isMdKind && Boolean(item.detail) && !item.streaming;
  // Tool cards often put a path in detail or backtick-title — open on click.
  const toolPath =
    item.kind === "tool" && onOpenFile
      ? extractToolPath(item.detail, item.title)
      : null;

  const canCopyAgent =
    item.kind === "agent" && Boolean(item.detail?.trim()) && !item.streaming;
  const isConversationBody = item.kind === "user" || item.kind === "agent";
  const displayTitle =
    item.kind === "thought"
      ? item.streaming
        ? "Thinking…"
        : "Thought"
      : item.title;

  const copyAgentOutput = useCallback(async () => {
    const text = item.detail?.trim();
    if (!text) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [item.detail]);

  return (
    <TimelineRowChrome kind={item.kind} ts={item.ts} stackClass={stackClass}>
      {item.kind === "shell" && item.shell ? (
        <ShellCard shell={item.shell} />
      ) : (
        <>
          {isConversationBody ? null : toolPath ? (
            <FilePathLink
              path={toolPath}
              onOpen={onOpenFile}
              className="tl-title"
            >
              {displayTitle}
            </FilePathLink>
          ) : (
            <div className="tl-title">{displayTitle}</div>
          )}
          {item.detail && (
            <div
              className={
                "tl-detail" +
                (isConversationBody ? " tl-conversation-body" : "") +
                (canCopyAgent ? " has-copy" : "")
              }
            >
              {useMarkdown ? (
                <Markdown onOpenFile={onOpenFile}>{item.detail}</Markdown>
              ) : isMdKind ? (
                <pre className="tl-stream-plain">{item.detail}</pre>
              ) : toolPath && item.detail === toolPath ? (
                <FilePathLink
                  path={toolPath}
                  onOpen={onOpenFile}
                  className="tl-detail-path"
                >
                  {item.detail}
                </FilePathLink>
              ) : (
                item.detail
              )}
              {canCopyAgent && (
                <div className="tl-detail-footer">
                  <button
                    type="button"
                    className={
                      "tl-copy-btn" + (copied ? " is-copied" : "")
                    }
                    title={copied ? "Copied" : "Copy agent output"}
                    aria-label={copied ? "Copied" : "Copy agent output"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyAgentOutput();
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </TimelineRowChrome>
  );
});

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
