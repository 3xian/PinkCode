import { useEffect, useRef } from "react";
import type {
  LiveStreamItem,
  MainTab,
  ManagedAgentInfo,
  PendingPermission,
  SessionDetail as Detail,
  ShellEntry,
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
import { ShellPanel } from "./ShellPanel";

interface Props {
  detail: Detail | null;
  loading: boolean;
  error: string | null;
  tab: MainTab;
  onTab: (t: MainTab) => void;
  liveItems: LiveStreamItem[];
  shellEntries: ShellEntry[];
  managed: ManagedAgentInfo | null;
  permissions: PendingPermission[];
  permBusyKey: string | null;
  controlBusy: boolean;
  onSendPrompt: (text: string) => void;
  onAttach: () => void;
  onStop: () => void;
  onResolvePermission: (item: PendingPermission, optionId: string) => void;
}

export function SessionDetailView({
  detail,
  loading,
  error,
  tab,
  onTab,
  liveItems,
  shellEntries,
  managed,
  permissions,
  permBusyKey,
  controlBusy,
  onSendPrompt,
  onAttach,
  onStop,
  onResolvePermission,
}: Props) {
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

      {card.toolsUsed.length > 0 && (
        <div className="tool-tags">
          {card.toolsUsed.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="tabs">
        {(
          [
            ["live", "Live"],
            ["shell", "Shell"],
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
            {id === "shell" && shellEntries.length > 0 && (
              <span className="tab-count">{shellEntries.length}</span>
            )}
            {id === "diff" && detail.hunks.length > 0 && (
              <span className="tab-count">{detail.hunks.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === "live" && <LiveTimeline items={liveItems} managed={managed} />}
        {tab === "shell" && <ShellPanel entries={shellEntries} />}
        {tab === "timeline" && <HistoryTimeline detail={detail} />}
        {tab === "diff" && <DiffPanel hunks={detail.hunks} />}
        {tab === "raw" && <RawStream detail={detail} />}
      </div>

      <PromptBar
        managed={managed}
        busy={controlBusy}
        onSend={onSendPrompt}
        onAttach={onAttach}
        onStop={onStop}
        canAttach={!!detail}
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
}: {
  items: LiveStreamItem[];
  managed: ManagedAgentInfo | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

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
    const el = scrollParent;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = dist < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [items.length > 0]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="empty-hint">
        {managed
          ? "Waiting for ACP stream… send a prompt or wait for the agent."
          : "Attach or spawn this session to see live thought / tool / message chunks."}
      </div>
    );
  }

  // Chronological (oldest → newest), like a terminal tail
  return (
    <div className="timeline live-timeline" ref={rootRef}>
      {items.map((item) => (
        <div key={item.id} className={`tl-item kind-${item.kind}`}>
          <div className="tl-kind">{item.kind}</div>
          <div className="tl-body">
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
          </div>
        </div>
      ))}
      <div ref={endRef} className="live-timeline-end" aria-hidden />
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
