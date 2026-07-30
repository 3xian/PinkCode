import type { UpdateCheckStatus } from "../hooks/useAppUpdate";

export type WindowCommand = "minimize" | "maximize" | "close";

const UPDATE_STATUS_LABEL: Partial<Record<UpdateCheckStatus, string>> = {
  checking: "Checking for updates…",
  "up-to-date": "You're up to date",
  error: "Update check failed",
};

export function windowsUpdateStatusLabel(
  status: UpdateCheckStatus,
): string | null {
  return UPDATE_STATUS_LABEL[status] ?? null;
}

/** Execute a native window command without turning rejected IPC into a silent no-op. */
export async function runWindowCommand(
  command: WindowCommand,
  invoke: () => Promise<void>,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await invoke();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onError(`Failed to ${command} window: ${detail}`);
  }
}
