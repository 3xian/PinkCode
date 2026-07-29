import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";

/** User-facing status for a manual (non-silent) update check. */
export type UpdateCheckStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "error";

/**
 * Check GitHub `latest.json` for a newer signed build.
 * Startup check is silent; brand-click / manual checks surface status briefly.
 *
 * Concurrent calls share one in-flight request. A manual check that joins a
 * silent startup check still gets visible "checking" + result feedback.
 */
export function useAppUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<UpdateCheckStatus>("idle");
  const statusTimer = useRef<number | null>(null);
  /** True when any caller wants user-visible status for the current check. */
  const wantVisibleRef = useRef(false);
  const inflightRef = useRef<Promise<void> | null>(null);

  const clearStatusTimer = useCallback(() => {
    if (statusTimer.current != null) {
      window.clearTimeout(statusTimer.current);
      statusTimer.current = null;
    }
  }, []);

  const flashStatus = useCallback(
    (next: UpdateCheckStatus, ms = 2400) => {
      clearStatusTimer();
      setStatus(next);
      if (next === "idle" || next === "checking") return;
      statusTimer.current = window.setTimeout(() => {
        setStatus("idle");
        statusTimer.current = null;
      }, ms);
    },
    [clearStatusTimer],
  );

  const checkForUpdate = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;

      if (!silent) {
        wantVisibleRef.current = true;
        clearStatusTimer();
        setStatus("checking");
      }

      // Join an in-flight check instead of no-op (manual can attach to silent).
      if (inflightRef.current) {
        await inflightRef.current;
        return;
      }

      const run = async () => {
        try {
          const next = await check();
          const visible = wantVisibleRef.current;
          if (next) {
            setUpdate(next);
            if (visible) {
              clearStatusTimer();
              setStatus("idle");
            }
            return;
          }
          if (visible) flashStatus("up-to-date");
        } catch (e) {
          // Expected in `tauri dev` and when latest.json is missing/unsigned.
          console.debug("[updater] check skipped:", e);
          if (wantVisibleRef.current) flashStatus("error");
        } finally {
          wantVisibleRef.current = false;
          inflightRef.current = null;
        }
      };

      const pending = run();
      inflightRef.current = pending;
      await pending;
    },
    [clearStatusTimer, flashStatus],
  );

  useEffect(() => {
    void checkForUpdate({ silent: true });
    return () => {
      clearStatusTimer();
    };
  }, [checkForUpdate, clearStatusTimer]);

  return {
    pendingUpdate: update,
    dismissUpdate: () => setUpdate(null),
    checkForUpdate: () => void checkForUpdate({ silent: false }),
    updateCheckStatus: status,
  };
}
