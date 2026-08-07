import logoMark from "../assets/logo.png";
import type { UpdateCheckStatus } from "../hooks/useAppUpdate";
import { useAppVersion } from "../hooks/useAppVersion";
import { isMacosDesktop } from "../utils/platform";

const STATUS_LINE: Partial<Record<UpdateCheckStatus, string>> = {
  checking: "Checking for updates…",
  "up-to-date": "You're up to date",
  error: "Update check failed",
};

/**
 * macOS-only Overlay chrome: empty traffic-light strip, brand mark below.
 * Brand click runs a manual update check. Not rendered on Windows / Linux.
 */
export function MacosTitlebarBrand({
  onCheckUpdate,
  checkStatus,
}: {
  onCheckUpdate: () => void;
  checkStatus: UpdateCheckStatus;
}) {
  const macDesktop = isMacosDesktop();
  const version = useAppVersion(macDesktop);

  if (!macDesktop) return null;

  const statusLine =
    STATUS_LINE[checkStatus] ?? (version ? `v${version}` : null);
  const busy = checkStatus === "checking";

  return (
    <div
      className="macos-titlebar"
      role="banner"
      aria-label={version ? `PinkCode v${version}` : "PinkCode"}
    >
      {/* Native traffic lights sit here; keep clear + draggable */}
      <div className="macos-titlebar-traffic" data-tauri-drag-region />
      <button
        type="button"
        className={`macos-titlebar-brand${
          checkStatus !== "idle" ? ` is-${checkStatus}` : ""
        }`}
        onClick={() => {
          if (!busy) onCheckUpdate();
        }}
        disabled={busy}
        title="Check for updates"
        aria-label="Check for updates"
      >
        <img
          className="macos-titlebar-logo"
          src={logoMark}
          alt=""
          width={22}
          height={22}
          draggable={false}
        />
        <div className="macos-titlebar-copy">
          <span className="macos-titlebar-name text-title-gradient">PinkCode</span>
          {statusLine ? (
            <span className="macos-titlebar-version">{statusLine}</span>
          ) : null}
        </div>
      </button>
    </div>
  );
}
