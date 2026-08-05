import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  TimelineFilterKind,
  TimelineItem,
  ManagedAgentInfo,
} from "../types";
import { writeClipboard } from "../utils/clipboard";
import { extractToolPath } from "../utils/paths";
import {
  prependHeightDelta,
  useVirtualWindow,
  type VirtualScrollMetrics,
} from "../hooks/useVirtualWindow";
import { DiffSnippet } from "./DiffSnippet";
import { FilePathLink } from "./FilePathLink";
import { Markdown } from "./Markdown";
import { ShellCard } from "./ShellPanel";
import { TimelineRowChrome, timelineStackClass } from "./TimelineRow";

const TIMELINE_FILTER_LABELS: Record<string, string> = {
  all: "All",
  user: "User",
  agent: "Agent",
  thought: "Thought",
  tool: "Tool",
  shell: "Shell",
  subagent: "Subagent",
  task: "Task",
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
  "subagent",
  "task",
  "event",
  "unknown",
];

export function TimelinePanel({
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
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<TimelineFilterKind>("all");
  const prevKeysRef = useRef<string[]>([]);

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
    for (const k of kindCounts.keys()) {
      if (!present.includes(k as TimelineFilterKind)) {
        present.push(k as TimelineFilterKind);
      }
    }
    return present;
  }, [kindCounts]);

  const syncFilterIndicator = useCallback(() => {
    const bar = filterBarRef.current;
    const activeChip = bar?.querySelector<HTMLElement>(
      `[data-filter-kind="${filter}"]`,
    );
    if (!bar || !activeChip) return;

    const activeStyle = getComputedStyle(activeChip);
    bar.style.setProperty("--filter-x", `${activeChip.offsetLeft}px`);
    bar.style.setProperty("--filter-y", `${activeChip.offsetTop}px`);
    bar.style.setProperty("--filter-width", `${activeChip.offsetWidth}px`);
    bar.style.setProperty("--filter-height", `${activeChip.offsetHeight}px`);
    bar.style.setProperty(
      "--filter-indicator-bg",
      activeStyle.getPropertyValue("--chip-bg-active"),
    );
    bar.classList.add("is-indicator-ready");
  }, [filter]);

  useLayoutEffect(() => {
    syncFilterIndicator();
    const bar = filterBarRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncFilterIndicator);
    observer.observe(bar);
    for (const chip of bar.querySelectorAll(".timeline-filter-chip")) {
      observer.observe(chip);
    }
    return () => observer.disconnect();
  }, [filterChips, syncFilterIndicator]);

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

  const itemKeys = useMemo(
    () => filtered.map(({ item }) => item.id),
    [filtered],
  );

  // Single scroll listener lives in useVirtualWindow; panel only updates stick/fade.
  const onScrollMetrics = useCallback((m: VirtualScrollMetrics) => {
    const dist = m.scrollHeight - m.scrollTop - m.clientHeight;
    stickToBottom.current = dist < 64;
    const root = rootRef.current;
    if (root) {
      root.style.setProperty(
        "--timeline-fade-offset",
        `${m.scrollTop - m.listTop}px`,
      );
    }
  }, []);

  const virtual = useVirtualWindow(itemKeys, rootRef, scrollParent, {
    onScrollMetrics,
  });

  // Keep scroll anchored when older pages prepend above the viewport.
  useLayoutEffect(() => {
    const prev = prevKeysRef.current;
    const next = itemKeys;
    const parent = scrollParentRef.current;
    if (parent && prev.length > 0) {
      const delta = prependHeightDelta(prev, next, virtual.heightOf);
      if (delta > 0) parent.scrollTop += delta;
    }
    prevKeysRef.current = next;
  }, [itemKeys, virtual.heightOf]);

  const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
    const end = endRef.current;
    const parent = scrollParentRef.current;
    if (end) {
      end.scrollIntoView({ block: "end", behavior });
      return;
    }
    if (parent) parent.scrollTop = parent.scrollHeight;
  };

  // Discover scroll parent once the list mounts (ownership stays here; virtual window consumes it).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let parent: HTMLElement | null = root.parentElement;
    while (parent) {
      const { overflowY } = getComputedStyle(parent);
      if (overflowY === "auto" || overflowY === "scroll") break;
      parent = parent.parentElement;
    }
    if (!parent) return;
    scrollParentRef.current = parent;
    setScrollParent(parent);
  }, [filtered.length > 0, filterChips.length]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollToEnd("auto");
  }, [filtered]);

  useEffect(() => {
    if (!stickToBottom.current || !virtual.active) return;
    scrollToEnd("auto");
  }, [virtual.totalHeight, virtual.active]);

  useEffect(() => {
    if (!pinBottomSeq) return;
    stickToBottom.current = true;
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

  const windowed = virtual.active
    ? filtered.slice(virtual.start, virtual.end)
    : filtered;

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
      <div
        ref={filterBarRef}
        className="timeline-filters"
        role="toolbar"
        aria-label="Timeline content filter"
      >
        <span className="timeline-filter-indicator" aria-hidden />
        {filterChips.map((k) => {
          const count = k === "all" ? items.length : (kindCounts.get(k) ?? 0);
          const label = TIMELINE_FILTER_LABELS[k] ?? k;
          return (
            <button
              key={k}
              type="button"
              data-filter-kind={k}
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
          }${virtual.active ? " is-virtualized" : ""}`}
          ref={rootRef}
          style={
            virtual.active
              ? { position: "relative", height: virtual.totalHeight }
              : undefined
          }
        >
          <div
            className={virtual.active ? "timeline-virtual-window" : undefined}
            style={
              virtual.active
                ? {
                    position: "absolute",
                    top: virtual.offsetTop,
                    left: 0,
                    right: 0,
                  }
                : undefined
            }
          >
            {windowed.map(({ item, sourceIndex }) => {
              const stackClass = timelineStackClass(
                items[sourceIndex - 1]?.kind,
                item.kind,
                items[sourceIndex + 1]?.kind,
              );
              if (!virtual.active) {
                return (
                  <LiveItemRow
                    key={item.id}
                    item={item}
                    stackClass={stackClass}
                    onOpenFile={onOpenFile}
                  />
                );
              }
              return (
                <div
                  key={item.id}
                  className="tl-row-measure"
                  ref={(el) => virtual.measureKey(item.id, el)}
                >
                  <LiveItemRow
                    item={item}
                    stackClass={stackClass}
                    onOpenFile={onOpenFile}
                  />
                </div>
              );
            })}
          </div>
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
  const useMarkdown = isMdKind && Boolean(item.detail) && !item.streaming;
  const toolPath =
    item.kind === "tool" && onOpenFile
      ? extractToolPath(item.detail, item.title)
      : null;

  const canCopy =
    (item.kind === "agent" || item.kind === "user") &&
    Boolean(item.detail?.trim()) &&
    !item.streaming;
  const isConversationBody = item.kind === "user" || item.kind === "agent";
  const copyAriaLabel =
    item.kind === "user" ? "Copy user message" : "Copy agent output";
  const displayTitle =
    item.kind === "thought"
      ? item.streaming && !item.detail?.trim()
        ? "Thinking…"
        : null
      : item.title;

  const copyDetail = useCallback(async () => {
    const text = item.detail?.trim();
    if (!text) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 600);
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
          {isConversationBody || !displayTitle ? null : toolPath ? (
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
                (canCopy ? " has-copy" : "")
              }
            >
              {useMarkdown ? (
                <Markdown onOpenFile={onOpenFile}>{item.detail}</Markdown>
              ) : isMdKind ? (
                <pre className="tl-stream-plain">{item.detail}</pre>
              ) : item.isEdit && item.detail ? (
                <DiffSnippet patch={item.detail} />
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
              {canCopy && (
                <div className="tl-detail-footer">
                  <button
                    type="button"
                    className={
                      "tl-copy-btn" + (copied ? " is-copied" : "")
                    }
                    title={copied ? "Copied" : copyAriaLabel}
                    aria-label={copied ? "Copied" : copyAriaLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyDetail();
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
