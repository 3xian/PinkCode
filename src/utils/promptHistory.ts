/**
 * Session prompt history for Up/Down browse (Grok Build-style).
 *
 * Grok renders the overlay with **oldest at top, newest at bottom**
 * (nearest the composer). Selection opens on the newest row; Up moves
 * older, Down at newest closes. See `HistorySearchState` + agent render.
 */

export interface PromptHistorySource {
  /** Timeline user cards (chronological, oldest → newest). */
  timelineUserTexts: string[];
  /**
   * Prompts sent in this session from the composer (newest-first).
   * Covers the race before the turn lands on the timeline.
   */
  localSentNewestFirst?: string[];
}

/**
 * Build history for the overlay: **oldest → newest** (index 0 = oldest,
 * last = newest). Deduped by `text.trim()`.
 */
export function buildPromptHistory(source: PromptHistorySource): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];

  const push = (raw: string) => {
    const key = raw.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    newestFirst.push(raw);
  };

  for (const t of source.localSentNewestFirst ?? []) {
    push(t);
  }

  for (let i = source.timelineUserTexts.length - 1; i >= 0; i--) {
    push(source.timelineUserTexts[i] ?? "");
  }

  newestFirst.reverse();
  return newestFirst;
}

/** Index into oldest→newest list, or a panel action. */
export type HistoryBrowseResult = number | "close" | "noop";

/** Open browse: newest index. Empty history → quiet no-op. */
export function openHistoryBrowse(history: string[]): HistoryBrowseResult {
  if (history.length === 0) return "noop";
  return history.length - 1;
}

/** Up while browsing: move toward older. No wrap. */
export function historyBrowseUp(
  history: string[],
  index: number,
): HistoryBrowseResult {
  if (history.length === 0) return "close";
  return Math.max(0, index - 1);
}

/** Down while browsing: toward newer; at newest → close. */
export function historyBrowseDown(
  history: string[],
  index: number,
): HistoryBrowseResult {
  if (history.length === 0) return "close";
  if (index >= history.length - 1) return "close";
  return index + 1;
}

/** One-line preview for the history list row. */
export function historyRowPreview(text: string, maxLen = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= maxLen) return one;
  return `${one.slice(0, maxLen - 1)}…`;
}
