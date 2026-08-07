import type { AvailableCommand } from "../types";

export const SLASH_MENU_LIMIT = 40;

/** Where a slash command is fulfilled. */
export type SlashFulfillment = "local" | "agent";

export interface SlashCommandDef {
  name: string;
  description: string;
  inputHint?: string;
  fulfillment: SlashFulfillment;
  /** Hidden from autocomplete (aliases). */
  hidden?: boolean;
}

/**
 * Canonical Grok / PinkCode slash registry.
 * Local commands run in-process; agent commands need ACP attach.
 */
export const GROK_SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: "usage",
    description: "View credit usage / billing",
    fulfillment: "local",
  },
  {
    name: "context",
    description: "Show context window usage",
    fulfillment: "local",
  },
  {
    name: "session-info",
    description: "Show session details",
    fulfillment: "local",
  },
  {
    name: "session_info",
    description: "Show session details",
    fulfillment: "local",
    hidden: true,
  },
  {
    name: "help",
    description: "List PinkCode local commands",
    fulfillment: "local",
  },
  { name: "new", description: "Start a new session", fulfillment: "agent" },
  {
    name: "compact",
    description: "Compress conversation history",
    inputHint: "optional context to keep",
    fulfillment: "agent",
  },
  {
    name: "fork",
    description: "Branch session into a new agent",
    fulfillment: "agent",
  },
  {
    name: "rewind",
    description: "Rewind to an earlier turn",
    fulfillment: "agent",
  },
  {
    name: "undo",
    description: "Rewind to an earlier turn",
    fulfillment: "agent",
    hidden: true,
  },
  {
    name: "copy",
    description: "Copy recent response",
    inputHint: "N or file path",
    fulfillment: "agent",
  },
  { name: "export", description: "Export conversation", fulfillment: "agent" },
  {
    name: "model",
    description: "Switch model",
    inputHint: "model name",
    fulfillment: "agent",
  },
  {
    name: "effort",
    description: "Set reasoning effort",
    inputHint: "low|medium|high|xhigh",
    fulfillment: "agent",
  },
  {
    name: "always-approve",
    description: "Toggle always-approve permissions",
    fulfillment: "agent",
  },
  {
    name: "auto",
    description: "Toggle auto permission mode",
    fulfillment: "agent",
  },
  {
    name: "plan",
    description: "Enter plan mode",
    inputHint: "description",
    fulfillment: "agent",
  },
  {
    name: "view-plan",
    description: "Open saved plan preview",
    fulfillment: "local",
  },
  {
    name: "show-plan",
    description: "Open saved plan preview",
    fulfillment: "local",
    hidden: true,
  },
  {
    name: "plan-view",
    description: "Open saved plan preview",
    fulfillment: "local",
    hidden: true,
  },
  {
    name: "memory",
    description: "Browse or toggle memory",
    inputHint: "on|off",
    fulfillment: "agent",
  },
  {
    name: "remember",
    description: "Save a note to memory",
    inputHint: "note",
    fulfillment: "agent",
  },
  { name: "skills", description: "Open skills modal", fulfillment: "agent" },
  { name: "hooks", description: "Open hooks modal", fulfillment: "agent" },
  { name: "plugins", description: "Open plugins modal", fulfillment: "agent" },
  {
    name: "mcps",
    description: "Open MCP servers modal",
    fulfillment: "agent",
  },
  { name: "settings", description: "Open settings", fulfillment: "agent" },
  {
    name: "login",
    description: "Log in or re-authenticate",
    fulfillment: "agent",
  },
  { name: "logout", description: "Log out", fulfillment: "agent" },
  {
    name: "imagine",
    description: "Generate an image",
    inputHint: "description",
    fulfillment: "agent",
  },
  {
    name: "loop",
    description: "Run a prompt on an interval",
    inputHint: "interval prompt",
    fulfillment: "agent",
  },
  {
    name: "goal",
    description: "Set or manage an autonomous goal",
    inputHint: "objective|status|…",
    fulfillment: "agent",
  },
  {
    name: "btw",
    description: "Aside question without interrupting",
    inputHint: "question",
    fulfillment: "agent",
  },
  {
    name: "docs",
    description: "Browse how-to guides",
    inputHint: "title or web",
    fulfillment: "agent",
  },
  {
    name: "feedback",
    description: "Send feedback",
    inputHint: "message",
    fulfillment: "agent",
  },
];

const LOCAL_NAMES = new Set(
  GROK_SLASH_COMMANDS.filter((c) => c.fulfillment === "local").map((c) =>
    c.name.toLowerCase(),
  ),
);

/** Builtins for prompt autocomplete (agent-advertised merge target). */
export const GROK_BUILTIN_SLASH_COMMANDS: AvailableCommand[] =
  GROK_SLASH_COMMANDS.filter((c) => !c.hidden).map(
    ({ name, description, inputHint }) => ({
      name,
      description,
      inputHint,
    }),
  );

export function isLocalSlashName(name: string): boolean {
  return LOCAL_NAMES.has(name.toLowerCase());
}

/** Local commands shown in `/help` (stable order, no hidden aliases). */
export function localSlashHelpLines(): string[] {
  return GROK_SLASH_COMMANDS.filter(
    (c) => c.fulfillment === "local" && !c.hidden,
  ).map((c) => {
    const pad = c.name.padEnd(14);
    return `  /${pad}— ${c.description}`;
  });
}

/**
 * Merge agent-advertised slash commands with builtins.
 * Agent entries win on name collision; builtins not advertised remain available.
 */
export function mergeSlashCommands(
  agent: AvailableCommand[],
  builtins: AvailableCommand[] = GROK_BUILTIN_SLASH_COMMANDS,
): AvailableCommand[] {
  if (!agent.length) return builtins;
  const agentNames = new Set(agent.map((c) => c.name.toLowerCase()));
  const out: AvailableCommand[] = [...agent];
  for (const b of builtins) {
    if (!agentNames.has(b.name.toLowerCase())) out.push(b);
  }
  return out;
}

/**
 * Resolve the complete prompt catalog from exactly one runtime authority.
 *
 * Once ACP has advertised commands it is authoritative; locally inspected
 * skills are only a pre-attach fallback. Builtins beat inspected skills on
 * collision because those names cannot be invoked as bare skill commands.
 */
export function resolveSlashCommandCatalog(
  agent: AvailableCommand[] | null,
  inspectedSkills: AvailableCommand[],
  builtins: AvailableCommand[] = GROK_BUILTIN_SLASH_COMMANDS,
): AvailableCommand[] {
  return agent !== null
    ? mergeSlashCommands(agent, builtins)
    : mergeSlashCommands(builtins, inspectedSkills);
}

/**
 * Filter slash commands with command-name matches ahead of description-only
 * matches. Sorting is stable within each match class.
 */
export function filterSlashCommands(
  catalog: AvailableCommand[],
  query: string,
): AvailableCommand[] {
  const q = query.trim().replace(/^\/+/, "").toLowerCase();
  if (!q) return catalog.slice(0, SLASH_MENU_LIMIT);

  return catalog
    .map((command, index) => {
      const name = command.name.toLowerCase();
      const description = command.description.toLowerCase();
      const rank = name.startsWith(q)
        ? 0
        : name.includes(q)
          ? 1
          : description.includes(q)
            ? 2
            : -1;
      return { command, index, rank };
    })
    .filter((match) => match.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, SLASH_MENU_LIMIT)
    .map((match) => match.command);
}
