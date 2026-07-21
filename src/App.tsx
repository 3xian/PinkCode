import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  attachAgent,
  getLastSpawnPermissionMode,
  getSessionDetail,
  listManagedAgents,
  listPendingPermissions,
  listSessions,
  listTaskPermissionModes,
  promptAgent,
  resolvePermission,
  setPermissionMode,
  setTaskPermissionMode,
  spawnAgent,
  stopAgent,
} from "./api";
import { FileTree } from "./components/FileTree";
import { GitChanges } from "./components/GitChanges";
import { NewTaskModal } from "./components/NewTaskModal";
import { SessionDetailView } from "./components/SessionDetail";
import { SessionList } from "./components/SessionList";
import { StatsBar } from "./components/StatsBar";
import { UpdateModal } from "./components/UpdateModal";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useUsageMetrics } from "./hooks/useUsageMetrics";
import type {
  MainTab,
  ManagedAgentInfo,
  PendingPermission,
  PermissionMode,
  SessionCard,
  SessionDetail,
} from "./types";
import {
  isLocalSlashCommand,
  runLocalSlash,
} from "./utils/localSlash";
import "./App.css";

/**
 * Sole debounce for disk-driven UI refresh (session list, detail, workspace
 * FileTree / GitChanges via gitRefreshKey). Children do not re-debounce.
 */
const FS_REFRESH_MIN_MS = 400;
/** Slow safety net if FSEvents miss a write (rare). */
const SAFETY_POLL_MS = 90_000;

/** Single selection policy for staged list → managed load. */
function pickSelectedId(
  list: SessionCard[],
  prev: string | null,
  managed?: ManagedAgentInfo[],
): string | null {
  if (prev && list.some((s) => s.id === prev)) return prev;
  if (managed?.length) {
    const managedSid = managed.find((m) => m.sessionId)?.sessionId;
    if (managedSid && list.some((s) => s.id === managedSid)) {
      return managedSid;
    }
  }
  const live = list.find((s) => s.isActive);
  return live?.id ?? list[0]?.id ?? null;
}
function App() {
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<MainTab>("timeline");
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /** Pending Stop confirmation: which managed agent to kill. */
  const [stopConfirm, setStopConfirm] = useState<{
    handleId: string;
    sessionId: string;
    title: string;
  } | null>(null);
  /** Bumped after attach/spawn so Timeline pins to bottom. */
  const [pinTimelineBottomSeq, setPinTimelineBottomSeq] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  /** Session whose attach switch was flipped on; switch breathes until settle. */
  const [attachingSessionId, setAttachingSessionId] = useState<string | null>(
    null,
  );
  const [permBusyKey, setPermBusyKey] = useState<string | null>(null);
  /** Per-task permission modes loaded from disk (`~/.marsbuild/task_prefs.json`). */
  const [taskPermissionModes, setTaskPermissionModes] = useState<
    Record<string, PermissionMode>
  >({});
  /** Seed for New Task modal; last mode used when spawning. */
  const [lastSpawnMode, setLastSpawnMode] =
    useState<PermissionMode>("default");
  /** Bump git changes panel after disk events. */
  const [gitRefreshKey, setGitRefreshKey] = useState(0);

  const {
    managedList,
    managedForSession,
    timelineItems,
    availableCommands,
    permissionsForSession,
    lastError,
    clearError,
    upsertManaged,
    removeManaged,
    removePermission,
    hydratePermissions,
    appendLocalLive,
    hydrateDiskLive,
  } = useAgentEvents(selectedId);

  const projectCwd = detail?.card.cwd ?? null;
  const { pendingUpdate, dismissUpdate } = useAppUpdate();

  const refreshList = useCallback(async () => {
    // Skip heavy list work while the window is hidden (drag/minimize storms).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    try {
      // List first so the shell paints; managed agents are cheap but optional.
      const list = await listSessions(80);
      setSessions(list);
      setError(null);
      setSelectedId((prev) => pickSelectedId(list, prev));
      try {
        const managed = await listManagedAgents();
        for (const m of managed) {
          upsertManaged(m);
        }
        setSelectedId((prev) => pickSelectedId(list, prev, managed));
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [upsertManaged]);

  // Hydrate per-task permission modes + last spawn seed once on mount.
  useEffect(() => {
    void (async () => {
      try {
        const [modes, last] = await Promise.all([
          listTaskPermissionModes(),
          getLastSpawnPermissionMode(),
        ]);
        setTaskPermissionModes(modes);
        setLastSpawnMode(last);
      } catch {
        /* non-tauri / first run */
      }
    })();
  }, []);

  /** Mode shown/edited for the selected task. Attached agent wins when present. */
  const effectivePermissionMode: PermissionMode = useMemo(() => {
    if (
      managedForSession &&
      managedForSession.status !== "stopped" &&
      managedForSession.status !== "error"
    ) {
      return managedForSession.permissionMode;
    }
    if (selectedId && taskPermissionModes[selectedId]) {
      return taskPermissionModes[selectedId];
    }
    return "default";
  }, [managedForSession, selectedId, taskPermissionModes]);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailReqSeq = useRef(0);
  const lastFsRefreshRef = useRef(0);
  /** Session id we intentionally focused (spawn); ignore auto-steal otherwise. */
  const focusOnceSessionRef = useRef<string | null>(null);

  const refreshDetail = useCallback(
    async (id: string, silent = false) => {
      const seq = ++detailReqSeq.current;
      if (!silent) setDetailLoading(true);
      try {
        const d = await getSessionDetail(id);
        // Ignore stale responses if the user switched sessions mid-flight.
        if (seq !== detailReqSeq.current || selectedIdRef.current !== id) {
          return;
        }
        setDetail(d);
        setDetailError(null);
        // Mirror Grok Build disk stream into Timeline (keeps local slash cards).
        hydrateDiskLive(id, d.recentUpdates ?? []);
      } catch (e) {
        if (seq !== detailReqSeq.current || selectedIdRef.current !== id) {
          return;
        }
        setDetailError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!silent && seq === detailReqSeq.current) {
          setDetailLoading(false);
        }
      }
    },
    [hydrateDiskLive],
  );

  const refreshFromDisk = useCallback(() => {
    const now = Date.now();
    if (now - lastFsRefreshRef.current < FS_REFRESH_MIN_MS) return;
    lastFsRefreshRef.current = now;
    void refreshList();
    const id = selectedIdRef.current;
    if (id) void refreshDetail(id, true);
    setGitRefreshKey((n) => n + 1);
  }, [refreshList, refreshDetail]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const liveManagedCount = useMemo(
    () =>
      managedList.filter(
        (m) => m.status !== "stopped" && m.status !== "error",
      ).length,
    [managedList],
  );

  const { tokenSeries, weekUsage, refreshWeekUsage } = useUsageMetrics(
    liveManagedCount,
    () => setGitRefreshKey((n) => n + 1),
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void refreshDetail(selectedId);
  }, [selectedId, refreshDetail]);

  // Primary: debounced FS watcher on ~/.grok/sessions + active_sessions.json
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ reason?: string; path?: string }>("sessions-changed", () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      refreshFromDisk();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshFromDisk]);

  // Focus / tab visible → catch anything the watcher missed (debounced).
  useEffect(() => {
    let t: number | null = null;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        refreshFromDisk();
      }, 300);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      if (t != null) window.clearTimeout(t);
    };
  }, [refreshFromDisk]);

  // Slow safety net only (not the main update path)
  useEffect(() => {
    const t = window.setInterval(() => refreshFromDisk(), SAFETY_POLL_MS);
    return () => window.clearInterval(t);
  }, [refreshFromDisk]);

  // Only auto-focus a session we just spawned (never steal focus from other tasks).
  useEffect(() => {
    const want = focusOnceSessionRef.current;
    if (!want) return;
    const ready = managedList.find(
      (m) =>
        m.sessionId === want &&
        m.status !== "stopped" &&
        m.status !== "error",
    );
    if (ready?.sessionId) {
      setSelectedId(ready.sessionId);
      focusOnceSessionRef.current = null;
    }
  }, [managedList]);

  async function handleSpawn(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
  }) {
    setControlBusy(true);
    setError(null);
    try {
      const info = await spawnAgent({
        cwd: opts.cwd,
        // Empty string → omit; backend treats missing/blank as “no initial prompt”.
        prompt: opts.prompt.trim() ? opts.prompt.trim() : null,
        permissionMode: opts.permissionMode,
      });
      upsertManaged(info);
      setLastSpawnMode(opts.permissionMode);
      if (info.sessionId) {
        setTaskPermissionModes((prev) => ({
          ...prev,
          [info.sessionId!]: opts.permissionMode,
        }));
        focusOnceSessionRef.current = info.sessionId;
        setSelectedId(info.sessionId);
        setTab("timeline");
        setPinTimelineBottomSeq((n) => n + 1);
      } else if (info.status === "error") {
        // Failed after process start — still surface in managed list until Stop.
        setError(info.lastError ?? "Agent failed to start");
      }
      setModalOpen(false);
      // Disk index may lag a moment
      window.setTimeout(() => void refreshList(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }

  async function handleAttach(sessionId: string) {
    const card = sessions.find((s) => s.id === sessionId);
    if (!card) return;
    // Already managed — switch should already be on.
    const already = managedList.some(
      (m) => m.sessionId === sessionId && m.status !== "stopped",
    );
    if (already) return;

    // Paint switch pending state *before* the long attach IPC so the glow starts.
    flushSync(() => {
      setSelectedId(sessionId);
      setAttachingSessionId(sessionId);
      setControlBusy(true);
      setError(null);
    });
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );

    try {
      // Backend restores this task's saved mode when permissionMode is omitted.
      // If the UI already has a preference for this task, pass it explicitly.
      const saved = taskPermissionModes[sessionId];
      const info = await attachAgent({
        sessionId: card.id,
        cwd: card.cwd,
        permissionMode: saved ?? null,
      });
      upsertManaged(info);
      if (info.sessionId) {
        setTaskPermissionModes((prev) => ({
          ...prev,
          [info.sessionId!]: info.permissionMode,
        }));
      }
      setTab("timeline");
      setPinTimelineBottomSeq((n) => n + 1);
      // Hydrate any already-queued permissions (usually empty right after attach)
      const queued = await listPendingPermissions(info.handleId);
      hydratePermissions(queued);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
      setAttachingSessionId(null);
    }
  }

  async function handleResolvePermission(
    item: PendingPermission,
    optionId: string,
  ) {
    setPermBusyKey(item.requestKey);
    setError(null);
    try {
      await resolvePermission(item.handleId, item.requestKey, optionId);
      removePermission(item.requestKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPermBusyKey(null);
    }
  }

  async function handlePermissionModeChange(mode: PermissionMode) {
    const sessionId = selectedId;
    const previousMode = effectivePermissionMode;
    // Optimistic local map so the select updates immediately.
    if (sessionId) {
      setTaskPermissionModes((prev) => ({ ...prev, [sessionId]: mode }));
    }

    setControlBusy(true);
    setError(null);
    try {
      if (managedForSession && managedForSession.status !== "stopped") {
        // Attached agent path also persists to disk in Rust.
        const info = await setPermissionMode(
          managedForSession.handleId,
          mode,
        );
        upsertManaged(info);
        if (info.sessionId) {
          setTaskPermissionModes((prev) => ({
            ...prev,
            [info.sessionId!]: mode,
          }));
        }
      } else if (sessionId) {
        await setTaskPermissionMode(sessionId, mode);
      }
    } catch (e) {
      // Keep the UI aligned with the backend when the optimistic write fails.
      if (sessionId) {
        setTaskPermissionModes((prev) => ({
          ...prev,
          [sessionId]: previousMode,
        }));
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }

  async function handleSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setControlBusy(true);
    setError(null);
    setTab("timeline");
    try {
      // Pager builtins (/usage, /context, …) are TUI-local in Grok Build —
      // ACP session/prompt does not render them. Handle here and show in Timeline.
      if (isLocalSlashCommand(trimmed)) {
        const result = await runLocalSlash(trimmed, {
          detail,
          weekUsage,
        });
        if (result) {
          const targetId = selectedId ?? sessions[0]?.id ?? null;
          if (!targetId) {
            // No task to hang Timeline cards on — surface text as a banner.
            const body = result.items
              .map((i) =>
                [i.title, i.detail].filter(Boolean).join("\n"),
              )
              .join("\n\n");
            setError(body || "Command completed.");
          } else {
            if (!selectedId) setSelectedId(targetId);
            appendLocalLive(result.items, targetId);
            setPinTimelineBottomSeq((n) => n + 1);
          }
          if (result.refreshWeekUsage) {
            void refreshWeekUsage({ force: true });
          }
          return;
        }
      }

      if (!managedForSession) {
        setError(
          "Attach a task (flip the switch) to send agent prompts. Local /usage /context /session-info /help work without attach.",
        );
        return;
      }
      await promptAgent(managedForSession.handleId, trimmed);
      setPinTimelineBottomSeq((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }

  function requestStop(sessionId: string) {
    const managed = managedList.find(
      (m) =>
        m.sessionId === sessionId &&
        m.status !== "stopped",
    );
    if (!managed) return;
    const title =
      sessions.find((s) => s.id === sessionId)?.title ??
      managed.title ??
      "this agent";
    setStopConfirm({
      handleId: managed.handleId,
      sessionId,
      title,
    });
  }

  const confirmStop = useCallback(async () => {
    if (!stopConfirm || controlBusy) return;
    setControlBusy(true);
    setError(null);
    try {
      await stopAgent(stopConfirm.handleId);
      removeManaged(stopConfirm.handleId);
      setStopConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }, [stopConfirm, controlBusy, removeManaged]);

  // Stop dialog: Enter confirms, Escape cancels.
  useEffect(() => {
    if (!stopConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void confirmStop();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (!controlBusy) setStopConfirm(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopConfirm, confirmStop, controlBusy]);

  const defaultCwd = detail?.card.cwd ?? sessions[0]?.cwd ?? "";

  /**
   * Sessions confirmed attached (ready/running/awaitingPermission).
   * Exclude `starting` so the task list only reorders after attach succeeds —
   * mid-attach agent-status events must not jump the card to the top yet.
   */
  const managedSessionIds = useMemo(
    () =>
      new Set(
        managedList
          .filter(
            (m) =>
              m.sessionId &&
              m.status !== "stopped" &&
              m.status !== "error" &&
              m.status !== "starting",
          )
          .map((m) => m.sessionId as string),
      ),
    [managedList],
  );

  /** Switch on = any non-stopped managed handle (includes error, so user can detach). */
  const attachedSessionIds = useMemo(
    () =>
      new Set(
        managedList
          .filter((m) => m.sessionId && m.status !== "stopped")
          .map((m) => m.sessionId as string),
      ),
    [managedList],
  );

  return (
    <div className="app-shell">
      {(error || lastError) && (
        <div className="banner error-banner">
          <span>{error || lastError}</span>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              setError(null);
              clearError();
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="main-grid">
        <aside className="left-rail">
          <StatsBar
            tokenSeries={tokenSeries}
            weekUsage={weekUsage}
            onRefreshWeekUsage={() => void refreshWeekUsage({ force: true })}
          />
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            query={query}
            onQuery={setQuery}
            onSelect={(id) => {
              setSelectedId(id);
            }}
            managedSessionIds={managedSessionIds}
            attachedSessionIds={attachedSessionIds}
            onAttach={(id) => void handleAttach(id)}
            onRequestStop={requestStop}
            toggleBusy={controlBusy}
            attachingSessionId={attachingSessionId}
            onNewTask={() => setModalOpen(true)}
          />
        </aside>

        <SessionDetailView
          detail={detail}
          loading={detailLoading}
          error={detailError}
          tab={tab}
          onTab={setTab}
          timelineItems={timelineItems}
          managed={managedForSession}
          permissions={permissionsForSession}
          permBusyKey={permBusyKey}
          controlBusy={controlBusy}
          permissionMode={effectivePermissionMode}
          onPermissionModeChange={(m) => void handlePermissionModeChange(m)}
          onSendPrompt={(t) => void handleSend(t)}
          onResolvePermission={(item, opt) =>
            void handleResolvePermission(item, opt)
          }
          pinTimelineBottomSeq={pinTimelineBottomSeq}
          availableCommands={availableCommands}
        />

        <aside className="side-panel workspace-panel">
          <FileTree root={projectCwd} refreshKey={gitRefreshKey} />
          <div className="workspace-split" />
          <GitChanges cwd={projectCwd} refreshKey={gitRefreshKey} />
        </aside>
      </div>

      <NewTaskModal
        open={modalOpen}
        defaultCwd={defaultCwd}
        busy={controlBusy}
        defaultPermissionMode={lastSpawnMode}
        onClose={() => setModalOpen(false)}
        onSubmit={(o) => void handleSpawn(o)}
      />

      <UpdateModal update={pendingUpdate} onDismiss={dismissUpdate} />

      {stopConfirm && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!controlBusy) setStopConfirm(null);
          }}
        >
          <div
            className="modal stop-confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal
            aria-labelledby="stop-confirm-title"
          >
            <div className="modal-header">
              <h2 id="stop-confirm-title">Stop agent?</h2>
            </div>
            <p className="muted small">
              This will kill the agent process for{" "}
              <strong title={stopConfirm.title}>{stopConfirm.title}</strong>,
              cancel any pending permission requests, and detach it from
              MarsBuild. Session history on disk is kept.
            </p>
            <div className="modal-actions">
              <button
                className="btn"
                type="button"
                disabled={controlBusy}
                onClick={() => setStopConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn danger-btn"
                type="button"
                disabled={controlBusy}
                autoFocus
                onClick={() => void confirmStop()}
              >
                {controlBusy ? "Stopping…" : "Stop agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
