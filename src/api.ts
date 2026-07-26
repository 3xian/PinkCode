import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveSession,
  AttachRequest,
  DashboardStats,
  DirEntry,
  FilePreview,
  GitChange,
  HunkRecord,
  ManagedAgentInfo,
  PendingPermission,
  PermissionMode,
  SessionCard,
  SessionDetail,
  SpawnRequest,
  TokenUsageSeries,
  WeekUsage,
} from "./types";

export async function getGrokHome(): Promise<string> {
  return invoke<string>("get_grok_home");
}

export async function listActiveSessions(): Promise<ActiveSession[]> {
  return invoke<ActiveSession[]>("list_active_sessions");
}

export async function listSessions(limit?: number): Promise<SessionCard[]> {
  return invoke<SessionCard[]>("list_sessions", { limit: limit ?? null });
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail> {
  return invoke<SessionDetail>("get_session_detail", { sessionId });
}

export async function listSessionHunks(
  sessionId: string,
  limit?: number,
): Promise<HunkRecord[]> {
  return invoke<HunkRecord[]>("list_session_hunks", {
    sessionId,
    limit: limit ?? null,
  });
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return invoke<DashboardStats>("get_dashboard_stats");
}

export async function getTokenUsageSeries(days = 7): Promise<TokenUsageSeries> {
  return invoke<TokenUsageSeries>("get_token_usage_series", { days });
}

export async function getWeekUsage(): Promise<WeekUsage> {
  return invoke<WeekUsage>("get_week_usage");
}

export async function resolveGrokBin(): Promise<string> {
  return invoke<string>("resolve_grok_bin");
}

export async function listManagedAgents(): Promise<ManagedAgentInfo[]> {
  return invoke<ManagedAgentInfo[]>("list_managed_agents");
}

export async function spawnAgent(request: SpawnRequest): Promise<ManagedAgentInfo> {
  return invoke<ManagedAgentInfo>("spawn_agent", { request });
}

export async function attachAgent(request: AttachRequest): Promise<ManagedAgentInfo> {
  return invoke<ManagedAgentInfo>("attach_agent", { request });
}

export async function promptAgent(
  handleId: string,
  text: string,
): Promise<{
  accepted: boolean;
  handleId: string;
  sessionId: string;
  /** Managed agent status after accept (usually `"running"`). */
  status?: ManagedAgentInfo["status"];
}> {
  return invoke("prompt_agent", { handleId, text });
}

export async function stopAgent(handleId: string): Promise<ManagedAgentInfo> {
  return invoke<ManagedAgentInfo>("stop_agent", { handleId });
}

export async function findManagedBySession(
  sessionId: string,
): Promise<ManagedAgentInfo | null> {
  return invoke<ManagedAgentInfo | null>("find_managed_by_session", { sessionId });
}

export async function listPendingPermissions(
  handleId?: string | null,
): Promise<PendingPermission[]> {
  return invoke<PendingPermission[]>("list_pending_permissions", {
    handleId: handleId ?? null,
  });
}

export async function resolvePermission(
  handleId: string,
  requestKey: string,
  optionId: string,
  comments?: string | null,
  /** Structured answers for userQuestion (see UserQuestionResolvePayload). */
  payload?: object | null,
): Promise<PendingPermission> {
  return invoke<PendingPermission>("resolve_permission", {
    request: {
      handleId,
      requestKey,
      optionId,
      comments: comments ?? null,
      payload: payload ?? null,
    },
  });
}

export async function setPermissionMode(
  handleId: string,
  mode: PermissionMode,
): Promise<ManagedAgentInfo> {
  return invoke<ManagedAgentInfo>("set_permission_mode", {
    handleId,
    mode,
  });
}

/**
 * ACP `session/set_mode` — e.g. `"plan"` / `"default"`.
 * Prefixing `/plan` in prompt text alone does not enter Grok plan mode over ACP.
 */
export async function setSessionMode(
  handleId: string,
  modeId: string,
): Promise<void> {
  return invoke("set_session_mode", { handleId, modeId });
}

/** Persist mode for a session even when no agent is live. */
export async function setTaskPermissionMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  return invoke("set_task_permission_mode", { sessionId, mode });
}

export async function getTaskPermissionMode(
  sessionId: string,
): Promise<PermissionMode | null> {
  return invoke<PermissionMode | null>("get_task_permission_mode", {
    sessionId,
  });
}

export async function listTaskPermissionModes(): Promise<
  Record<string, PermissionMode>
> {
  return invoke<Record<string, PermissionMode>>("list_task_permission_modes");
}

export async function getLastSpawnPermissionMode(): Promise<PermissionMode> {
  return invoke<PermissionMode>("get_last_spawn_permission_mode");
}

/** Persist Grok Plan arming (Pending) for a session. */
export async function setTaskPlanArmed(
  sessionId: string,
  armed: boolean,
): Promise<void> {
  return invoke("set_task_plan_armed", { sessionId, armed });
}

export async function getTaskPlanArmed(sessionId: string): Promise<boolean> {
  return invoke<boolean>("get_task_plan_armed", { sessionId });
}

export async function listTaskPlanArmed(): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>("list_task_plan_armed");
}

/** Session plan.md (Grok plan mode artifact under ~/.grok/sessions/…). */
export interface SessionPlan {
  path: string;
  content: string;
  empty: boolean;
}

export async function getSessionPlan(
  sessionId: string,
): Promise<SessionPlan | null> {
  return invoke<SessionPlan | null>("get_session_plan", { sessionId });
}

export async function listProjectDir(
  root: string,
  path?: string | null,
): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_project_dir", {
    root,
    path: path ?? null,
  });
}

/** Open a project path with the OS default application (must stay under root). */
export async function openProjectPath(
  root: string,
  path: string,
  sessionId?: string | null,
): Promise<void> {
  return invoke("open_project_path", {
    root,
    path,
    sessionId: sessionId ?? null,
  });
}

/**
 * Read a project file (or Grok session asset such as `images/1.jpg`) for the
 * in-app preview pane.
 */
export async function readProjectFile(
  root: string,
  path: string,
  sessionId?: string | null,
): Promise<FilePreview> {
  return invoke<FilePreview>("read_project_file", {
    root,
    path,
    sessionId: sessionId ?? null,
  });
}

export async function gitStatus(cwd: string): Promise<GitChange[]> {
  return invoke<GitChange[]>("git_status", { cwd });
}
