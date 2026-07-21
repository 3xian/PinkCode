import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import type { UpdatePrompt } from "../components/UpdateModal";

/**
 * On startup, check GitHub `latest.json` for a newer signed build.
 * Failures (dev, offline, no release assets) are silent — no toast spam.
 */
export function useAppUpdate() {
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const update = await check();
        if (cancelled || !update) return;
        setPrompt({
          update,
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
        });
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
    updatePrompt: prompt,
    dismissUpdate: () => setPrompt(null),
  };
}
