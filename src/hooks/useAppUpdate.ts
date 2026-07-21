import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

/**
 * On startup, check GitHub `latest.json` for a newer signed build.
 * Failures (dev, offline, no release assets) are silent — no toast spam.
 */
export function useAppUpdate() {
  const [update, setUpdate] = useState<Update | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const next = await check();
        if (cancelled || !next) return;
        setUpdate(next);
      } catch (e) {
        // Expected in `tauri dev` and when latest.json is missing/unsigned.
        console.debug("[updater] check skipped:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    pendingUpdate: update,
    dismissUpdate: () => setUpdate(null),
  };
}
