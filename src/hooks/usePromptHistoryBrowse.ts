import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { TimelineItem } from "../types";
import {
  buildPromptHistory,
  historyBrowseDown,
  historyBrowseUp,
  openHistoryBrowse,
  type HistoryBrowseResult,
} from "../utils/promptHistory";

/** Cap local sent list (Grok session.prompt_history truncates at 200). */
const LOCAL_SENT_MAX = 200;

export interface PromptHistoryBrowse {
  /** Panel open (selection index non-null). */
  active: boolean;
  /** Index into `entries` (oldest→newest; last = newest). */
  selected: number | null;
  /** History rows for the overlay. */
  entries: string[];
  listRef: RefObject<HTMLDivElement | null>;
  /** Record a sent prompt (wire text as shown on the timeline). */
  recordSent: (sentText: string) => void;
  /** Close panel only; keep current composer text (typing detach / accept). */
  detach: () => void;
  /** Close panel and clear composer (Esc / Down past newest). */
  cancel: () => void;
  /** Accept a concrete entry (Enter / click). */
  accept: (entry: string) => void;
  /** Highlight + live-populate composer. */
  select: (index: number) => void;
  /**
   * History key path. Returns true when the event was consumed
   * (PromptBar must not fall through to slash / send).
   */
  handleKey: (e: KeyboardEvent) => boolean;
}

/**
 * Grok-style empty-↑ history panel: list overlay + live-populate composer.
 * Pure navigation lives in `promptHistory.ts`; this hook owns UI state.
 */
export function usePromptHistoryBrowse(opts: {
  sessionId: string | null;
  timelineItems: TimelineItem[];
  text: string;
  setText: (next: string) => void;
  focusEnd: (value: string) => void;
  /** Close slash menu / suppress re-open when history takes over. */
  onHistoryExclusive: () => void;
  /**
   * Host chrome reset on session switch (slash menu, suppress flags).
   * Composer text is cleared here so session reset is single-owner.
   */
  onSessionReset?: () => void;
}): PromptHistoryBrowse {
  const {
    sessionId,
    timelineItems,
    text,
    setText,
    focusEnd,
    onHistoryExclusive,
    onSessionReset,
  } = opts;

  const [selected, setSelected] = useState<number | null>(null);
  const [localSent, setLocalSent] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const onSessionResetRef = useRef(onSessionReset);
  onSessionResetRef.current = onSessionReset;
  /** `undefined` = not yet mounted; skip wipe on first effect run. */
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);

  const timelineUserTexts = useMemo(
    () =>
      timelineItems
        .filter((item) => item.kind === "user")
        .map((item) => item.detail ?? "")
        .filter((t) => t.trim().length > 0),
    [timelineItems],
  );

  const entries = useMemo(
    () =>
      buildPromptHistory({
        timelineUserTexts,
        localSentNewestFirst: localSent,
      }),
    [timelineUserTexts, localSent],
  );

  // Only wipe on real session switches — not on first mount (avoids clearing a
  // remounted composer draft when sessionId is unchanged).
  useEffect(() => {
    if (prevSessionIdRef.current === undefined) {
      prevSessionIdRef.current = sessionId;
      return;
    }
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setSelected(null);
    setLocalSent([]);
    setText("");
    focusEnd("");
    onSessionResetRef.current?.();
  }, [sessionId, setText, focusEnd]);

  // Close panel if the list empties or selected index becomes invalid.
  useEffect(() => {
    if (selected == null) return;
    if (entries.length === 0 || selected >= entries.length) {
      setSelected(null);
    }
  }, [entries.length, selected]);

  // Keep the active row in view.
  useEffect(() => {
    if (selected == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-hist-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected, entries.length]);

  const select = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry == null) return;
      onHistoryExclusive();
      setSelected(index);
      setText(entry);
      focusEnd(entry);
    },
    [entries, focusEnd, onHistoryExclusive, setText],
  );

  const cancel = useCallback(() => {
    setSelected(null);
    onHistoryExclusive();
    setText("");
    focusEnd("");
  }, [focusEnd, onHistoryExclusive, setText]);

  const applyBrowseResult = useCallback(
    (result: HistoryBrowseResult) => {
      if (typeof result === "number") select(result);
      else if (result === "close") cancel();
      // "noop": consume key, no panel
    },
    [cancel, select],
  );

  const detach = useCallback(() => {
    setSelected(null);
  }, []);

  const accept = useCallback(
    (entry: string) => {
      setSelected(null);
      onHistoryExclusive();
      setText(entry);
      focusEnd(entry);
    },
    [focusEnd, onHistoryExclusive, setText],
  );

  const recordSent = useCallback((sentText: string) => {
    const key = sentText.trim();
    if (!key) return;
    setLocalSent((prev) => {
      const next = [sentText, ...prev.filter((t) => t.trim() !== key)];
      return next.slice(0, LOCAL_SENT_MAX);
    });
  }, []);

  const handleKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (e.altKey || e.ctrlKey || e.metaKey) return false;

      if (selected != null) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          applyBrowseResult(historyBrowseUp(entries, selected));
          return true;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          applyBrowseResult(historyBrowseDown(entries, selected));
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return true;
        }
        // Any Enter (incl. Shift+Enter) accepts — never fall through to send.
        if (e.key === "Enter") {
          e.preventDefault();
          const entry = entries[selected];
          if (entry != null) accept(entry);
          else cancel();
          return true;
        }
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          const entry = entries[selected];
          if (entry != null) accept(entry);
          else cancel();
          return true;
        }
        // Printable keys: detach; onChange keeps the edited text.
        return false;
      }

      // Empty composer only (Grok: draft blocks open; Down never opens).
      if (text.length !== 0) return false;

      if (e.key === "ArrowUp" && !e.shiftKey) {
        e.preventDefault();
        applyBrowseResult(openHistoryBrowse(entries));
        return true;
      }
      if (e.key === "ArrowDown" && !e.shiftKey) {
        e.preventDefault();
        return true;
      }
      return false;
    },
    [accept, applyBrowseResult, cancel, entries, selected, text.length],
  );

  return {
    active: selected != null,
    selected,
    entries,
    listRef,
    recordSent,
    detach,
    cancel,
    accept,
    select,
    handleKey,
  };
}
