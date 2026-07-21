import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getTokenUsageSeries, getWeekUsage } from "../api";
import type { TokenUsageSeries, WeekUsage } from "../types";

const WEEK_USAGE_IDLE_POLL_MS = 60_000;
const WEEK_USAGE_ACTIVE_POLL_MS = 20_000;
const WEEK_USAGE_AFTER_TURN_MS = 2_500;
const WEEK_USAGE_MIN_GAP_MS = 8_000;
const TOKEN_SERIES_POLL_MS = 90_000;

export function useUsageMetrics(
  liveManagedCount: number,
  onPromptComplete?: () => void,
) {
  const [tokenSeries, setTokenSeries] = useState<TokenUsageSeries | null>(null);
  const [weekUsage, setWeekUsage] = useState<WeekUsage | null>(null);
  const weekUsageInflight = useRef(false);
  const weekUsageLastAt = useRef(0);
  const weekUsageTimer = useRef<number | null>(null);
  const tokenRefreshTimer = useRef<number | null>(null);
  const onPromptCompleteRef = useRef(onPromptComplete);
  onPromptCompleteRef.current = onPromptComplete;

  const refreshTokenSeries = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    try {
      setTokenSeries(await getTokenUsageSeries(7));
    } catch {
      // Non-Tauri preview or unavailable local session data.
    }
  }, []);

  const refreshWeekUsage = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force ?? false;
    const now = Date.now();
    if (!force && now - weekUsageLastAt.current < WEEK_USAGE_MIN_GAP_MS) return;
    if (weekUsageInflight.current) return;
    weekUsageInflight.current = true;
    try {
      setWeekUsage(await getWeekUsage());
      weekUsageLastAt.current = Date.now();
    } catch {
      // Non-Tauri preview or offline billing endpoint.
    } finally {
      weekUsageInflight.current = false;
    }
  }, []);

  const scheduleWeekUsageRefresh = useCallback(() => {
    if (weekUsageTimer.current != null) {
      window.clearTimeout(weekUsageTimer.current);
    }
    weekUsageTimer.current = window.setTimeout(() => {
      weekUsageTimer.current = null;
      void refreshWeekUsage({ force: true });
    }, WEEK_USAGE_AFTER_TURN_MS);
  }, [refreshWeekUsage]);

  useEffect(() => {
    void refreshTokenSeries();
    const id = window.setInterval(refreshTokenSeries, TOKEN_SERIES_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshTokenSeries]);

  useEffect(() => {
    void refreshWeekUsage({ force: true });
    const interval =
      liveManagedCount > 0 ? WEEK_USAGE_ACTIVE_POLL_MS : WEEK_USAGE_IDLE_POLL_MS;
    const id = window.setInterval(refreshWeekUsage, interval);
    return () => window.clearInterval(id);
  }, [refreshWeekUsage, liveManagedCount]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("agent-prompt-complete", () => {
      if (cancelled) return;
      scheduleWeekUsageRefresh();
      if (tokenRefreshTimer.current != null) {
        window.clearTimeout(tokenRefreshTimer.current);
      }
      tokenRefreshTimer.current = window.setTimeout(() => {
        tokenRefreshTimer.current = null;
        void refreshTokenSeries();
      }, 1_500);
      onPromptCompleteRef.current?.();
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
      if (tokenRefreshTimer.current != null) {
        window.clearTimeout(tokenRefreshTimer.current);
        tokenRefreshTimer.current = null;
      }
    };
  }, [refreshTokenSeries, scheduleWeekUsageRefresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshTokenSeries();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshTokenSeries]);

  return { tokenSeries, weekUsage, refreshWeekUsage };
}
