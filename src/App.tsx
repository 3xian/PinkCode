import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  attachAgent,
  bindProjectPolicy,
  getSessionDetail,
  getTokenUsageSeries,
  getWeekUsage,
  listManagedAgents,
  listPendingPermissions,
  listPolicyPresets,
  listProjectBindings,
  listSessions,
  promptAgent,
  resolvePermission,
  resolvePolicy,
  setDefaultPolicyPreset,
  spawnAgent,
  stopAgent,
  unbindProjectPolicy,
} from "./api";
import { DiffPanel } from "./components/DiffPanel";
import { NewTaskModal } from "./components/NewTaskModal";
import { PolicyCenter } from "./components/PolicyCenter";
import { SessionDetailView } from "./components/SessionDetail";
import { SessionList } from "./components/SessionList";
import { StatsBar } from "./components/StatsBar";
import { useAgentEvents } from "./hooks/useAgentEvents";
import type {
  MainTab,
  PendingPermission,
  PolicyConfig,
  PolicyPreset,
  ProjectBinding,
  ResolvedPolicy,
  SessionCard,
  SessionDetail,
  TokenUsageSeries,
  WeekUsage,
} from "./types";
import "./App.css";

/** Min gap between disk-driven refreshes (extra frontend coalesce). */
const FS_REFRESH_MIN_MS = 750;
/** Slow safety net if FSEvents miss a write (rare). */
const SAFETY_POLL_MS = 90_000;
/** Idle poll for week usage (billing API). Faster while agents are live. */
const WEEK_USAGE_IDLE_POLL_MS = 60_000;
const WEEK_USAGE_ACTIVE_POLL_MS = 20_000;
/** After a turn ends, wait a beat for billing to settle then refresh. */
const WEEK_USAGE_AFTER_TURN_MS = 2_500;
/** Min gap between billing fetches to avoid thrashing the API. */
const WEEK_USAGE_MIN_GAP_MS = 8_000;
/** Token chart is expensive (scans updates.jsonl); keep off the FS hot path. */
const TOKEN_SERIES_POLL_MS = 90_000;

function App() {
  const [sessions, setSessions] = useState<SessionCard[]>([]);
  const [tokenSeries, setTokenSeries] = useState<TokenUsageSeries | null>(null);
  const [weekUsage, setWeekUsage] = useState<WeekUsage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<MainTab>("live");
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /** Bumped after attach/spawn so Live timeline pins to bottom. */
  const [pinLiveBottomSeq, setPinLiveBottomSeq] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [permBusyKey, setPermBusyKey] = useState<string | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [presets, setPresets] = useState<PolicyConfig[]>([]);
  const [bindings, setBindings] = useState<ProjectBinding[]>([]);
  const [resolved, setResolved] = useState<ResolvedPolicy | null>(null);

  const {
    managedList,
    managedForSession,
    liveItems,
    shellEntries,
    permissionsForSession,
    setPolicyState,
    setResolvedPolicy,
    policyActions,
    lastError,
    clearError,
    upsertManaged,
    removeManaged,
    removePermission,
    hydratePermissions,
  } = useAgentEvents(selectedId);

  const projectCwd = detail?.card.cwd ?? null;

  const refreshPolicyForCwd = useCallback(async (cwd: string | null) => {
    try {
      const [r, list, binds] = await Promise.all([
        resolvePolicy(cwd),
        listPolicyPresets(),
        listProjectBindings(),
      ]);
      setResolved(r);
      setResolvedPolicy(r);
      setPolicyState(r.config);
      setPresets(list);
      setBindings(binds);
    } catch {
      /* non-tauri preview */
    }
  }, [setPolicyState, setResolvedPolicy]);

  // Single effect: projectCwd starts null (global default), then tracks selection.
  useEffect(() => {
    void refreshPolicyForCwd(projectCwd);
  }, [projectCwd, refreshPolicyForCwd]);

  const refreshList = useCallback(async () => {
    // Skip heavy list work while the window is hidden (drag/minimize storms).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    try {
      const [list, managed] = await Promise.all([
        listSessions(200),
        listManagedAgents().catch(() => [] as Awaited<
          ReturnType<typeof listManagedAgents>
        >),
      ]);
      setSessions(list);
      for (const m of managed) {
        upsertManaged(m);
      }
      setError(null);
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        const managedSid = managed.find((m) => m.sessionId)?.sessionId;
        if (managedSid && list.some((s) => s.id === managedSid)) return managedSid;
        const live = list.find((s) => s.isActive);
        return live?.id ?? list[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [upsertManaged]);

  const refreshTokenSeries = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    try {
      const series = await getTokenUsageSeries(7);
      setTokenSeries(series);
    } catch {
      /* non-tauri / offline */
    }
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const detailReqSeq = useRef(0);
  const lastFsRefreshRef = useRef(0);
  /** Session id we intentionally focused (spawn); ignore auto-steal otherwise. */
  const focusOnceSessionRef = useRef<string | null>(null);

  const refreshDetail = useCallback(async (id: string, silent = false) => {
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
  }, []);

  const refreshFromDisk = useCallback(() => {
    const now = Date.now();
    if (now - lastFsRefreshRef.current < FS_REFRESH_MIN_MS) return;
    lastFsRefreshRef.current = now;
    void refreshList();
    const id = selectedIdRef.current;
    if (id) void refreshDetail(id, true);
  }, [refreshList, refreshDetail]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Token chart: initial + slow poll (not tied to FS watcher).
  useEffect(() => {
    void refreshTokenSeries();
    const id = window.setInterval(() => void refreshTokenSeries(), TOKEN_SERIES_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshTokenSeries]);

  const weekUsageInflight = useRef(false);
  const weekUsageLastAt = useRef(0);
  const weekUsageTimer = useRef<number | null>(null);

  const refreshWeekUsage = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force ?? false;
    const now = Date.now();
    if (!force && now - weekUsageLastAt.current < WEEK_USAGE_MIN_GAP_MS) {
      return;
    }
    if (weekUsageInflight.current) return;
    weekUsageInflight.current = true;
    try {
      const u = await getWeekUsage();
      weekUsageLastAt.current = Date.now();
      setWeekUsage(u);
    } catch {
      /* non-tauri preview or offline */
    } finally {
      weekUsageInflight.current = false;
    }
  }, []);

  /** Schedule a debounced refresh (used after turns complete). */
  const scheduleWeekUsageRefresh = useCallback(
    (delayMs = WEEK_USAGE_AFTER_TURN_MS) => {
      if (weekUsageTimer.current != null) {
        window.clearTimeout(weekUsageTimer.current);
      }
      weekUsageTimer.current = window.setTimeout(() => {
        weekUsageTimer.current = null;
        void refreshWeekUsage({ force: true });
      }, delayMs);
    },
    [refreshWeekUsage],
  );

  const liveManagedCount = useMemo(
    () =>
      managedList.filter(
        (m) => m.status !== "stopped" && m.status !== "error",
      ).length,
    [managedList],
  );

  // Initial + adaptive poll: faster while agents are running
  useEffect(() => {
    void refreshWeekUsage({ force: true });
    const interval =
      liveManagedCount > 0 ? WEEK_USAGE_ACTIVE_POLL_MS : WEEK_USAGE_IDLE_POLL_MS;
    const id = window.setInterval(() => void refreshWeekUsage(), interval);
    return () => window.clearInterval(id);
  }, [refreshWeekUsage, liveManagedCount]);

  // Real-time trigger: refresh billing after each prompt turn completes
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("agent-prompt-complete", () => {
      if (!cancelled) {
        scheduleWeekUsageRefresh();
        // Turn finished → refresh chart once (cheap cache on Rust side).
        window.setTimeout(() => void refreshTokenSeries(), 1_500);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (weekUsageTimer.current != null) {
        window.clearTimeout(weekUsageTimer.current);
        weekUsageTimer.current = null;
      }
    };
  }, [scheduleWeekUsageRefresh, refreshTokenSeries]);

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
        void refreshTokenSeries();
      }, 300);
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      if (t != null) window.clearTimeout(t);
    };
  }, [refreshFromDisk, refreshTokenSeries]);

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
    alwaysApprove: boolean;
  }) {
    setControlBusy(true);
    setError(null);
    try {
      const info = await spawnAgent({
        cwd: opts.cwd,
        // Empty string → omit; backend treats missing/blank as “no initial prompt”.
        prompt: opts.prompt.trim() ? opts.prompt.trim() : null,
        alwaysApprove: opts.alwaysApprove,
      });
      upsertManaged(info);
      if (info.sessionId) {
        focusOnceSessionRef.current = info.sessionId;
        setSelectedId(info.sessionId);
        setTab("live");
        setPinLiveBottomSeq((n) => n + 1);
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

  async function handleAttach() {
    if (!detail) return;
    setControlBusy(true);
    setError(null);
    try {
      const info = await attachAgent({
        sessionId: detail.card.id,
        cwd: detail.card.cwd,
        alwaysApprove: false,
      });
      upsertManaged(info);
      setTab("live");
      setPinLiveBottomSeq((n) => n + 1);
      // Hydrate any already-queued permissions (usually empty right after attach)
      const queued = await listPendingPermissions(info.handleId);
      hydratePermissions(queued);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
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

  async function handleBindProject(preset: PolicyPreset) {
    if (!projectCwd) return;
    setPolicyBusy(true);
    try {
      const r = await bindProjectPolicy(projectCwd, preset);
      setResolved(r);
      setResolvedPolicy(r);
      setPolicyState(r.config);
      setBindings(await listProjectBindings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyBusy(false);
    }
  }

  async function handleSetDefault(preset: PolicyPreset) {
    setPolicyBusy(true);
    try {
      await setDefaultPolicyPreset(preset);
      // Re-resolve for current project context
      await refreshPolicyForCwd(projectCwd);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyBusy(false);
    }
  }

  async function handleUnbindProject() {
    if (!projectCwd) return;
    setPolicyBusy(true);
    try {
      const r = await unbindProjectPolicy(projectCwd);
      setResolved(r);
      setResolvedPolicy(r);
      setPolicyState(r.config);
      setBindings(await listProjectBindings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyBusy(false);
    }
  }

  async function handleSend(text: string) {
    if (!managedForSession) return;
    setControlBusy(true);
    setError(null);
    try {
      await promptAgent(managedForSession.handleId, text);
      setTab("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }

  async function handleStop() {
    if (!managedForSession) return;
    setControlBusy(true);
    try {
      await stopAgent(managedForSession.handleId);
      removeManaged(managedForSession.handleId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setControlBusy(false);
    }
  }

  const defaultCwd = detail?.card.cwd ?? sessions[0]?.cwd ?? "";

  const managedSessionIds = useMemo(
    () =>
      new Set(
        managedList
          .filter(
            (m) =>
              m.sessionId &&
              m.status !== "stopped" &&
              m.status !== "error",
          )
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
            onNewTask={() => setModalOpen(true)}
          />
        </aside>

        <SessionDetailView
          detail={detail}
          loading={detailLoading}
          error={detailError}
          tab={tab}
          onTab={setTab}
          liveItems={liveItems}
          shellEntries={shellEntries}
          managed={managedForSession}
          permissions={permissionsForSession}
          permBusyKey={permBusyKey}
          controlBusy={controlBusy}
          onSendPrompt={(t) => void handleSend(t)}
          onAttach={() => void handleAttach()}
          onStop={() => void handleStop()}
          onResolvePermission={(item, opt) =>
            void handleResolvePermission(item, opt)
          }
          pinLiveBottomSeq={pinLiveBottomSeq}
        />

        <aside className="side-panel">
          <PolicyCenter
            resolved={resolved}
            presets={presets}
            bindings={bindings}
            projectCwd={projectCwd}
            busy={policyBusy}
            recentActions={policyActions}
            onBindProject={(preset) => void handleBindProject(preset)}
            onSetDefault={(preset) => void handleSetDefault(preset)}
            onUnbindProject={() => void handleUnbindProject()}
          />

          <div className="panel-header">
            <h2>Change radar</h2>
          </div>
          {detail ? (
            <>
              <p className="muted small side-blurb">
                File hunks for the selected session. Managed agents:{" "}
                {
                  managedList.filter(
                    (m) => m.status !== "stopped" && m.status !== "error",
                  ).length
                }{" "}
                live.
              </p>
              <DiffPanel hunks={detail.hunks} />
            </>
          ) : (
            <div className="empty-hint">Select a session to inspect diffs.</div>
          )}

          <div className="roadmap">
            <h3>Status</h3>
            <ul>
              <li className="done">Session board + token metrics</li>
              <li className="done">Spawn / attach + live ACP stream</li>
              <li className="done">Permission gate</li>
              <li className="done">Risk policy center</li>
              <li className="done">Per-project policy binding</li>
              <li className="done">Live shell output panel</li>
            </ul>
          </div>
        </aside>
      </div>

      <NewTaskModal
        open={modalOpen}
        defaultCwd={defaultCwd}
        busy={controlBusy}
        onClose={() => setModalOpen(false)}
        onSubmit={(o) => void handleSpawn(o)}
      />
    </div>
  );
}

export default App;
