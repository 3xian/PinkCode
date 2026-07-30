/**
 * Platform detection for shell chrome (macOS Overlay titlebar, etc.).
 * Single source of truth — used by bootstrap and components.
 */

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

function isMacOs(): boolean {
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  return (
    uaData?.platform === "macOS" ||
    /Mac|Macintosh|MacIntel/i.test(navigator.platform) ||
    /Mac OS X/i.test(navigator.userAgent)
  );
}

function isWindows(): boolean {
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  return (
    uaData?.platform === "Windows" ||
    /Win/i.test(navigator.platform) ||
    /Windows/i.test(navigator.userAgent)
  );
}

/** True only inside the Tauri app on macOS (not plain browser vite preview). */
export function isMacosDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return isTauriRuntime() && isMacOs();
}

/** True only inside the Tauri app on Windows (not plain browser vite preview). */
export function isWindowsDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return isTauriRuntime() && isWindows();
}
