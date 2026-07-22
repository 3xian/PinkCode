import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCommand,
  ManagedAgentInfo,
  SessionMode,
} from "../types";
import { SESSION_MODE_OPTIONS } from "../types";
import {
  GROK_BUILTIN_SLASH_COMMANDS,
  mergeSlashCommands,
} from "../utils/format";
import { isLocalSlashCommand } from "../utils/localSlash";
import {
  applySessionModeToPrompt,
  cycleSessionMode,
} from "../utils/sessionMode";
import { PromptChipSelect } from "./PromptChipSelect";

interface Props {
  managed: ManagedAgentInfo | null;
  busy: boolean;
  /**
   * Grok session mode (single control).
   * Shift+Tab: Normal → Plan → Auto → Always-approve (docs.x.ai).
   */
  sessionMode: SessionMode;
  onSessionModeChange: (mode: SessionMode) => void;
  onSend: (text: string) => void;
  /** Agent-advertised slash commands (ACP available_commands_update). */
  availableCommands?: AvailableCommand[];
}

export function PromptBar({
  managed,
  busy,
  sessionMode,
  onSessionModeChange,
  onSend,
  availableCommands = [],
}: Props) {
  const [text, setText] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * After insert / Esc, keep the menu closed until the user types again.
   * Prevents the "slashQuery truthy → always reopen" loop that blocked Enter-to-send.
   */
  const suppressMenuRef = useRef(false);

  const connected =
    managed && managed.status !== "stopped" && managed.status !== "error";
  const running = managed?.status === "running";
  const awaiting = managed?.status === "awaitingPermission";
  const trimmedText = text.trim();
  // /usage /context /session-info /help run in MarsBuild without ACP attach.
  const localSlash = isLocalSlashCommand(trimmedText);
  const canSend = Boolean(
    trimmedText &&
      !busy &&
      !running &&
      !awaiting &&
      (connected || localSlash),
  );

  const modeMeta =
    SESSION_MODE_OPTIONS.find((o) => o.value === sessionMode) ??
    SESSION_MODE_OPTIONS[0]!;

  /** Agent overrides builtins by name; builtins fill gaps. */
  const commandCatalog = useMemo(
    () => mergeSlashCommands(availableCommands, GROK_BUILTIN_SLASH_COMMANDS),
    [availableCommands],
  );

  const slashQuery = useMemo(() => parseSlashQuery(text), [text]);

  const filteredCommands = useMemo(() => {
    if (!slashQuery) return [] as AvailableCommand[];
    const q = slashQuery.query.toLowerCase();
    if (!q) return commandCatalog.slice(0, 40);
    return commandCatalog
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [slashQuery, commandCatalog]);

  // menuOpen is the sole open flag; suppressMenuRef only blocks re-open until
  // the user types again (cleared in onChange / when leaving slash mode).
  const showMenu =
    menuOpen &&
    Boolean(!running && !awaiting && !busy) &&
    Boolean(slashQuery) &&
    filteredCommands.length > 0;

  // Reset highlight when filter changes
  useEffect(() => {
    setMenuIndex(0);
  }, [slashQuery?.query, filteredCommands.length]);

  // Leave slash mode entirely when the leading `/…` form is gone.
  useEffect(() => {
    if (!slashQuery) {
      setMenuOpen(false);
      suppressMenuRef.current = false;
    }
  }, [slashQuery]);

  // Scroll active item into view
  useEffect(() => {
    if (!showMenu) return;
    const el = menuRef.current?.querySelector<HTMLElement>(
      `[data-cmd-idx="${menuIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [menuIndex, showMenu]);

  function applyCommand(cmd: AvailableCommand) {
    const needsInput = Boolean(cmd.inputHint);
    const next = needsInput ? `/${cmd.name} ` : `/${cmd.name}`;
    suppressMenuRef.current = true;
    setMenuOpen(false);
    setText(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = next.length;
      el.selectionStart = pos;
      el.selectionEnd = pos;
    });
  }

  function sendIfReady() {
    const trimmed = text.trim();
    if (!trimmed || running || awaiting || busy) return;
    if (!connected && !isLocalSlashCommand(trimmed)) return;
    const payload = applySessionModeToPrompt(sessionMode, trimmed);
    onSend(payload);
    setText("");
    setMenuOpen(false);
    suppressMenuRef.current = false;
  }

  /** True when composer already holds the fully-applied form of `cmd`. */
  function isCompleteCommand(cmd: AvailableCommand): boolean {
    const trimmed = text.trimEnd();
    if (cmd.inputHint) {
      // Applied form is "/name " (trailing space) or user already typed args.
      return (
        trimmed === `/${cmd.name}` ||
        trimmed.startsWith(`/${cmd.name} `) ||
        trimmed.startsWith(`/${cmd.name}\t`)
      );
    }
    return trimmed === `/${cmd.name}`;
  }

  return (
    <div className="prompt-bar">
      <div className="prompt-composer">
        {showMenu && (
          <div
            className="slash-menu"
            ref={menuRef}
            role="listbox"
            aria-label="Slash commands"
          >
            <div className="slash-menu-hint muted small">
              Grok slash commands · Tab insert · Enter send when complete · Esc
              close
            </div>
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                role="option"
                data-cmd-idx={i}
                aria-selected={i === menuIndex}
                className={`slash-menu-item${i === menuIndex ? " active" : ""}`}
                onMouseEnter={() => setMenuIndex(i)}
                onMouseDown={(e) => {
                  // Prevent textarea blur before click applies
                  e.preventDefault();
                  applyCommand(cmd);
                }}
              >
                <span className="slash-menu-name">/{cmd.name}</span>
                <span className="slash-menu-desc">{cmd.description}</span>
                {cmd.inputHint && (
                  <span className="slash-menu-hint-arg muted">
                    {cmd.inputHint}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="prompt-input"
          rows={2}
          placeholder={
            connected
              ? awaiting
                ? "Approve or deny the permission request above to continue…"
                : running
                  ? "Agent is working… you can queue another message after it finishes"
                  : sessionMode === "plan"
                    ? "Plan mode · next free-text send becomes /plan … · Shift+Tab to cycle"
                    : "Message the agent… / for commands · Enter to send · Shift+Tab mode · Ctrl+Enter newline"
              : "/usage /context /session-info work without attach · flip switch for agent prompts"
          }
          value={text}
          disabled={running || awaiting || busy}
          onChange={(e) => {
            const next = e.target.value;
            // User is typing → lift suppress; only auto-open while completing
            // the command name (no args yet). After "/cmd " keep the menu closed.
            suppressMenuRef.current = false;
            setText(next);
            const q = parseSlashQuery(next);
            if (q && !q.hasArgs) setMenuOpen(true);
            else setMenuOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;

            // Shift+Tab: Grok session mode cycle — keep focus in the composer.
            if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              if (!running && !awaiting) {
                onSessionModeChange(cycleSessionMode(sessionMode));
              }
              const el = textareaRef.current;
              requestAnimationFrame(() => {
                el?.focus({ preventScroll: true });
              });
              return;
            }

            if (showMenu) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuIndex((i) =>
                  Math.min(filteredCommands.length - 1, i + 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                suppressMenuRef.current = true;
                setMenuOpen(false);
                return;
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const cmd = filteredCommands[menuIndex];
                if (cmd) applyCommand(cmd);
                return;
              }
              if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                const cmd = filteredCommands[menuIndex];
                // Bare `/` with empty query: do not auto-pick the first command.
                if (slashQuery && !slashQuery.query) {
                  // Fall through to send ("/") or no-op if empty after trim.
                } else if (cmd && slashQuery && !slashQuery.hasArgs) {
                  if (isCompleteCommand(cmd)) {
                    // Full command already in the box → send, don't re-insert.
                    e.preventDefault();
                    suppressMenuRef.current = true;
                    setMenuOpen(false);
                    sendIfReady();
                    return;
                  }
                  // Incomplete prefix → insert selected command.
                  e.preventDefault();
                  applyCommand(cmd);
                  return;
                }
                // hasArgs: fall through to send
              }
            }

            if (e.key !== "Enter") return;

            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? text.length;
              const end = el.selectionEnd ?? text.length;
              const next = `${text.slice(0, start)}\n${text.slice(end)}`;
              suppressMenuRef.current = false;
              setText(next);
              setMenuOpen(false);
              requestAnimationFrame(() => {
                const pos = start + 1;
                el.selectionStart = pos;
                el.selectionEnd = pos;
              });
              return;
            }

            e.preventDefault();
            sendIfReady();
          }}
        />
        <div className="prompt-toolbar">
          <div className="prompt-controls">
            <PromptChipSelect
              label="Mode"
              value={sessionMode}
              displayLabel={modeMeta.label}
              title={`${modeMeta.hint} · Shift+Tab to cycle`}
              accent={modeMeta.accent}
              glyph={modeGlyph(sessionMode)}
              options={SESSION_MODE_OPTIONS}
              disabled={busy || running || awaiting}
              onChange={onSessionModeChange}
            />
          </div>
          <button
            className="btn primary prompt-send"
            type="button"
            disabled={!canSend}
            title="Enter to send · Ctrl+Enter for newline · Shift+Tab mode"
            onClick={sendIfReady}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function modeGlyph(mode: SessionMode): string {
  switch (mode) {
    case "plan":
      return "◇";
    case "auto":
      return "◎";
    case "alwaysApprove":
      return "⚡";
    default:
      return "○";
  }
}

/**
 * Detect `/command` or `/command args` at the start of the composer.
 * Closes once the user has typed past the first word and is editing free text
 * that no longer starts with `/`.
 */
function parseSlashQuery(
  text: string,
): { query: string; hasArgs: boolean } | null {
  if (!text.startsWith("/")) return null;
  // Only autocomplete on a single-line leading slash command
  if (text.includes("\n")) return null;
  const body = text.slice(1);
  const space = body.search(/\s/);
  if (space === -1) {
    return { query: body, hasArgs: false };
  }
  // After a space, treat as "has args" — Enter should send rather than insert.
  return { query: body.slice(0, space), hasArgs: true };
}
