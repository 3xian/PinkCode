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
 * Questions already normalized by the host; tolerate a thin fallback for
 * older payloads that only nest under `source`.
 */
export function questionsOf(item: PendingPermission): AgentQuestion[] {
  const raw = item.rawParams as {
    questions?: unknown;
    source?: { questions?: unknown };
  } | null;
  const list = Array.isArray(raw?.questions)
    ? raw!.questions
    : Array.isArray(raw?.source?.questions)
      ? raw!.source!.questions
      : [];

  return list.map((q) => {
    const obj = (q ?? {}) as Record<string, unknown>;
    const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: AgentQuestionOption[] = optionsRaw
      .map((o) => {
        if (typeof o === "string") {
          return { label: o, description: "", preview: null };
        }
        const opt = (o ?? {}) as Record<string, unknown>;
        return {
          label: String(opt.label ?? opt.name ?? opt.value ?? ""),
          description: String(opt.description ?? opt.desc ?? ""),
          preview:
            typeof opt.preview === "string"
              ? opt.preview
              : opt.preview == null
                ? null
                : String(opt.preview),
        };
      })
      .filter((o) => o.label.trim().length > 0);

    return {
      header: String(obj.header ?? obj.title ?? ""),
      question: String(obj.question ?? obj.text ?? obj.prompt ?? ""),
      multiSelect: Boolean(obj.multiSelect ?? obj.multi_select),
      options,
    };
  });
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
