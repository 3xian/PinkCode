import type { PendingPermission } from "../types";

/** Host-normalized question shape (see ask_user_question::normalize_questions). */
export interface AgentQuestionOption {
  label: string;
  description: string;
  preview?: string | null;
}

export interface AgentQuestion {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/** Wire payload for resolve_permission when kind is userQuestion. */
export interface UserQuestionResolvePayload {
  answers: Record<string, string | string[]>;
  partial_answers: boolean;
}

/**
 * Read plan markdown from pending rawParams.
 * Rust `build_plan_approval` always sets camelCase `planContent`.
 */
export function planContentOf(item: PendingPermission): string {
  const raw = item.rawParams as {
    planContent?: string;
    plan_content?: string;
  } | null;
  return raw?.planContent ?? raw?.plan_content ?? "";
}

export function planPathOf(item: PendingPermission): string {
  const raw = item.rawParams as {
    planFilePath?: string;
    plan_file_path?: string;
  } | null;
  return (
    raw?.planFilePath ??
    raw?.plan_file_path ??
    (item.detail.includes("plan.md") ? item.detail : "")
  );
}

/**
 * Questions already normalized by the Rust-side `normalize_questions`.
 */
export function questionsOf(item: PendingPermission): AgentQuestion[] {
  const raw = item.rawParams as { questions?: AgentQuestion[] } | null;
  return raw?.questions ?? [];
}

export function previewContent(item: PendingPermission): string | null {
  const raw = item.rawParams as { content?: string } | null;
  const c = raw?.content;
  if (!c) return null;
  if (c.length > 400) return c.slice(0, 400) + "\n…";
  return c;
}

/** Shared resolve signature for PermissionGate / SessionDetail / App. */
export type ResolvePermissionFn = (
  item: PendingPermission,
  optionId: string,
  comments?: string,
  payload?: UserQuestionResolvePayload,
) => void;
