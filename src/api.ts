import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveSession,
  AttachRequest,
  DashboardStats,
  HunkRecord,
  ManagedAgentInfo,
  PendingPermission,
  PolicyConfig,
  PolicyPreset,
  ProjectBinding,
  ResolvedPolicy,
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
): Promise<{ accepted: boolean; handleId: string; sessionId: string }> {
  return invoke<{ accepted: boolean; handleId: string; sessionId: string }>(
    "prompt_agent",
    { handleId, text },
  );
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
): Promise<PendingPermission> {
  return invoke<PendingPermission>("resolve_permission", {
    request: { handleId, requestKey, optionId },
  });
}

export async function getPolicy(): Promise<PolicyConfig> {
  return invoke<PolicyConfig>("get_policy");
}

export async function resolvePolicy(cwd?: string | null): Promise<ResolvedPolicy> {
  return invoke<ResolvedPolicy>("resolve_policy", { cwd: cwd ?? null });
}

export async function setDefaultPolicyPreset(
  preset: PolicyPreset,
): Promise<ResolvedPolicy> {
  return invoke<ResolvedPolicy>("set_default_policy_preset", { preset });
}

export async function bindProjectPolicy(
  cwd: string,
  preset: PolicyPreset,
): Promise<ResolvedPolicy> {
  return invoke<ResolvedPolicy>("bind_project_policy", { cwd, preset });
}

export async function unbindProjectPolicy(cwd: string): Promise<ResolvedPolicy> {
  return invoke<ResolvedPolicy>("unbind_project_policy", { cwd });
}

export async function listProjectBindings(): Promise<ProjectBinding[]> {
  return invoke<ProjectBinding[]>("list_project_bindings");
}

/** @deprecated prefer setDefaultPolicyPreset / bindProjectPolicy */
export async function setPolicyPreset(preset: PolicyPreset): Promise<PolicyConfig> {
  return invoke<PolicyConfig>("set_policy_preset", { preset });
}

export async function listPolicyPresets(): Promise<PolicyConfig[]> {
  return invoke<PolicyConfig[]>("list_policy_presets");
}
