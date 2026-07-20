export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Split on `/` or `\` so Windows and Unix paths display correctly. */
function pathParts(path: string): string[] {
  return path.split(/[/\\]+/).filter(Boolean);
}

export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = pathParts(path);
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`;
  return `…/${parts.slice(-2).join("/")}`;
}

export function projectName(cwd: string): string {
  const parts = pathParts(cwd.replace(/[/\\]+$/, ""));
  return parts[parts.length - 1] || cwd;
}

export function contextPct(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 1000) / 10);
}

/** Parse ISO / unix-seconds / unix-ms into epoch ms, or null. */
function parseDeadlineMs(isoOrUnix?: string | null): number | null {
  if (!isoOrUnix) return null;
  let t = Date.parse(isoOrUnix);
  if (Number.isNaN(t)) {
    const n = Number(isoOrUnix);
    if (!Number.isFinite(n)) return null;
    t = n < 1e12 ? n * 1000 : n;
  }
  return t;
}

/** Human remaining time until ISO timestamp (or unix-seconds string). */
export function formatTimeUntil(isoOrUnix?: string | null): string {
  const t = parseDeadlineMs(isoOrUnix);
  if (t == null) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "resetting…";
  const sec = Math.floor(diff / 1000);
  const day = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (day > 0) return `${day}d ${hr}h`;
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
}

/**
 * Compact countdown for the usage header:
 * ≥1 day → "Nd"; &lt;1 day → "Nh"; &lt;1 hour → "Nm".
 */
export function formatResetCountdown(isoOrUnix?: string | null): string {
  const t = parseDeadlineMs(isoOrUnix);
  if (t == null) return "—";
  const diff = t - Date.now();
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  const day = Math.floor(sec / 86400);
  if (day >= 1) return `${day}d`;
  const hr = Math.floor(sec / 3600);
  if (hr >= 1) return `${hr}h`;
  const min = Math.max(1, Math.floor(sec / 60));
  return `${min}m`;
}

/** Stream kinds that arrive as many tiny chunks and should be coalesced. */
export const COALESCE_LIVE_KINDS = new Set(["user", "agent", "thought"]);

/** Best-effort parse of ACP session/update stream for timeline display. */
export function describeUpdate(update: unknown): {
  kind: string;
  title: string;
  detail?: string;
  /** True when this is a text stream chunk (merge with previous same kind). */
  coalesce?: boolean;
  toolCallId?: string;
} {
  if (!update || typeof update !== "object") {
    return { kind: "unknown", title: String(update) };
  }
  const u = update as Record<string, unknown>;
  const method = u.method as string | undefined;
  const params = (u.params ?? u) as Record<string, unknown>;
  // Accept either full JSON-RPC envelope or bare update object
  const inner =
    (params.update as Record<string, unknown> | undefined) ??
    (u.update as Record<string, unknown> | undefined) ??
    (u.sessionUpdate ? u : (params as Record<string, unknown>));
  const sessionUpdate =
    (inner.sessionUpdate as string) ||
    (u.sessionUpdate as string) ||
    method ||
    "event";

  switch (sessionUpdate) {
    case "user_message_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ??
        (inner as { content?: { text?: string } }).content?.text ??
        "";
      return {
        kind: "user",
        title: "User",
        detail: text,
        coalesce: true,
      };
    }
    case "agent_message_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ?? "";
      return {
        kind: "agent",
        title: "Agent",
        detail: text,
        coalesce: true,
      };
    }
    case "agent_thought_chunk": {
      const text =
        (inner.content as { text?: string } | undefined)?.text ?? "";
      return {
        kind: "thought",
        title: "Thinking",
        detail: text,
        coalesce: true,
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId =
        (inner.toolCallId as string | undefined) ?? undefined;
      const title =
        (inner.title as string) ||
        toolCallId ||
        "Tool call";
      const status = (inner as { status?: string }).status;
      return {
        kind: "tool",
        title: status ? `${title} · ${status}` : title,
        detail: toolCallId,
        toolCallId,
      };
    }
    case "plan":
      return { kind: "plan", title: "Plan update" };
    case "available_commands_update":
      return { kind: "event", title: "available_commands_update" };
    default: {
      const type = (u.type as string) || sessionUpdate;
      // Noise phase/events — skip empty ones in the listener
      return {
        kind: "event",
        title: type,
        detail: (u.phase as string) || (u.model_id as string) || undefined,
      };
    }
  }
}
