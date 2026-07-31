import { useEffect, useMemo, useState } from "react";
import { listSlashSkills } from "../api";
import type { AvailableCommand } from "../types";
import { resolveSlashCommandCatalog } from "../utils/slashCommands";

const EMPTY_COMMANDS: AvailableCommand[] = [];

interface InspectedCatalog {
  cwd: string;
  commands: AvailableCommand[];
}

/**
 * Owns the prompt command catalog across the pre-attach and ACP-connected
 * phases. `null` means ACP has not advertised a catalog; an empty array is
 * still an authoritative ACP result.
 */
export function useSlashCommandCatalog(
  cwd: string | null,
  agentCommands: AvailableCommand[] | null,
): AvailableCommand[] {
  const [inspected, setInspected] = useState<InspectedCatalog | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void listSlashSkills(cwd)
      .then((commands) => {
        if (!cancelled) setInspected({ cwd, commands });
      })
      .catch(() => {
        if (!cancelled) setInspected({ cwd, commands: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const inspectedCommands =
    cwd && inspected?.cwd === cwd ? inspected.commands : EMPTY_COMMANDS;

  return useMemo(
    () => resolveSlashCommandCatalog(agentCommands, inspectedCommands),
    [agentCommands, inspectedCommands],
  );
}
