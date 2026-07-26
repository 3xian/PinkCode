import type { PromptQueueEntry, PromptQueueState } from "../types";

export function normalizePromptQueue(
  value: unknown,
  fallbackSessionId?: string | null,
): PromptQueueState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PromptQueueState>;
  const sessionId = raw.sessionId || fallbackSessionId;
  if (!sessionId || !Array.isArray(raw.entries)) return null;
  const entries = raw.entries
    .filter(
      (entry): entry is PromptQueueEntry =>
        Boolean(
          entry &&
            typeof entry.id === "string" &&
            typeof entry.text === "string",
        ),
    )
    .map((entry, index) => ({
      ...entry,
      version: Number.isFinite(entry.version) ? entry.version : 0,
      kind: entry.kind || "prompt",
      position: Number.isFinite(entry.position) ? entry.position : index,
    }))
    .sort((a, b) => a.position - b.position);
  return { ...raw, sessionId, entries };
}

export function moveQueuedPromptIds(
  entries: PromptQueueEntry[],
  index: number,
  delta: -1 | 1,
): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) {
    return null;
  }
  const ids = entries.map((entry) => entry.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return ids;
}
