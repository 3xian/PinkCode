import type { PermissionMode, SessionMode } from "../types";
import { SESSION_MODES } from "../types";

/** Shift+Tab order (Grok): Normal → Plan → Auto → Always-approve → … */
export function cycleSessionMode(current: SessionMode): SessionMode {
  const i = SESSION_MODES.indexOf(current);
  const next = i < 0 ? 0 : (i + 1) % SESSION_MODES.length;
  return SESSION_MODES[next]!;
}

/**
 * When Mode is Plan and the user sends free text, prefix `/plan`.
 * Slash commands and empty strings are left alone.
 *
 * Matches Grok: Plan Pending → first free-text becomes `/plan <description>`
 * (activates plan and starts a turn).
 */
export function applySessionModeToPrompt(
  mode: SessionMode,
  text: string,
): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (mode !== "plan") return text;
  if (trimmed.startsWith("/")) return text;
  return `/plan ${trimmed}`;
}

/**
 * Display Mode from the two-source model:
 * - `planArmed` — Plan is orthogonal to permission (Grok status shows `plan`)
 * - `permission` (persisted host gate) — Ask / Auto / Always-approve / fine-grained
 */
export function displaySessionMode(
  planArmed: boolean,
  permission: PermissionMode,
): SessionMode {
  if (planArmed) return "plan";
  return sessionModeFromPermission(permission);
}

/**
 * Result of choosing a Grok session Mode.
 * `permission: null` means leave the host gate unchanged.
 */
export interface SessionModeApply {
  planArmed: boolean;
  permission: PermissionMode | null;
}

/**
 * Map Mode chip / Shift+Tab onto planArmed + optional permission write.
 *
 * Grok rules:
 * - Plan is orthogonal — never rewrite the underlying permission.
 * - Normal only resets when leaving Auto / Always-approve (do not clobber
 *   acceptEdits / dontAsk fine-grained host policies).
 */
export function applySessionModeChange(
  mode: SessionMode,
  currentPermission: PermissionMode = "default",
): SessionModeApply {
  switch (mode) {
    case "plan":
      return { planArmed: true, permission: null };
    case "auto":
      return { planArmed: false, permission: "auto" };
    case "alwaysApprove":
      return { planArmed: false, permission: "bypassPermissions" };
    case "normal":
      if (
        currentPermission === "auto" ||
        currentPermission === "bypassPermissions"
      ) {
        return { planArmed: false, permission: "default" };
      }
      // acceptEdits / dontAsk / default: clear plan only.
      return { planArmed: false, permission: null };
  }
}

/**
 * Derive non-Plan Mode from host permission.
 * acceptEdits / dontAsk surface as Normal (spawn-only fine-grained policies).
 */
export function sessionModeFromPermission(
  permission: PermissionMode,
): SessionMode {
  switch (permission) {
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "alwaysApprove";
    default:
      return "normal";
  }
}

/** Collapse fine-grained host policies to Grok's permission ring for slash sync. */
export type PermissionRing = "ask" | "auto" | "yolo";

export function permissionRing(mode: PermissionMode): PermissionRing {
  if (mode === "auto") return "auto";
  if (mode === "bypassPermissions") return "yolo";
  return "ask";
}

/**
 * Reference mapping of host permission ring transitions to Grok TUI toggle
 * slashes (`/auto`, `/always-approve`).
 *
 * Not used for live Mode-chip / Shift+Tab changes: those only update the host
 * ACP gate. Sending these strings via `session/prompt` starts a real agent turn
 * (unlike the Grok Build TUI, where they are local toggles with no tool runs).
 * Kept so manual prompt autocomplete semantics stay documented/tested.
 */
export function agentSlashForPermissionTransition(
  from: PermissionMode,
  to: PermissionMode,
): "/auto" | "/always-approve" | null {
  const a = permissionRing(from);
  const b = permissionRing(to);
  if (a === b) return null;
  if (b === "auto") return "/auto";
  if (b === "yolo") return "/always-approve";
  // Back to ask: toggle off the mode that was on.
  if (a === "auto") return "/auto";
  if (a === "yolo") return "/always-approve";
  return null;
}

/**
 * Whether the agent is idle. Historically gated auto-sending mode slashes;
 * Mode chip no longer prompts the agent (host gate only).
 */
export function canSendModeSlash(status: string | undefined | null): boolean {
  return status === "ready";
}
