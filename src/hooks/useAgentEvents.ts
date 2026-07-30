import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { listSubagents, listTasks } from "../api";
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
  describeLifecycleNotification,
  describePendingInteractionNotification,
  isLifecycleNotificationMethod,
  lifecycleFromListSubagents,
  lifecycleFromListTasks,
  type LifecycleDescription,
  type PendingInteractionKind,
} from "../utils/subagentTasks";
import {
  LOCAL_HANDLE_ID,
  createTimelineReducerState,
  hydrateLiveFromDiskUpdates,
  mergeDiskLiveIntoMap,
  mergeTimelineItems,
  reduceAgentUpdate,
  reduceShellUpdate,
  sameManagedAgent,
  settleStreamingItems,
  shouldDropUpdate,
} from "./liveTimeline";

/** Open reverse-request tracked via session_notification (roster NeedsInput). */
export interface TrackedPendingInteraction {
  toolCallId: string;
  kind: PendingInteractionKind;
  sessionId: string;
  handleId?: string | null;
}

function isLiveManagedStatus(status: ManagedAgentInfo["status"]): boolean {
  return (
    status === "ready" ||
    status === "running" ||
    status === "awaitingPermission"
  );
}

function isResetManagedStatus(status: ManagedAgentInfo["status"]): boolean {
  return (
    status === "stopped" ||
    status === "error" ||
    status === "starting" ||
    status === "stopping"
  );
}

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
  /** toolCallId → pending interaction (fire-and-forget session_notification). */
  const [pendingInteractions, setPendingInteractions] = useState<
    Map<string, TrackedPendingInteraction>
  >(() => new Map());
  const [lastError, setLastError] = useState<string | null>(null);
  const seq = useRef(0);
  /** Latest live map for rAF batching (avoids setState-to-read anti-pattern). */
  const liveRef = useRef(liveBySession);
  liveRef.current = liveBySession;
  /** Handles already filled via list_running / task/list (attach + reconnect). */
  const lifecycleRefilledHandles = useRef(new Set<string>());

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
    lifecycleRefilledHandles.current.delete(handleId);
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
    setPendingInteractions((prev) => {
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

  /**
   * Apply lifecycle cards into live timeline.
   * Uses a fresh reducer state so list hydrate never touches stream session state.
   */
  const applyLifecycleDescriptions = useCallback(
    (
      handleId: string,
      sessionId: string | null | undefined,
      descriptions: LifecycleDescription[],
    ) => {
      if (!descriptions.length) return;
      const now = Date.now();
      const listReducerState = createTimelineReducerState();
      setLiveBySession((prev) => {
        let map = prev;
        for (const description of descriptions) {
          map = reduceAgentUpdate(
            map,
            {
              handleId,
              sessionId,
              description,
              now,
              nextId: () => `${now}-${seq.current++}`,
            },
            listReducerState,
          );
        }
        if (map !== prev) liveRef.current = map;
        return map;
      });
    },
    [],
  );

  /**
   * Own lifecycle refill: list_running + task/list after attach/reconnect.
   * Single owner — App must not duplicate this.
   */
  const refillLifecycleCards = useCallback(
    async (info: ManagedAgentInfo) => {
      if (!isLiveManagedStatus(info.status)) return;
      if (lifecycleRefilledHandles.current.has(info.handleId)) return;
      lifecycleRefilledHandles.current.add(info.handleId);
      try {
        const [subs, tasks] = await Promise.all([
          listSubagents(info.handleId).catch(() => null),
          listTasks(info.handleId).catch(() => null),
        ]);
        const descs = [
          ...lifecycleFromListSubagents(subs ?? undefined),
          ...lifecycleFromListTasks(tasks ?? undefined),
        ];
        if (descs.length) {
          applyLifecycleDescriptions(info.handleId, info.sessionId, descs);
        }
      } catch {
        // Non-fatal: live notifications remain the primary path.
      }
    },
    [applyLifecycleDescriptions],
  );

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let cancelled = false;
    // Batch live stream into one React commit per animation frame — critical for
    // smooth window drag on Windows when agents stream many tiny chunks.
    let liveBuf: Map<string, TimelineItem[]> | null = null;
    let liveRaf = 0;
    const timelineReducerState = createTimelineReducerState();

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
            timelineReducerState,
          ),
        );
      });
      const u3 = await listen<{ handleId: string; error?: string }>(
        "agent-prompt-complete",
        (e) => {
          if (cancelled) return;
          if (e.payload.error) setLastError(e.payload.error);
          const hid = e.payload.handleId;
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
          reduceShellUpdate(prev, e.payload, timelineReducerState),
        );
      });
      // Subagent + background-task lifecycle (x.ai/session_notification,
      // x.ai/task_backgrounded, x.ai/task_completed). TaskTool/Wait/Kill
      // scrollback is suppressed; these notifications own the cards.
      // Also pending_interaction / interaction_resolved for NeedsInput roster.
      const u7 = await listen<AgentUpdateEvent>("agent-notification", (e) => {
        if (cancelled) return;
        const { handleId, sessionId, method, params } = e.payload;

        const pendingEv = describePendingInteractionNotification(method, params);
        if (pendingEv) {
          setPendingInteractions((prev) => {
            const next = new Map(prev);
            if (pendingEv.resolved) {
              if (!next.has(pendingEv.toolCallId)) return prev;
              next.delete(pendingEv.toolCallId);
              return next;
            }
            const sid = sessionId ?? "";
            if (!sid) return prev;
            next.set(pendingEv.toolCallId, {
              toolCallId: pendingEv.toolCallId,
              kind: pendingEv.kind,
              sessionId: sid,
              handleId,
            });
            return next;
          });
          return;
        }

        if (!isLifecycleNotificationMethod(method)) return;
        const desc = describeLifecycleNotification(method, params);
        if (!desc) return;
        const now = Date.now();
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
            timelineReducerState,
          ),
        );
      });
      if (!cancelled) {
        unsubs.push(u1, uMode, u2, u3, u4, u5, u6, u7);
      } else {
        [u1, uMode, u2, u3, u4, u5, u6, u7].forEach((u) => u());
      }
    }

    void setup();
    return () => {
      cancelled = true;
      if (liveRaf) window.cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      liveBuf = null;
      timelineReducerState.shellIndexes.clear();
      timelineReducerState.suppressedToolIds.clear();
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
    return byHandle.length
      ? mergeTimelineItems(byHandle, bySession)
      : bySession;
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

  /**
   * Single NeedsInput projection: permission reverse-requests + pending_interaction.
   * Session list / chrome must use this only (via resolveCardState needsInput).
   */
  const needsInputSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of allPermissions) {
      if (p.sessionId) ids.add(p.sessionId);
    }
    for (const p of pendingInteractions.values()) {
      if (p.sessionId) ids.add(p.sessionId);
    }
    return ids;
  }, [allPermissions, pendingInteractions]);

  // Attach / reconnect: refill lifecycle cards once per live handle.
  useEffect(() => {
    for (const m of managedList) {
      if (isResetManagedStatus(m.status)) {
        lifecycleRefilledHandles.current.delete(m.handleId);
        continue;
      }
      if (isLiveManagedStatus(m.status)) {
        void refillLifecycleCards(m);
      }
    }
  }, [managedList, refillLifecycleCards]);

  return {
    managed,
    managedList,
    managedForSession,
    timelineItems,
    availableCommands,
    permissions: allPermissions,
    permissionsForSession,
    needsInputSessionIds,
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
