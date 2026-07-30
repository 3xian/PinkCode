import { useCallback, useEffect, useState } from "react";
import {
  getSessionCard,
  listSessionTokenUsages,
  listSessions,
  searchSessions,
} from "../api";
import type { SessionCard } from "../types";

const PAGE_SIZE = 30;
const TOKEN_USAGE_BATCH_SIZE = 8;

interface Options {
  selectedId: string | null;
  onRecentLoaded: (sessions: SessionCard[]) => void | Promise<void>;
  onError: (message: string | null) => void;
}

function mergeCardIntoList(cards: SessionCard[], next: SessionCard) {
  return cards.map((card) => (card.id === next.id ? next : card));
}

function mergeUsageIntoList(
  cards: SessionCard[],
  usages: Awaited<ReturnType<typeof listSessionTokenUsages>>,
) {
  const byId = new Map(usages.map((usage) => [usage.sessionId, usage]));
  return cards.map((card) => {
    const usage = byId.get(card.id);
    return usage
      ? {
          ...card,
          totalTokens: usage.totalTokens,
          tokenUsageIncomplete: usage.incomplete,
          tokenUsageAvailable: usage.available,
          tokenUsagePending: false,
        }
      : card;
  });
}

/** Owns the paged/searchable task-card index and deferred token hydration. */
export function useSessionIndex({
  selectedId,
  onRecentLoaded,
  onError,
}: Options) {
  const [recentSessions, setRecentSessions] = useState<SessionCard[]>([]);
  const [searchResults, setSearchResults] = useState<SessionCard[]>([]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const sessions = query.trim() ? searchResults : recentSessions;

  const refreshList = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    try {
      const page = await listSessions(limit + 1);
      const list = page.slice(0, limit);
      setHasMore(page.length > limit);
      setRecentSessions(list);
      onError(null);
      await onRecentLoaded(list);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [limit, onError, onRecentLoaded]);

  const refreshCard = useCallback(
    async (id: string) => {
      try {
        const card = await getSessionCard(id);
        setRecentSessions((previous) => {
          if (!previous.some((item) => item.id === id)) {
            return [card, ...previous].slice(0, limit);
          }
          return mergeCardIntoList(previous, card);
        });
        setSearchResults((previous) => mergeCardIntoList(previous, card));
      } catch {
        // A deleted or half-written task will be resolved by the next index refresh.
      }
    },
    [limit],
  );

  const mergeCard = useCallback((card: SessionCard) => {
    setRecentSessions((previous) => mergeCardIntoList(previous, card));
    setSearchResults((previous) => mergeCardIntoList(previous, card));
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchSessions(normalized)
        .then((list) => {
          if (!cancelled) setSearchResults(list);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    const pendingIds = sessions
      .filter((card) => card.tokenUsagePending && card.id !== selectedId)
      .slice(0, TOKEN_USAGE_BATCH_SIZE)
      .map((card) => card.id);
    if (pendingIds.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void listSessionTokenUsages(pendingIds)
        .then((usages) => {
          if (cancelled || usages.length === 0) return;
          setRecentSessions((cards) => mergeUsageIntoList(cards, usages));
          setSearchResults((cards) => mergeUsageIntoList(cards, usages));
        })
        .catch(() => {
          // A later card/index refresh retries pending usage.
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessions, selectedId]);

  return {
    sessions,
    query,
    setQuery,
    refreshList,
    refreshCard,
    mergeCard,
    hasMore: !query.trim() && hasMore,
    loadMore: () => setLimit((current) => current + PAGE_SIZE),
  };
}
