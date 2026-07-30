import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

/** Read the packaged app version only when the platform-specific chrome needs it. */
export function useAppVersion(enabled: boolean): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void getVersion()
      .then((next) => {
        if (!cancelled) setVersion(next);
      })
      .catch(() => {
        /* Leave the runtime version empty. */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return version;
}
