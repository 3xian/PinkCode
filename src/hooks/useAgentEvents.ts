import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentUpdateEvent,
  AvailableCommand,
  LiveStreamItem,
  ManagedAgentInfo,
  PendingPermission,
  ShellEntry,
} from "../types";
import { COALESCE_LIVE_KINDS, describeUpdate } from "../utils/format";

const MAX_LIVE = 400;

export function useAgentEvents(selectedSessionId: string | null) {
  const [managed, setManaged] = useState<Map<string, ManagedAgentInfo>>(
    () => new Map(),
  );
  const [liveBySession, setLiveBySession] = useState<
    Map<string, LiveStreamItem[]>
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
      if (
        existing &&
        existing.status === info.status &&
        existing.sessionId === info.sessionId &&
        existing.pid === info.pid &&
        existing.pendingPermissionCount === info.pendingPermissionCount &&
        existing.alwaysApprove === info.alwaysApprove &&
        existing.permissionMode === info.permissionMode &&
        existing.title === info.title
      ) {
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

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let cancelled = false;
    // Batch live stream into one React commit per animation frame — critical for
    // smooth window drag on Windows when agents stream many tiny chunks.
    let liveBuf: Map<string, LiveStreamItem[]> | null = null;
    let liveRaf = 0;
    const flushLive = () => {
      liveRaf = 0;
      if (!liveBuf || cancelled) return;
      const snapshot = liveBuf;
      liveBuf = null;
      liveRef.current = snapshot;
      setLiveBySession(snapshot);
    };
    const scheduleLive = (
      mutator: (prev: Map<string, LiveStreamItem[]>) => Map<string, LiveStreamItem[]>,
    ) => {
      const src = liveBuf ?? liveRef.current;
      liveBuf = mutator(src);
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
          if (
            existing &&
            existing.status === info.status &&
            existing.sessionId === info.sessionId &&
            existing.pid === info.pid &&
            existing.pendingPermissionCount === info.pendingPermissionCount &&
            existing.alwaysApprove === info.alwaysApprove &&
            existing.permissionMode === info.permissionMode &&
            existing.title === info.title &&
            existing.lastError === info.lastError
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(info.handleId, info);
          return next;
        });
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

        // Don't fight the compositor while the window is not visible (stream only).
        if (document.visibilityState === "hidden") return;

        // Drop pure noise (empty / unlabeled events)
        if (
          desc.kind === "event" &&
          (!desc.title || desc.title === "event")
        ) {
          return;
        }
        // Skip empty text chunks
        if (desc.coalesce && !(desc.detail && desc.detail.length > 0)) {
          return;
        }

        const key = sessionId || handleId;
        const now = Date.now();

        scheduleLive((prev) => {
          const next = new Map(prev);
          const list = [...(next.get(key) ?? [])];

          // 1) Coalesce streaming text: agent/user/thought word-chunks → one card
          if (desc.coalesce || COALESCE_LIVE_KINDS.has(desc.kind)) {
            const last = list[list.length - 1];
            if (last && last.kind === desc.kind && last.handleId === handleId) {
              list[list.length - 1] = {
                ...last,
                detail: (last.detail ?? "") + (desc.detail ?? ""),
                ts: now,
              };
              next.set(key, list);
              return next;
            }
          }

          // 2) Merge tool_call + tool_call_update by toolCallId into one card
          if (desc.kind === "tool" && desc.toolCallId) {
            const idx = list.findIndex(
              (x) =>
                x.kind === "tool" &&
                (x.detail === desc.toolCallId ||
                  x.title.includes(desc.toolCallId!)),
            );
            if (idx >= 0) {
              list[idx] = {
                ...list[idx],
                title: desc.title || list[idx].title,
                detail: desc.toolCallId,
                ts: now,
              };
              next.set(key, list);
              return next;
            }
          }

          // 3) Keep one live plan card (latest snapshot replaces previous)
          if (desc.kind === "plan") {
            const idx = list.findIndex(
              (x) => x.kind === "plan" && x.handleId === handleId,
            );
            if (idx >= 0) {
              list[idx] = {
                ...list[idx],
                title: desc.title,
                detail: desc.detail,
                ts: now,
              };
              next.set(key, list);
              return next;
            }
          }

          list.push({
            id: `${now}-${seq.current++}`,
            handleId,
            sessionId: sessionId ?? null,
            kind: desc.kind,
            title: desc.title,
            detail: desc.detail,
            ts: now,
          });
          if (list.length > MAX_LIVE) list.splice(0, list.length - MAX_LIVE);
          next.set(key, list);
          return next;
        });
      });
      const u3 = await listen<{ handleId: string; error?: string }>(
        "agent-prompt-complete",
        (e) => {
          if (cancelled) return;
          if (e.payload.error) setLastError(e.payload.error);
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
        if (document.visibilityState === "hidden") return;
        const raw = e.payload;
        const handleId = raw.handleId;
        const sessionId = raw.sessionId ?? null;
        const toolCallId = raw.toolCallId;
        const command = raw.command || "";
        const description = raw.description;
        const status = raw.status || "in_progress";
        const output = raw.output || "";
        const exitCode = raw.exitCode;
        const now = raw.ts || Date.now();
        const key = sessionId || handleId;
        const title =
          status === "completed" || status === "failed"
            ? `$ ${command || "shell"}${exitCode != null ? ` · exit ${exitCode}` : ""}`
            : `$ ${command || "shell"} · ${status}`;

        scheduleLive((prev) => {
          const next = new Map(prev);
          const list = [...(next.get(key) ?? [])];
          const idx = list.findIndex(
            (x) => x.kind === "shell" && x.shell?.toolCallId === toolCallId,
          );
          if (idx >= 0) {
            const old = list[idx];
            const prevOut = old.shell?.output ?? "";
            const mergedOut =
              output.length >= prevOut.length ? output : prevOut;
            list[idx] = {
              ...old,
              title,
              detail: description || command || old.detail,
              ts: now,
              shell: {
                toolCallId,
                command: command || old.shell?.command || "",
                description: description ?? old.shell?.description,
                status,
                output: mergedOut,
                exitCode: exitCode ?? old.shell?.exitCode,
              },
            };
          } else {
            list.push({
              id: `shell-${toolCallId}-${now}`,
              handleId,
              sessionId,
              kind: "shell",
              title,
              detail: description || command || undefined,
              ts: now,
              shell: {
                toolCallId,
                command,
                description,
                status,
                output,
                exitCode,
              },
            });
          }
          if (list.length > MAX_LIVE) list.splice(0, list.length - MAX_LIVE);
          next.set(key, list);
          return next;
        });
      });

      if (!cancelled) {
        unsubs.push(u1, u2, u3, u4, u5, u6);
      } else {
        [u1, u2, u3, u4, u5, u6].forEach((u) => u());
      }
    }

    void setup();
    return () => {
      cancelled = true;
      if (liveRaf) window.cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      liveBuf = null;
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

  const liveItems = useMemo(() => {
    if (!selectedSessionId) return [] as LiveStreamItem[];
    const bySession = liveBySession.get(selectedSessionId) ?? [];
    const handle = managedForSession?.handleId;
    const byHandle = handle ? (liveBySession.get(handle) ?? []) : [];
    if (!byHandle.length) return bySession;
    const map = new Map<string, LiveStreamItem>();
    [...byHandle, ...bySession].forEach((i) => map.set(i.id, i));
    return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
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
    liveItems,
    availableCommands,
    permissions: allPermissions,
    permissionsForSession,
    lastError,
    clearError,
    upsertManaged,
    removeManaged,
    removePermission,
    hydratePermissions,
  };
}
