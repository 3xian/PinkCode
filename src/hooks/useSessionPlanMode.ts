import { useCallback, useRef, useState } from "react";
import { setSessionMode, setTaskPlanArmed } from "../api";
import { applyAgentModeUpdate } from "../utils/sessionMode";

/**
 * Single owner for host Plan mode state (Grok plan is orthogonal to permission).
 *
 * - `planArmed` — UI/persistence Pending or Active (Mode chip shows Plan)
 * - `planActive` (ref) — agent has reported / we have called set_mode(plan)
 *   so a non-plan `current_mode_update` may clear arming
 *
 * All ACP `session/set_mode` and plan-arming side effects for the host UI
 * should go through this hook so App.tsx does not re-sync refs by hand.
 */
export function useSessionPlanMode() {
  const [planArmedBySession, setPlanArmedBySession] = useState<
    Record<string, boolean>
  >({});
  const planActiveBySessionRef = useRef<Record<string, boolean>>({});

  const hydrate = useCallback((map: Record<string, boolean>) => {
    setPlanArmedBySession(map);
  }, []);

  const isArmed = useCallback(
    (sessionId: string | null | undefined): boolean =>
      Boolean(sessionId && planArmedBySession[sessionId]),
    [planArmedBySession],
  );

  const setActive = useCallback((sessionId: string, active: boolean) => {
    planActiveBySessionRef.current = {
      ...planActiveBySessionRef.current,
      [sessionId]: active,
    };
  }, []);

  const setArmedLocal = useCallback(
    (sessionId: string, armed: boolean, opts?: { active?: boolean }) => {
      if (opts?.active !== undefined) {
        setActive(sessionId, opts.active);
      } else if (!armed) {
        setActive(sessionId, false);
      }
      setPlanArmedBySession((prev) => ({ ...prev, [sessionId]: armed }));
    },
    [setActive],
  );

  /** ACP current_mode_update → reconcile arming (pure rules in sessionMode). */
  const onAgentModeUpdate = useCallback(
    (sessionId: string, modeId: string) => {
      const wasActive = Boolean(planActiveBySessionRef.current[sessionId]);
      const next = applyAgentModeUpdate(modeId, wasActive);
      setActive(sessionId, next.planActive);
      if (next.planArmed === null) return;
      const armed = next.planArmed;
      setPlanArmedBySession((prev) => {
        if (Boolean(prev[sessionId]) === armed) return prev;
        return { ...prev, [sessionId]: armed };
      });
      void setTaskPlanArmed(sessionId, armed).catch(() => {
        /* best-effort */
      });
    },
    [setActive],
  );

  /** Persist + local arm after spawn already applied session/set_mode("plan"). */
  const applyAfterSpawn = useCallback(
    async (sessionId: string) => {
      setActive(sessionId, true);
      setPlanArmedBySession((prev) => ({ ...prev, [sessionId]: true }));
      try {
        await setTaskPlanArmed(sessionId, true);
      } catch {
        /* best-effort; Mode chip still shows from local state */
      }
    },
    [setActive],
  );

  /** Re-apply plan mode after attach when host prefs still have Plan armed. */
  const reapplyAfterAttach = useCallback(
    async (handleId: string, sessionId: string) => {
      if (!planArmedBySession[sessionId]) return;
      try {
        await setSessionMode(handleId, "plan");
        setActive(sessionId, true);
      } catch {
        /* best-effort — first send will retry */
      }
    },
    [planArmedBySession, setActive],
  );

  /**
   * Mode chip / Shift+Tab: persist plan arming and sync ACP when an agent is live.
   * Does not call set_mode(default) on approve path (that races ExitPending).
   */
  const syncPlanArming = useCallback(
    async (
      sessionId: string,
      armed: boolean,
      liveHandleId: string | null,
    ) => {
      await setTaskPlanArmed(sessionId, armed);
      if (!liveHandleId) return;
      await setSessionMode(liveHandleId, armed ? "plan" : "default");
      if (armed) setActive(sessionId, true);
    },
    [setActive],
  );

  /**
   * Before session/prompt: ensure ACP plan mode when armed or `/plan` text.
   * Prefix alone does not activate Grok plan mode over ACP.
   */
  const ensurePlanModeForTurn = useCallback(
    async (
      handleId: string,
      sessionId: string | null,
      promptText: string,
    ): Promise<{ modeError: string | null }> => {
      const wantsPlan =
        Boolean(sessionId && planArmedBySession[sessionId]) ||
        promptText === "/plan" ||
        promptText.startsWith("/plan ") ||
        promptText.startsWith("/plan\t");
      if (!wantsPlan) return { modeError: null };
      try {
        await setSessionMode(handleId, "plan");
        if (sessionId) {
          setActive(sessionId, true);
          setPlanArmedBySession((prev) =>
            prev[sessionId] ? prev : { ...prev, [sessionId]: true },
          );
        }
        return { modeError: null };
      } catch (e) {
        return {
          modeError:
            e instanceof Error
              ? `session/set_mode(plan) failed: ${e.message}`
              : `session/set_mode(plan) failed: ${String(e)}`,
        };
      }
    },
    [planArmedBySession, setActive],
  );

  /**
   * After plan-approval resolve: approve/abandon leave plan (optimistic UI).
   * request-changes stays in plan — no arming change.
   * Do not call session/set_mode("default") here (races in-flight exit).
   */
  const onPlanApprovalResolved = useCallback(
    async (sessionId: string | null, optionId: string) => {
      if (!sessionId) return;
      if (optionId !== "approve" && optionId !== "abandon") return;
      setActive(sessionId, false);
      setPlanArmedBySession((prev) => ({ ...prev, [sessionId]: false }));
      try {
        await setTaskPlanArmed(sessionId, false);
      } catch {
        /* best-effort */
      }
    },
    [setActive],
  );

  return {
    planArmedBySession,
    hydrate,
    isArmed,
    onAgentModeUpdate,
    setArmedLocal,
    applyAfterSpawn,
    reapplyAfterAttach,
    syncPlanArming,
    ensurePlanModeForTurn,
    onPlanApprovalResolved,
  };
}
