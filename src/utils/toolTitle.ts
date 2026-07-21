/** Local path trim — keep this module free of imports from format.ts (cycle). */
function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split(/[/\\]+/).filter(Boolean);
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`;
  return `…/${parts.slice(-2).join("/")}`;
}

/** ACP / Grok toolCallId shape: `call-<uuid>-N`. Never show as a card title. */
export function isToolCallId(s: string): boolean {
  return /^call-[\w-]+$/i.test(s.trim());
}

/** Structured tool card fields (avoid encoding status into a display string). */
export interface ToolCardParts {
  /** Human base line, e.g. `Read \`path\``. Never a call- id. */
  baseTitle: string;
  /** ACP status when present (pending / completed / …). */
  status?: string;
  /** Optional secondary line (path etc.). */
  detail?: string;
  /** Display title: base + status suffix (completed → ☑️). */
  title: string;
}

/** Map ACP status to a short title suffix. */
export function formatToolStatusSuffix(status?: string): string {
  const st = status?.trim();
  if (!st) return "";
  if (st.toLowerCase() === "completed") return "☑️";
  return `· ${st}`;
}

export function composeToolTitle(baseTitle: string, status?: string): string {
  const base = baseTitle.trim() || "Tool call";
  const suffix = formatToolStatusSuffix(status);
  return suffix ? `${base} ${suffix}` : base;
}

/**
 * Merge successive tool_call / tool_call_update parts.
 * Prefer a newer non-placeholder base; keep latest status.
 */
export function mergeToolCardParts(
  prev: ToolCardParts,
  next: ToolCardParts,
): ToolCardParts {
  const nextBase = next.baseTitle.trim();
  const prevBase = prev.baseTitle.trim();
  const baseTitle =
    nextBase && nextBase !== "Tool call"
      ? nextBase
      : prevBase || nextBase || "Tool call";
  const status = next.status?.trim() || prev.status?.trim() || undefined;
  const detail = next.detail ?? prev.detail;
  return {
    baseTitle,
    status,
    detail,
    title: composeToolTitle(baseTitle, status),
  };
}

function truncateDisplay(s: string, max = 96): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** Grok emits `_meta["x.ai/tool"]`; older shapes nest under `_meta["x.ai"].tool`. */
export function extractToolMeta(
  inner: Record<string, unknown>,
): Record<string, unknown> {
  const meta = inner._meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") return {};
  const slash = meta["x.ai/tool"];
  if (slash && typeof slash === "object") {
    return slash as Record<string, unknown>;
  }
  const xai = meta["x.ai"] as Record<string, unknown> | undefined;
  const nested = xai?.tool;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return {};
}

function firstLocationPath(locations: unknown): string {
  if (!Array.isArray(locations)) return "";
  for (const loc of locations) {
    if (!loc || typeof loc !== "object") continue;
    const path = (loc as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return "";
}

/**
 * Best-effort target string for tool cards (path, command, pattern, …).
 * Prefer short, scannable values over full prompts.
 */
export function toolPrimaryTarget(inner: Record<string, unknown>): string {
  const rawInput = inner.rawInput as Record<string, unknown> | undefined;
  const meta = extractToolMeta(inner);
  const metaInput =
    meta.input && typeof meta.input === "object"
      ? (meta.input as Record<string, unknown>)
      : undefined;

  const fromObj = (obj?: Record<string, unknown>): string => {
    if (!obj) return "";
    for (const key of [
      "target_file",
      "file_path",
      "path",
      "command",
      "cmd",
      "pattern",
      "query",
      "url",
      "description",
    ]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    if (typeof obj.prompt === "string" && obj.prompt.trim()) {
      return obj.prompt.trim();
    }
    return "";
  };

  return (
    firstLocationPath(inner.locations) ||
    fromObj(rawInput) ||
    fromObj(metaInput) ||
    ""
  );
}

function isSnakeToolName(s: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s.trim());
}

/**
 * Human-facing tool card parts from an ACP tool_call / tool_call_update.
 * Never uses the raw `call-…` id as the title.
 */
export function formatToolCardParts(
  inner: Record<string, unknown>,
): ToolCardParts {
  const rawTitle = String(inner.title ?? "").trim();
  const statusRaw = inner.status;
  const status =
    statusRaw != null && String(statusRaw).trim()
      ? String(statusRaw).trim()
      : undefined;
  const meta = extractToolMeta(inner);
  const label =
    typeof meta.label === "string" && meta.label.trim()
      ? meta.label.trim()
      : "";
  const name =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : "";
  const target = toolPrimaryTarget(inner);
  const targetShort = target
    ? target.length > 64 || /[/\\]/.test(target)
      ? shortPath(target, 48)
      : truncateDisplay(target, 48)
    : "";

  let baseTitle = "";
  if (rawTitle && !isToolCallId(rawTitle)) {
    if (isSnakeToolName(rawTitle) && targetShort) {
      baseTitle = label
        ? `${label} \`${targetShort}\``
        : `${rawTitle} · ${targetShort}`;
    } else if (isSnakeToolName(rawTitle) && label && rawTitle === name) {
      baseTitle = label;
    } else {
      baseTitle = truncateDisplay(rawTitle, 96);
    }
  } else if (label && targetShort) {
    baseTitle = `${label} \`${targetShort}\``;
  } else if (label) {
    baseTitle = label;
  } else if (name && targetShort) {
    baseTitle = `${name} · ${targetShort}`;
  } else if (name) {
    baseTitle = name;
  } else if (targetShort) {
    baseTitle = targetShort;
  } else {
    baseTitle = "Tool call";
  }

  const title = composeToolTitle(baseTitle, status);
  const detail =
    targetShort && !title.includes(targetShort) ? targetShort : undefined;
  return { baseTitle, status, detail, title };
}
