export type SessionStatus = "active" | "idle" | "error" | "unknown";

export interface ActiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  openedAt: string;
}

export interface SessionCard {
  id: string;
  cwd: string;
  title: string;
  modelId?: string | null;
  agentName?: string | null;
  headBranch?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastActiveAt?: string | null;
  numMessages: number;
  isActive: boolean;
  activePid?: number | null;
  status: SessionStatus;
  contextTokensUsed: number;
  contextWindowTokens: number;
  contextWindowUsage: number;
  toolCallCount: number;
  turnCount: number;
  toolsUsed: string[];
  agentLinesAdded: number;
  agentLinesRemoved: number;
  agentFilesTouched: number;
  sessionDurationSeconds: number;
  errorCount: number;
}

export interface HunkRecord {
  hunkId?: string | null;
  filePath: string;
  hunkStart?: number | null;
  hunkEnd?: number | null;
  linesAdded: number;
  linesRemoved: number;
  authorType?: string | null;
  sessionId?: string | null;
  timestamp?: string | null;
}

export interface SessionDetail {
  card: SessionCard;
  summaryRaw: unknown;
  signalsRaw?: unknown | null;
  recentEvents: unknown[];
  recentUpdates: unknown[];
  hunks: HunkRecord[];
}

export interface DashboardStats {
  totalSessions: number;
  activeSessions: number;
  totalContextTokens: number;
  totalToolCalls: number;
  totalFilesTouched: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  grokHome: string;
}

/** One UTC day of aggregated turn token spend. */
export interface TokenDayPoint {
  date: string;
  tokens: number;
  turns: number;
}

/** Trailing window of token usage from session `updates.jsonl`. */
export interface TokenUsageSeries {
  days: TokenDayPoint[];
  totalTokens: number;
  totalTurns: number;
  windowDays: number;
}

export interface ProductUsage {
  product: string;
  usagePercent: number;
}

/** Weekly (or current billing period) usage from Grok billing API. */
export interface WeekUsage {
  usedPercent: number;
  remainingPercent: number;
  buildUsedPercent?: number | null;
  buildRemainingPercent?: number | null;
  periodType: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  productUsage: ProductUsage[];
  fetchedAt: string;
  error?: string | null;
}

export type MainTab = "live" | "timeline" | "diff" | "raw";

/** Live stream filter chip (plus `"all"`). */
export type LiveFilterKind =
  | "all"
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "shell"
  | "plan"
  | "event"
  | "unknown";

export type PolicyPreset = "research" | "code" | "balanced" | "trusted";

export type PolicySource = "default" | "project" | "inherited";

export interface PolicyConfig {
  preset: PolicyPreset;
  denyBashSubstrings: string[];
  sensitivePathSubstrings: string[];
  autoAllowWritePrefixes: string[];
  description: string;
}

export interface PolicyStore {
  defaultPreset: PolicyPreset;
  projects: Record<string, PolicyPreset>;
}

export interface ProjectBinding {
  cwd: string;
  preset: PolicyPreset;
  projectName: string;
}

export interface ResolvedPolicy {
  config: PolicyConfig;
  source: PolicySource;
  cwd?: string | null;
  boundPath?: string | null;
  defaultPreset: PolicyPreset;
  isProjectBound: boolean;
}

export interface ShellEntry {
  id: string;
  handleId: string;
  sessionId?: string | null;
  toolCallId: string;
  command: string;
  description?: string;
  status: string;
  output: string;
  exitCode?: number | null;
  ts: number;
}

export type ManagedStatus =
  | "starting"
  | "ready"
  | "running"
  | "awaitingPermission"
  | "error"
  | "stopped";

export interface ManagedAgentInfo {
  handleId: string;
  sessionId?: string | null;
  cwd: string;
  pid?: number | null;
  status: ManagedStatus;
  alwaysApprove: boolean;
  modelId?: string | null;
  lastError?: string | null;
  title?: string | null;
  createdAt: string;
  pendingPermissionCount?: number;
  policyPreset?: PolicyPreset | null;
  policySource?: PolicySource | string | null;
}

export type PermissionKind =
  | "toolPermission"
  | "fsWrite"
  | "fsRead"
  | "other";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermission {
  requestKey: string;
  handleId: string;
  sessionId?: string | null;
  requestId: unknown;
  kind: PermissionKind;
  method: string;
  title: string;
  detail: string;
  risk: string;
  options: PermissionOption[];
  rawParams: unknown;
  createdAtMs: number;
}

export interface PolicyActionEvent {
  action: "allow" | "deny" | string;
  source: string;
  pending: PendingPermission;
  ts: number;
}

export interface SpawnRequest {
  cwd: string;
  prompt?: string | null;
  alwaysApprove?: boolean | null;
  model?: string | null;
}

export interface AttachRequest {
  sessionId: string;
  cwd: string;
  alwaysApprove?: boolean | null;
}

/** Rich payload when `kind === "shell"` (from agent-shell events). */
export interface LiveShellPayload {
  toolCallId: string;
  command: string;
  description?: string;
  status: string;
  output: string;
  exitCode?: number | null;
}

export interface LiveStreamItem {
  id: string;
  handleId: string;
  sessionId?: string | null;
  kind: string;
  title: string;
  detail?: string;
  ts: number;
  /** Present when kind is `"shell"`. */
  shell?: LiveShellPayload;
}

export interface AgentUpdateEvent {
  handleId: string;
  sessionId?: string | null;
  method: string;
  params: {
    sessionId?: string;
    update?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
