import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentUpdateEvent,
  AvailableCommand,
  TimelineItem,
  ManagedAgentInfo,
  PendingPermission,
  ShellEntry,
} from "../types";
import type { LocalSlashItem } from "../utils/localSlash";
import { describeUpdate, extractUpdateTsMs } from "../utils/format";
import {
  LOCAL_HANDLE_ID,
  hydrateLiveFromDiskUpdates,
  isTextUpdate,
  mergeDiskLiveIntoMap,
  reduceAgentUpdate,
  reduceShellUpdate,
  sameManagedAgent,
  settleStreamingItems,
  shouldDropUpdate,
} from "./liveTimeline";

/** After last text chunk for a handle, mark its streaming cards settled. */
const STREAM_SETTLE_MS = 320;

export interface AgentEventsOptions {
  /** ACP current_mode_update (plan ↔ default). Prefer over window events. */
  onCurrentModeUpdate?: (sessionId: string, modeId: string) => void;
}

export function useAgentEvents(
  selectedSessionId: string | null,
  options?: AgentEventsOptions,
) {
  const onCurrentModeUpdateRef = useRef(options?.onCurrentModeUpdate);
  onCurrentModeUpdateRef.current = options?.onCurrentModeUpdate;

  const [managed, setManaged] = useState<Map<string, ManagedAgentInfo>>(
    () => new Map(),
  );
  const [liveBySession, setLiveBySession] = useState<
    Map<string, TimelineItem[]>
  >(() => new Map());
  /** Slash commands advertised by the agent, keyed by sessionId or handleId. */
  const [commandsByKey, setCommandsByKey] = useState<
    Map<string, AvailableCommand[]>
  >(() => new Map());
  const [permissions, setPermissions] = useState<Map<string, PendingPermission>>(
    () => new Map(),
  );
  const [lastError, setLastError] = useState<string | null>(null);
  const seq = useRef(0);
  /** Latest live map for rAF batching (avoids setState-to-read anti-pattern). */
  const liveRef = useRef(liveBySession);
  liveRef.current = liveBySession;

  const clearError = useCallback(() => setLastError(null), []);

  const upsertManaged = useCallback((info: ManagedAgentInfo) => {
    setManaged((prev) => {
      const existing = prev.get(info.handleId);
      // Avoid re-render storms when poll returns identical managed agents.
      if (existing && sameManagedAgent(existing, info)) {
        return prev;
      }
      const next = new Map(prev);
      next.set(info.handleId, info);
      return next;
    });
  }, []);

  const removeManaged = useCallback((handleId: string) => {
    setManaged((prev) => {
      if (!prev.has(handleId)) return prev;
      const next = new Map(prev);
      next.delete(handleId);
      return next;
    });
    setPermissions((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [k, p] of next) {
        if (p.handleId === handleId) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const removePermission = useCallback((requestKey: string) => {
    setPermissions((prev) => {
      if (!prev.has(requestKey)) return prev;
      const next = new Map(prev);
      next.delete(requestKey);
      return next;
    });
  }, []);

  /** Hydrate permissions already queued on the backend (e.g. after attach). */
  const hydratePermissions = useCallback((list: PendingPermission[]) => {
    if (!list.length) return;
    setPermissions((prev) => {
      const next = new Map(prev);
      for (const p of list) {
        next.set(p.requestKey, p);
      }
      return next;
    });
  }, []);

  /**
   * Append host-side Live cards (local slash commands like `/usage`).
   * Prefer `sessionId`; falls back to selected session when omitted.
   * Disk history is preserved (local cards use a different handleId).
   */
  const appendLocalLive = useCallback(
    (items: LocalSlashItem[], sessionId?: string | null) => {
      const key = sessionId || selectedSessionId;
      if (!key || !items.length) return;
      const now = Date.now();
      setLiveBySession((prev) => {
        const list = [...(prev.get(key) ?? [])];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          list.push({
            id: `local-${now}-${seq.current++}`,
            handleId: LOCAL_HANDLE_ID,
            sessionId: key,
            kind: item.kind,
            title: item.title,
            detail: item.detail,
            ts: now + i,
          });
        }
        const next = new Map(prev);
        next.set(key, list);
        return next;
      });
    },
    [selectedSessionId],
  );

  /**
   * Fold on-disk updates.jsonl into Live via the shared reducers.
   * Replaces only disk-sourced cards; keeps ACP + local slash cards.
   */
  const hydrateDiskLive = useCallback(
    (sessionId: string, updates: unknown[]) => {
      if (!sessionId) return;
      const diskItems = hydrateLiveFromDiskUpdates(updates, sessionId);
      setLiveBySession((prev) =>
        mergeDiskLiveIntoMap(prev, sessionId, diskItems),
      );
    },
    [],
  );

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let cancelled = false;
    // Batch live stream into one React commit per animation frame — critical for
    // smooth window drag on Windows when agents stream many tiny chunks.
    let liveBuf: Map<string, TimelineItem[]> | null = null;
    let liveRaf = 0;
    /** Per-handle settle timers so concurrent agents do not block each other. */
    const settleTimers = new Map<string, number>();
    /** toolCallId → list index for O(1) shell merge when list is long. */
    const shellIndexByKey = new Map<string, Map<string, number>>();

    const flushLive = () => {
      liveRaf = 0;
      if (!liveBuf || cancelled) return;
      const snapshot = liveBuf;
      liveBuf = null;
      if (snapshot === liveRef.current) return;
      liveRef.current = snapshot;
      setLiveBySession(snapshot);
    };
    const scheduleLive = (
      mutator: (prev: Map<string, TimelineItem[]>) => Map<string, TimelineItem[]>,
    ) => {
      const src = liveBuf ?? liveRef.current;
      const out = mutator(src);
      if (out === src) return;
      liveBuf = out;
      if (!liveRaf) {
        liveRaf = window.requestAnimationFrame(flushLive);
      }
    };

    const bumpSettleTimer = (handleId: string) => {
      const prev = settleTimers.get(handleId);
      if (prev) window.clearTimeout(prev);
      const t = window.setTimeout(() => {
        settleTimers.delete(handleId);
        if (cancelled) return;
        scheduleLive((map) => settleStreamingItems(map, { handleId }));
      }, STREAM_SETTLE_MS);
      settleTimers.set(handleId, t);
    };

    async function setup() {
      const u1 = await listen<ManagedAgentInfo>("agent-status", (e) => {
        if (cancelled) return;
        const info = e.payload;
        setManaged((prev) => {
          const existing = prev.get(info.handleId);
          if (existing && sameManagedAgent(existing, info)) {
            return prev;
          }
          const next = new Map(prev);
          next.set(info.handleId, info);
          return next;
        });
      });
      // Grok current_mode_update (plan ↔ default) — host Mode chip.
      // ACP schema uses `modeId`; some agents also send `currentModeId`.
      const uMode = await listen<AgentUpdateEvent>("agent-update", (e) => {
        if (cancelled) return;
        const update = e.payload?.params?.update as
          | {
              sessionUpdate?: string;
              currentModeId?: string;
              modeId?: string;
            }
          | undefined;
        if (update?.sessionUpdate !== "current_mode_update") return;
        const modeId = update.modeId ?? update.currentModeId;
        const sessionId = e.payload?.sessionId;
        if (!sessionId || modeId == null) return;
        onCurrentModeUpdateRef.current?.(sessionId, modeId);
      });

      const u2 = await listen<AgentUpdateEvent>("agent-update", (e) => {
        if (cancelled) return;
        const { handleId, sessionId, params } = e.payload;
        const update = params?.update ?? params;
        const desc = describeUpdate({
          method: "session/update",
          params: { update },
        });

        // Slash commands are durable session state — apply even when hidden so
        // we do not permanently miss available_commands_update during attach.
        if (desc.kind === "commands") {
          const cmds = desc.availableCommands ?? [];
          const keys = [sessionId, handleId].filter(Boolean) as string[];
          if (keys.length) {
            setCommandsByKey((prev) => {
              const next = new Map(prev);
              for (const k of keys) next.set(k, cmds);
              return next;
            });
          }
          return;
        }

        if (shouldDropUpdate(desc)) {
          return;
        }
        // Shell cards come from agent-shell only (aligned with Rust maybe_emit_shell).
        if (desc.isShell) {
          return;
        }

        const now = extractUpdateTsMs(e.payload.params) ?? Date.now();
        const isTextChunk = isTextUpdate(desc);
        scheduleLive((prev) =>
          reduceAgentUpdate(
            prev,
            {
              handleId,
              sessionId,
              description: desc,
              now,
              nextId: () => `${now}-${seq.current++}`,
              sourceEventId: e.payload.eventId,
            },
            shellIndexByKey,
          ),
        );

        if (isTextChunk) bumpSettleTimer(handleId);
      });
      const u3 = await listen<{ handleId: string; error?: string }>(
        "agent-prompt-complete",
        (e) => {
          if (cancelled) return;
          if (e.payload.error) setLastError(e.payload.error);
          const hid = e.payload.handleId;
          const t = settleTimers.get(hid);
          if (t) {
            window.clearTimeout(t);
            settleTimers.delete(hid);
          }
          // Turn finished → Markdown-render any still-streaming text cards.
          scheduleLive((prev) => settleStreamingItems(prev, { handleId: hid }));
        },
      );
      const u4 = await listen<PendingPermission>("agent-permission", (e) => {
        if (cancelled) return;
        const p = e.payload;
        setPermissions((prev) => {
          const next = new Map(prev);
          next.set(p.requestKey, p);
          return next;
        });
      });
      const u5 = await listen<{
        pending: PendingPermission;
        optionId: string;
        allowed: boolean;
      }>("agent-permission-resolved", (e) => {
        if (cancelled) return;
        const key = e.payload.pending?.requestKey;
        if (!key) return;
        setPermissions((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      });
      // Shell stdout/stderr → same Live stream (kind "shell"), filtered in UI
      const u6 = await listen<ShellEntry>("agent-shell", (e) => {
        if (cancelled) return;
        scheduleLive((prev) =>
          reduceShellUpdate(prev, e.payload, shellIndexByKey),
        );
      });
      if (!cancelled) {
        unsubs.push(u1, uMode, u2, u3, u4, u5, u6);
      } else {
        [u1, uMode, u2, u3, u4, u5, u6].forEach((u) => u());
      }
    }

    void setup();
    return () => {
      cancelled = true;
      if (liveRaf) window.cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      liveBuf = null;
      for (const t of settleTimers.values()) window.clearTimeout(t);
      settleTimers.clear();
      shellIndexByKey.clear();
      unsubs.forEach((u) => u());
    };
  }, []);

  const managedList = useMemo(
    () => Array.from(managed.values()),
    [managed],
  );
  const managedForSession = useMemo(() => {
    if (!selectedSessionId) return null;
    return (
      managedList.find((m) => m.sessionId === selectedSessionId) ?? null
    );
  }, [managedList, selectedSessionId]);

  const timelineItems = useMemo(() => {
    if (!selectedSessionId) return [] as TimelineItem[];
    const bySession = liveBySession.get(selectedSessionId) ?? [];
    const handle = managedForSession?.handleId;
    const byHandle = handle ? (liveBySession.get(handle) ?? []) : [];
    let merged: TimelineItem[];
    if (!byHandle.length) {
      merged = bySession;
    } else {
      const map = new Map<string, TimelineItem>();
      [...byHandle, ...bySession].forEach((i) => map.set(i.id, i));
      merged = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
    }
    return merged;
  }, [selectedSessionId, liveBySession, managedForSession]);

  /** Agent-advertised slash commands for the selected session (may be empty). */
  const availableCommands = useMemo(() => {
    if (!selectedSessionId) return [] as AvailableCommand[];
    const bySession = commandsByKey.get(selectedSessionId);
    if (bySession?.length) return bySession;
    const handle = managedForSession?.handleId;
    if (handle) {
      const byHandle = commandsByKey.get(handle);
      if (byHandle?.length) return byHandle;
    }
    return [] as AvailableCommand[];
  }, [selectedSessionId, commandsByKey, managedForSession]);

  const allPermissions = useMemo(
    () =>
      Array.from(permissions.values()).sort(
        (a, b) => a.createdAtMs - b.createdAtMs,
      ),
    [permissions],
  );

  const permissionsForSession = useMemo(() => {
    if (managedForSession) {
      return allPermissions.filter(
        (p) => p.handleId === managedForSession.handleId,
      );
    }
    return allPermissions.filter(
      (p) => !selectedSessionId || p.sessionId === selectedSessionId,
    );
  }, [allPermissions, managedForSession, selectedSessionId]);

  return {
    managed,
    managedList,
    managedForSession,
    timelineItems,
    availableCommands,
    permissions: allPermissions,
    permissionsForSession,
    lastError,
    clearError,
    upsertManaged,
    removeManaged,
    removePermission,
    hydratePermissions,
    appendLocalLive,
    hydrateDiskLive,
  };
}
