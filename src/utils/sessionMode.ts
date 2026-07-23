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
 * Real activation over ACP is `session/set_mode({ modeId: "plan" })` (Grok
 * Build `handle_session_mode` → enter_pending). The `/plan` prefix is TUI
 * parity / model-visible label; it is not sufficient alone.
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
 * Reconcile host Plan arming with an ACP `current_mode_update`.
 *
 * Grok SessionMode wire ids: `default` | `plan` | `ask` (unknown → default).
 * `set_mode(plan)` enters **Pending** and already emits `current_mode_update`
 * with `plan` (client chrome shows plan before the first prompt). First prompt
 * then activates plan constraints inside the agent.
 *
 * - agent → `plan`: mark active + armed
 * - agent leaves plan (was active / reported plan): clear armed
 * - agent non-plan while never reported plan: leave armed unchanged (host-only Pending before set_mode lands)
 */
export function applyAgentModeUpdate(
  modeId: string,
  wasActive: boolean,
): { planActive: boolean; planArmed: boolean | null } {
  if (modeId === "plan") {
    return { planActive: true, planArmed: true };
  }
  if (wasActive) {
    return { planActive: false, planArmed: false };
  }
  return { planActive: false, planArmed: null };
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


