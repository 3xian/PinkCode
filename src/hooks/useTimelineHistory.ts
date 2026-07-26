import { useCallback, useEffect, useMemo, useState } from "react";
import { listSessionUpdates } from "../api";
import type { SessionDetail } from "../types";
import { extractUpdateEventId } from "../utils/format";

const TIMELINE_PAGE_SIZE = 250;

type TimelineHistoryState = {
  updates: unknown[];
  cursor: number | null;
  hasMore: boolean;
};

export interface TimelineHistoryController {
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
}

function updateIdentity(update: unknown): string {
  return extractUpdateEventId(update) ?? `json:${JSON.stringify(update)}`;
}

export function mergeUpdatePages(
  older: unknown[],
  newer: unknown[],
): unknown[] {
  const merged = new Map<string, unknown>();
  for (const update of older) merged.set(updateIdentity(update), update);
  for (const update of newer) merged.set(updateIdentity(update), update);
  return Array.from(merged.values());
}

export function useTimelineHistory(
  sessionId: string | null,
  detail: SessionDetail | null,
  hydrateDiskLive: (sessionId: string, updates: unknown[]) => void,
): TimelineHistoryController {
  const [bySession, setBySession] = useState<
    Map<string, TimelineHistoryState>
  >(() => new Map());
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!detail || detail.card.id !== sessionId) return;
    const id = detail.card.id;
    setBySession((previous) => {
      const current = previous.get(id);
      const nextState: TimelineHistoryState = current
        ? {
            ...current,
            updates: mergeUpdatePages(current.updates, detail.recentUpdates),
          }
        : {
            updates: detail.recentUpdates,
            cursor: detail.recentUpdatesCursor ?? null,
            hasMore: detail.recentUpdatesHasMore,
          };
      const next = new Map(previous);
      next.set(id, nextState);
      return next;
    });
  }, [detail, sessionId]);

  const history = sessionId ? bySession.get(sessionId) : undefined;

  useEffect(() => {
    if (!sessionId || !history) return;
    hydrateDiskLive(sessionId, history.updates);
  }, [history, hydrateDiskLive, sessionId]);

  const loadOlder = useCallback(async () => {
    if (
      !sessionId ||
      !history?.hasMore ||
      history.cursor == null ||
      loadingSessionId
    ) {
      return;
    }
    const requestedSessionId = sessionId;
    const requestedCursor = history.cursor;
    setLoadingSessionId(requestedSessionId);
    try {
      const page = await listSessionUpdates(
        requestedSessionId,
        requestedCursor,
        TIMELINE_PAGE_SIZE,
      );
      setBySession((previous) => {
        const current = previous.get(requestedSessionId);
        if (!current || current.cursor !== requestedCursor) return previous;
        const next = new Map(previous);
        next.set(requestedSessionId, {
          updates: mergeUpdatePages(page.updates, current.updates),
          cursor: page.nextCursor ?? null,
          hasMore: page.hasMore,
        });
        return next;
      });
    } finally {
      setLoadingSessionId((current) =>
        current === requestedSessionId ? null : current,
      );
    }
  }, [history, loadingSessionId, sessionId]);

  return useMemo(
    () => ({
      hasMore: history?.hasMore ?? false,
      loadingOlder: loadingSessionId === sessionId,
      loadOlder,
    }),
    [history?.hasMore, loadOlder, loadingSessionId, sessionId],
  );
}
