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
 * Best-effort Grok slash to keep the agent process mode in sync with the host
 * gate. Grok treats `/auto` and `/always-approve` as toggles; switching between
 * them (or off) is done by invoking the target / previous command once.
 *
 * Returns null when the ring side of the mode is unchanged (e.g. default ↔
 * acceptEdits) or when no agent slash applies.
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
 * Whether the attached agent is idle enough to accept a mode slash without
 * interrupting a turn (Grok mode toggles apply when idle).
 */
export function canSendModeSlash(status: string | undefined | null): boolean {
  return status === "ready";
}
