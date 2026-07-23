import { useCallback, useRef, useState } from "react";
import { setSessionMode, setTaskPlanArmed } from "../api";
import { applyAgentModeUpdate } from "../utils/sessionMode";

export type PlanState = "off" | "pending" | "active";

export function useSessionPlanMode() {
  const [planStateBySession, setPlanStateBySession] = useState<
    Record<string, PlanState>
  >({});
  const planStateRef = useRef<Record<string, PlanState>>({});
  planStateRef.current = planStateBySession;

  const setState = useCallback(
    (sessionId: string, state: PlanState) => {
      setPlanStateBySession((prev) => {
        if (prev[sessionId] === state) return prev;
        return { ...prev, [sessionId]: state };
      });
    },
    [],
  );

  const setArmedLocal = useCallback(
    (sessionId: string, armed: boolean) => {
      setState(sessionId, armed ? "active" : "off");
    },
    [setState],
  );

  const hydrate = useCallback((map: Record<string, boolean>) => {
    const next: Record<string, PlanState> = {};
    for (const [id, armed] of Object.entries(map)) {
      next[id] = armed ? "pending" : "off";
    }
    setPlanStateBySession(next);
  }, []);

  const isArmed = useCallback(
    (sessionId: string | null | undefined): boolean => {
      const st = sessionId ? planStateBySession[sessionId] : undefined;
      return st === "pending" || st === "active";
    },
    [planStateBySession],
  );

  const onAgentModeUpdate = useCallback(
    (sessionId: string, modeId: string) => {
      const wasActive = planStateRef.current[sessionId] === "active";
      const next = applyAgentModeUpdate(modeId, wasActive);
      const newState: PlanState = next.planArmed === true
        ? "active"
        : next.planArmed === false
          ? "off"
          : planStateRef.current[sessionId] ?? "off";
      setState(sessionId, newState);
      if (next.planArmed !== null) {
        void setTaskPlanArmed(sessionId, next.planArmed).catch(() => {});
      }
    },
    [setState],
  );

  const applyAfterSpawn = useCallback(
    async (sessionId: string) => {
      setState(sessionId, "active");
      try {
        await setTaskPlanArmed(sessionId, true);
      } catch {}
    },
    [setState],
  );

  const reapplyAfterAttach = useCallback(
    async (handleId: string, sessionId: string) => {
      if (!isArmed(sessionId)) return;
      try {
        await setSessionMode(handleId, "plan");
        setState(sessionId, "active");
      } catch {}
    },
    [isArmed, setState],
  );

  const syncPlanArming = useCallback(
    async (
      sessionId: string,
      armed: boolean,
      liveHandleId: string | null,
    ) => {
      await setTaskPlanArmed(sessionId, armed);
      setState(sessionId, armed ? "active" : "off");
      if (!liveHandleId) return;
      await setSessionMode(liveHandleId, armed ? "plan" : "default");
    },
    [setState],
  );

  const ensurePlanModeForTurn = useCallback(
    async (
      handleId: string,
      sessionId: string | null,
      promptText: string,
    ): Promise<{ modeError: string | null }> => {
      const wantsPlan =
        Boolean(sessionId && isArmed(sessionId)) ||
        promptText === "/plan" ||
        promptText.startsWith("/plan ");
      if (!wantsPlan) return { modeError: null };
      try {
        await setSessionMode(handleId, "plan");
        if (sessionId) {
          setState(sessionId, "active");
        }
        return { modeError: null };
      } catch (e) {
        return {
          modeError: `session/set_mode(plan) failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
    [isArmed, setState],
  );

  const onPlanApprovalResolved = useCallback(
    async (sessionId: string | null, optionId: string) => {
      if (!sessionId) return;
      if (optionId !== "approve" && optionId !== "abandon") return;
      setState(sessionId, "off");
      try {
        await setTaskPlanArmed(sessionId, false);
      } catch {}
    },
    [setState],
  );

  return {
    planStateBySession,
    hydrate,
    isArmed,
    setArmedLocal,
    onAgentModeUpdate,
    applyAfterSpawn,
    reapplyAfterAttach,
    syncPlanArming,
    ensurePlanModeForTurn,
    onPlanApprovalResolved,
  };
}
