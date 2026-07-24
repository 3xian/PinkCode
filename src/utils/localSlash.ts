import type { SessionDetail, WeekUsage } from "../types";
import { contextPct, formatTokens, formatTimeUntil } from "./format";
import { getSessionPlan, getWeekUsage } from "../api";
import {
  isLocalSlashName,
  localSlashHelpLines,
} from "./slashCommands";

/** Live cards produced by a PinkCode-handled slash command. */
export interface LocalSlashItem {
  kind: string;
  title: string;
  detail?: string;
}

export interface LocalSlashResult {
  items: LocalSlashItem[];
  /** Also refresh the header week-usage bar. */
  refreshWeekUsage?: boolean;
}

/**
 * True when the prompt is a leading slash command that PinkCode can answer
 * without sending it through ACP (Grok pager builtins like `/usage`).
 */
export function isLocalSlashCommand(text: string): boolean {
  const parsed = parseLeadingSlash(text);
  if (!parsed) return false;
  return isLocalSlashName(parsed.name);
}

function parseLeadingSlash(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Single-line command only (same idea as PromptBar autocomplete).
  if (trimmed.includes("\n")) return null;
  const body = trimmed.slice(1);
  const m = body.match(/^([^\s]+)(?:\s+(.*))?$/);
  if (!m) return null;
  return {
    name: m[1].toLowerCase().replace(/^\//, ""),
    args: (m[2] ?? "").trim(),
  };
}

/**
 * Run a local slash command. Returns null if the text should go to ACP instead.
 */
export async function runLocalSlash(
  text: string,
  ctx: {
    detail: SessionDetail | null;
    weekUsage: WeekUsage | null;
  },
): Promise<LocalSlashResult | null> {
  const parsed = parseLeadingSlash(text);
  if (!parsed || !isLocalSlashName(parsed.name)) return null;

  const userLine: LocalSlashItem = {
    kind: "user",
    title: "User",
    detail: text.trim(),
  };

  switch (parsed.name) {
    case "usage": {
      const usage = await getWeekUsage();
      return {
        items: [userLine, formatUsageCard(usage)],
        refreshWeekUsage: true,
      };
    }
    case "context":
      return {
        items: [userLine, formatContextCard(ctx.detail)],
      };
    case "session-info":
    case "session_info":
      return {
        items: [userLine, formatSessionInfoCard(ctx.detail)],
      };
    case "help":
      return {
        items: [userLine, formatHelpCard()],
      };
    case "view-plan":
    case "show-plan":
    case "plan-view":
      return {
        items: [userLine, await formatViewPlanCard(ctx.detail)],
      };
    default:
      return null;
  }
}

async function formatViewPlanCard(
  detail: SessionDetail | null,
): Promise<LocalSlashItem> {
  if (!detail?.card.id) {
    return {
      kind: "plan",
      title: "Plan",
      detail: "No session selected.",
    };
  }
  try {
    const plan = await getSessionPlan(detail.card.id);
    if (!plan) {
      return {
        kind: "plan",
        title: "Plan",
        detail: "No plan.md for this session yet. Use /plan … to start planning.",
      };
    }
    if (plan.empty) {
      return {
        kind: "plan",
        title: "Plan · empty",
        detail: `Path: ${plan.path}\n\n(plan.md exists but is empty)`,
      };
    }
    return {
      kind: "plan",
      title: "Plan",
      detail: `Path: ${plan.path}\n\n${plan.content}`,
    };
  } catch (e) {
    return {
      kind: "plan",
      title: "Plan",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

function formatUsageCard(usage: WeekUsage): LocalSlashItem {
  if (usage.error) {
    return {
      kind: "event",
      title: "Usage",
      detail: `Could not load billing usage:\n${usage.error}`,
    };
  }

  const used = Math.round(usage.usedPercent);
  const rem = Math.round(usage.remainingPercent);
  const lines: string[] = [
    `Period: ${prettyPeriod(usage.periodType)}`,
    `Used: ${used}% · Remaining: ${rem}%`,
  ];

  if (usage.periodEnd) {
    lines.push(`Resets in: ${formatTimeUntil(usage.periodEnd)}`);
  }
  if (usage.buildUsedPercent != null) {
    lines.push(
      `Grok Build: ${Math.round(usage.buildUsedPercent)}% used` +
        (usage.buildRemainingPercent != null
          ? ` · ${Math.round(usage.buildRemainingPercent)}% left`
          : ""),
    );
  }
  if (usage.productUsage?.length) {
    lines.push("");
    lines.push("By product:");
    for (const p of usage.productUsage) {
      lines.push(`  · ${p.product}: ${Math.round(p.usagePercent)}%`);
    }
  }
  if (usage.fetchedAt) {
    lines.push("");
    lines.push(`Fetched: ${usage.fetchedAt}`);
  }

  return {
    kind: "event",
    title: "Usage",
    detail: lines.join("\n"),
  };
}

function formatContextCard(detail: SessionDetail | null): LocalSlashItem {
  if (!detail) {
    return {
      kind: "event",
      title: "Context",
      detail: "No session selected.",
    };
  }
  const c = detail.card;
  const used = c.contextTokensUsed;
  const window = c.contextWindowTokens;
  const pct = contextPct(used, window);
  const free = window > used ? window - used : 0;
  const lines = [
    `Used: ${formatTokens(used, { decimals: false })} / ${formatTokens(window, { decimals: false })} (${Math.round(pct)}%)`,
    `Free: ${formatTokens(free, { decimals: false })}`,
    `Turns: ${c.turnCount} · Tools: ${c.toolCallCount}`,
    `Messages: ${c.numMessages}`,
  ];
  if (c.modelId) lines.push(`Model: ${c.modelId}`);
  return {
    kind: "event",
    title: "Context",
    detail: lines.join("\n"),
  };
}

function formatSessionInfoCard(detail: SessionDetail | null): LocalSlashItem {
  if (!detail) {
    return {
      kind: "event",
      title: "Session info",
      detail: "No session selected.",
    };
  }
  const c = detail.card;
  const lines = [
    `Id: ${c.id}`,
    `Title: ${c.title || "—"}`,
    `Cwd: ${c.cwd}`,
    `Model: ${c.modelId ?? "—"}`,
    `Agent: ${c.agentName ?? "—"}`,
    `Branch: ${c.headBranch ?? "—"}`,
    `Status: ${c.status}${c.isActive ? " (active)" : ""}`,
    `Context: ${formatTokens(c.contextTokensUsed, { decimals: false })} / ${formatTokens(c.contextWindowTokens, { decimals: false })}`,
    `Turns: ${c.turnCount} · Tools: ${c.toolCallCount} · Files: ${c.agentFilesTouched}`,
  ];
  if (c.lastActiveAt || c.updatedAt) {
    lines.push(`Last active: ${c.lastActiveAt ?? c.updatedAt}`);
  }
  return {
    kind: "event",
    title: "Session info",
    detail: lines.join("\n"),
  };
}

function formatHelpCard(): LocalSlashItem {
  const lines = [
    "PinkCode local commands (like Grok TUI pager builtins):",
    ...localSlashHelpLines(),
    "",
    "Agent commands (need attach): /compact /plan /model /effort …",
    "Local plan: /view-plan (aliases /show-plan, /plan-view)",
    "Type / in the prompt for autocomplete.",
  ];
  return {
    kind: "event",
    title: "Help",
    detail: lines.join("\n"),
  };
}

function prettyPeriod(periodType: string): string {
  const t = periodType.replace(/^USAGE_PERIOD_TYPE_/i, "").toLowerCase();
  if (!t || t === "unknown") return periodType || "unknown";
  return t.charAt(0).toUpperCase() + t.slice(1);
}
