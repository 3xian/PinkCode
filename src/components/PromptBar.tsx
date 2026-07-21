import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand, ManagedAgentInfo, PermissionMode } from "../types";
import { PERMISSION_MODE_OPTIONS } from "../types";
import {
  GROK_BUILTIN_SLASH_COMMANDS,
  mergeSlashCommands,
} from "../utils/format";

interface Props {
  managed: ManagedAgentInfo | null;
  busy: boolean;
  /** Effective mode for the current task (persisted or live agent). */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSend: (text: string) => void;
  /** Agent-advertised slash commands (ACP available_commands_update). */
  availableCommands?: AvailableCommand[];
}

export function PromptBar({
  managed,
  busy,
  permissionMode,
  onPermissionModeChange,
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
  const canSend = Boolean(
    connected && !running && !awaiting && !busy && text.trim(),
  );

  const modeHint =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode)?.hint ?? "";

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
    Boolean(connected && !running && !awaiting && !busy) &&
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
    if (!trimmed || !connected || running || awaiting || busy) return;
    onSend(trimmed);
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
                  : "Message the agent… / for commands · Enter to send · Ctrl+Enter for newline"
              : "Flip the task card switch to attach, then send prompts"
          }
          value={text}
          disabled={!connected || running || awaiting || busy}
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
          <label className="prompt-perm" title={modeHint}>
            <span className="prompt-perm-label">Permissions</span>
            <select
              className="prompt-perm-select"
              value={permissionMode}
              disabled={busy}
              onChange={(e) =>
                onPermissionModeChange(e.target.value as PermissionMode)
              }
              aria-label="Permission mode"
            >
              {PERMISSION_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn primary prompt-send"
            type="button"
            disabled={!canSend}
            title="Enter to send · Ctrl+Enter for newline"
            onClick={sendIfReady}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
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
