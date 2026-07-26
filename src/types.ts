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
  recentUpdatesCursor?: number | null;
  recentUpdatesHasMore: boolean;
  hunks: HunkRecord[];
}

export interface SessionUpdatePage {
  updates: unknown[];
  nextCursor?: number | null;
  hasMore: boolean;
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

/** Center panel tabs. Timeline = ACP stream + disk hydrate. */
export type MainTab = "timeline" | "diff" | "raw";

/** Timeline filter chip (plus `"all"`). */
export type TimelineFilterKind =
  | "all"
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "shell"
  | "plan"
  | "event"
  | "unknown";

/** Slash command advertised by the agent (ACP available_commands_update). */
export interface AvailableCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface GitChange {
  status: string;
  path: string;
  kind: string;
}

export type FilePreviewKind = "text" | "image" | "binary";

/** In-app workspace file preview (from `read_project_file`). */
export interface FilePreview {
  path: string;
  /** UTF-8 text, or base64 for `kind === "image"`. */
  content: string;
  size: number;
  truncated: boolean;
  kind: FilePreviewKind;
  mimeType?: string | null;
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
  /** True when `output` is an append-only delta from the previous snapshot. */
  outputDelta?: boolean;
  exitCode?: number | null;
  ts: number;
}

export const MANAGED_STATUSES = [
  "starting",
  "ready",
  "running",
  "awaitingPermission",
  "stopping",
  "error",
  "stopped",
] as const;
export type ManagedStatus = (typeof MANAGED_STATUSES)[number];

/** Grok Build permission prompt policy (ACP host + spawn flag). */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_MODE_OPTIONS: {
  value: PermissionMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "default",
    label: "Default",
    hint: "Ask for tool runs and file writes",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    hint: "Auto-approve file edits; ask for shell / other tools",
  },
  {
    value: "auto",
    label: "Auto",
    hint: "Classifier / host auto-approves safe tools; dangerous may still prompt (grok --permission-mode auto)",
  },
  {
    value: "bypassPermissions",
    label: "Always approve",
    hint: "Skip permission prompts; deny rules still apply (grok --always-approve)",
  },
  {
    value: "dontAsk",
    label: "Don't ask",
    hint: "Deny anything that would have prompted",
  },
];

/**
 * Grok Build session modes — single TUI control (Shift+Tab cycle).
 * Normal → Plan → Auto → Always-approve. Plan is orthogonal to permission.
 */
export const SESSION_MODES = [
  "normal",
  "plan",
  "auto",
  "alwaysApprove",
] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_MODE_OPTIONS: {
  value: SessionMode;
  label: string;
  hint: string;
  accent: "neutral" | "plan" | "auto" | "yolo";
}[] = [
  {
    value: "normal",
    label: "Normal",
    hint: "Ask before tools (Grok default / ask)",
    accent: "neutral",
  },
  {
    value: "plan",
    label: "Plan",
    hint: "Plan first · next free-text send becomes /plan",
    accent: "plan",
  },
  {
    value: "auto",
    label: "Auto",
    hint: "Auto-approve safe tools; dangerous ones may still prompt",
    accent: "auto",
  },
  {
    value: "alwaysApprove",
    label: "Always approve",
    hint: "Skip tool approval prompts; deny rules still apply",
    accent: "yolo",
  },
];

export interface ManagedAgentInfo {
  handleId: string;
  sessionId?: string | null;
  cwd: string;
  pid?: number | null;
  status: ManagedStatus;
  permissionMode: PermissionMode;
  /** Mirror of permissionMode === "bypassPermissions". */
  alwaysApprove: boolean;
  modelId?: string | null;
  lastError?: string | null;
  title?: string | null;
  createdAt: string;
  pendingPermissionCount?: number;
}

export const PERMISSION_KINDS = [
  "toolPermission",
  "fsWrite",
  "fsRead",
  "planApproval",
  "userQuestion",
  "other",
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];

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

export interface SpawnRequest {
  cwd: string;
  prompt?: string | null;
  permissionMode?: PermissionMode | null;
  /** Legacy; prefer permissionMode. */
  alwaysApprove?: boolean | null;
  model?: string | null;
  /**
   * ACP session mode after `session/new` (e.g. `"plan"`).
   * Independent of host permission mode — required for real plan mode.
   */
  sessionModeId?: string | null;
}

export interface AttachRequest {
  sessionId: string;
  cwd: string;
  permissionMode?: PermissionMode | null;
  /** Legacy; prefer permissionMode. */
  alwaysApprove?: boolean | null;
}

/** Rich payload when `kind === "shell"` (from agent-shell events). */
export interface TimelineShellPayload {
  toolCallId: string;
  command: string;
  description?: string;
  status: string;
  output: string;
  exitCode?: number | null;
}

export interface TimelineItem {
  id: string;
  handleId: string;
  sessionId?: string | null;
  kind: string;
  title: string;
  detail?: string;
  ts: number;
  /** Stable Grok update identity shared by disk and ACP mirrors. */
  sourceEventId?: string;
  /**
   * True while agent/user/thought text is still coalescing.
   * UI renders plain text while streaming to avoid full Markdown re-parse each chunk.
   */
  streaming?: boolean;
  /** ACP toolCallId for tool cards (merge key; not shown as title). */
  toolCallId?: string;
  /** Tool card base line without status (merge preserves this across updates). */
  toolBase?: string;
  /** Tool card ACP status (pending / completed / …). */
  toolStatus?: string;
  /** Present when kind is `"shell"`. */
  shell?: TimelineShellPayload;
}

export interface AgentUpdateEvent {
  handleId: string;
  sessionId?: string | null;
  method: string;
  eventId?: string | null;
  params: {
    sessionId?: string;
    update?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface PromptQueueEntry {
  id: string;
  version: number;
  owner?: string | null;
  lastEditor?: string | null;
  kind: string;
  text: string;
  combinedTexts?: string[] | null;
  position: number;
}

export interface PromptQueueState {
  sessionId: string;
  entries: PromptQueueEntry[];
  runningPromptId?: string | null;
  runningText?: string | null;
  runningKind?: string | null;
  runningCombinedTexts?: string[] | null;
}
