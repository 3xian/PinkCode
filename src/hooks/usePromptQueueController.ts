import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearQueuedPrompts,
  editQueuedPrompt,
  interjectQueuedPrompt,
  removeQueuedPrompt,
  reorderQueuedPrompts,
} from "../api";
import type {
  AgentUpdateEvent,
  ManagedAgentInfo,
  PromptQueueEntry,
  PromptQueueState,
} from "../types";
import { normalizePromptQueue } from "../utils/promptQueue";

export interface PromptQueueController {
  queue: PromptQueueState | null;
  remove: (entry: PromptQueueEntry) => Promise<void>;
  edit: (entry: PromptQueueEntry, text: string) => Promise<void>;
  reorder: (orderedIds: string[]) => Promise<void>;
  clear: () => Promise<void>;
  interject: (entry: PromptQueueEntry) => Promise<void>;
}

type QueueSnapshot = {
  sessionId: string;
  queue: PromptQueueState;
};

export function usePromptQueueController(
  selectedSessionId: string | null,
  managed: ManagedAgentInfo | null,
  setError: (message: string | null) => void,
): PromptQueueController {
  const [queueByHandle, setQueueByHandle] = useState<
    Map<string, QueueSnapshot>
  >(() => new Map());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentUpdateEvent>("agent-notification", ({ payload }) => {
      if (cancelled || payload.method !== "x.ai/queue/changed") return;
      const queue = normalizePromptQueue(payload.params, payload.sessionId);
      if (!queue) return;
      setQueueByHandle((previous) => {
        const next = new Map(previous);
        next.set(payload.handleId, { sessionId: queue.sessionId, queue });
        return next;
      });
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleId =
    managed &&
    managed.sessionId === selectedSessionId &&
    managed.status !== "stopped" &&
    managed.status !== "stopping" &&
    managed.status !== "error"
      ? managed.handleId
      : null;

  const queue = useMemo(() => {
    if (!handleId || !selectedSessionId) return null;
    const snapshot = queueByHandle.get(handleId);
    return snapshot?.sessionId === selectedSessionId ? snapshot.queue : null;
  }, [handleId, queueByHandle, selectedSessionId]);

  const execute = useCallback(
    async (action: (activeHandleId: string) => Promise<void>) => {
      setError(null);
      if (!handleId) {
        const error = new Error("Connect this task before managing its queue.");
        setError(error.message);
        throw error;
      }
      try {
        await action(handleId);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    [handleId, setError],
  );

  return useMemo(
    () => ({
      queue,
      remove: (entry) =>
        execute((activeHandleId) => removeQueuedPrompt(activeHandleId, entry)),
      edit: (entry, text) =>
        execute((activeHandleId) =>
          editQueuedPrompt(activeHandleId, entry.id, text),
        ),
      reorder: (orderedIds) =>
        execute((activeHandleId) =>
          reorderQueuedPrompts(activeHandleId, orderedIds),
        ),
      clear: () =>
        execute((activeHandleId) => clearQueuedPrompts(activeHandleId)),
      interject: (entry) =>
        execute((activeHandleId) =>
          interjectQueuedPrompt(activeHandleId, entry),
        ),
    }),
    [execute, queue],
  );
}
