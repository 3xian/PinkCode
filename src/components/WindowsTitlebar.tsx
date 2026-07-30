import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useId, useRef, useState } from "react";
import logoMark from "../assets/logo.png";
import type { UpdateCheckStatus } from "../hooks/useAppUpdate";
import { useAppVersion } from "../hooks/useAppVersion";
import { isWindowsDesktop } from "../utils/platform";
import {
  runWindowCommand,
  windowsUpdateStatusLabel,
  type WindowCommand,
} from "../utils/windowsTitlebar";

/** Windows-only custom chrome so Settings sits in the title bar, not below it. */
export function WindowsTitlebar({
  onCheckUpdate,
  checkStatus,
  onWindowError,
}: {
  onCheckUpdate: () => void;
  checkStatus: UpdateCheckStatus;
  onWindowError: (message: string) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsPanelId = useId();
  const windowsDesktop = isWindowsDesktop();
  const version = useAppVersion(windowsDesktop);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setSettingsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        settingsTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  if (!windowsDesktop) return null;

  const busy = checkStatus === "checking";
  const status = windowsUpdateStatusLabel(checkStatus);
  const invokeWindowCommand = (
    command: WindowCommand,
    invoke: () => Promise<void>,
  ) => {
    void runWindowCommand(command, invoke, onWindowError);
  };

  return (
    <header className="windows-titlebar" aria-label="PinkCode window controls">
      <div className="windows-titlebar-drag" data-tauri-drag-region>
        <img
          className="windows-titlebar-logo"
          src={logoMark}
          alt=""
          width={16}
          height={16}
          draggable={false}
        />
        <span className="windows-titlebar-name">PinkCode</span>
      </div>

      <div className="windows-settings" ref={settingsRef}>
        <button
          className="windows-settings-trigger"
          type="button"
          ref={settingsTriggerRef}
          aria-expanded={settingsOpen}
          aria-controls={settingsOpen ? settingsPanelId : undefined}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <span>Settings</span>
          <svg
            className="windows-settings-chevron"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
        {settingsOpen ? (
          <div
            className="windows-settings-menu"
            id={settingsPanelId}
            aria-label="Settings"
          >
            <button
              className="windows-settings-item"
              type="button"
              disabled={busy}
              onClick={() => {
                onCheckUpdate();
                setSettingsOpen(false);
              }}
            >
              <span>Check for Updates</span>
            </button>
            <div className="windows-settings-separator" aria-hidden />
            <div className="windows-settings-version">
              <span>Current version</span>
              <span>{version ? `v${version}` : "—"}</span>
            </div>
          </div>
        ) : null}
      </div>

      {status ? (
        <span
          className={`windows-update-status is-${checkStatus}`}
          role="status"
          aria-live="polite"
        >
          {status}
        </span>
      ) : null}

      <div className="windows-titlebar-spacer" data-tauri-drag-region />

      <div className="windows-titlebar-actions">
        <div className="windows-window-controls" aria-label="Window controls">
          <button
            type="button"
            className="windows-window-control"
            aria-label="Minimize"
            onClick={() =>
              invokeWindowCommand("minimize", () =>
                getCurrentWindow().minimize(),
              )
            }
          >
            <span className="windows-control-minimize" aria-hidden />
          </button>
          <button
            type="button"
            className="windows-window-control"
            aria-label="Maximize or restore"
            onClick={() =>
              invokeWindowCommand("maximize", () =>
                getCurrentWindow().toggleMaximize(),
              )
            }
          >
            <span className="windows-control-maximize" aria-hidden />
          </button>
          <button
            type="button"
            className="windows-window-control windows-window-control-close"
            aria-label="Close"
            onClick={() =>
              invokeWindowCommand("close", () => getCurrentWindow().close())
            }
          >
            <span className="windows-control-close" aria-hidden />
          </button>
        </div>
      </div>
    </header>
  );
}
