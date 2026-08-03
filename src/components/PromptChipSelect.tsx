import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

export type ChipAccent = "neutral" | "plan" | "ask" | "auto" | "yolo" | "danger";

export interface ChipOption<T extends string = string> {
  value: T;
  label: string;
  hint: string;
}

interface Props<T extends string> {
  label: string;
  value: T;
  displayLabel: string;
  tooltip: string;
  accent: ChipAccent;
  glyph: string;
  options: readonly ChipOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}

/** Compact labeled pill + dropdown used in the prompt toolbar (Mode, …). */
export function PromptChipSelect<T extends string>({
  label,
  value,
  displayLabel,
  tooltip,
  accent,
  glyph,
  options,
  disabled,
  onChange,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const tooltipId = useId();

  useEffect(() => {
    if (!open) return;
    const idx = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    setActive(idx);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function pick(v: T) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[active];
      if (opt) pick(opt.value);
    }
  }

  return (
    <div
      className={`prompt-chip accent-${accent}${open ? " open" : ""}${
        disabled ? " disabled" : ""
      }`}
      ref={rootRef}
    >
      <span id={tooltipId} className="prompt-chip-tooltip" role="tooltip">
        {tooltip}
      </span>
      <button
        type="button"
        className="prompt-chip-trigger"
        disabled={disabled}
        tabIndex={-1}
        aria-expanded={open}
        aria-controls={listId}
        aria-describedby={tooltipId}
        aria-label={`${label}: ${displayLabel}`}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="prompt-chip-glyph" aria-hidden>
          {glyph}
        </span>
        <span className="prompt-chip-value">{displayLabel}</span>
        <span className="prompt-chip-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div
          className="prompt-chip-menu"
          id={listId}
          role="listbox"
          aria-label={label}
        >
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`prompt-chip-option${
                opt.value === value ? " selected" : ""
              }${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(opt.value);
              }}
            >
              <span className="prompt-chip-option-label">{opt.label}</span>
              <span className="prompt-chip-option-hint">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
