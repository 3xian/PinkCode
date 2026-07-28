import type { RefObject } from "react";
import { historyRowPreview } from "../utils/promptHistory";

interface Props {
  entries: string[];
  selected: number;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => void;
  onAccept: (entry: string) => void;
}

/** Grok-style prompt history overlay (oldest top → newest bottom). */
export function HistoryMenu({
  entries,
  selected,
  listRef,
  onSelect,
  onAccept,
}: Props) {
  return (
    <div
      className="history-menu"
      ref={listRef}
      role="listbox"
      aria-label="Prompt history"
    >
      <div className="history-menu-header">
        <span className="history-menu-title">history</span>
        <span className="history-menu-count muted">{entries.length}</span>
      </div>
      <div className="history-menu-list">
        {entries.map((entry, i) => (
          <button
            key={`${i}-${entry.slice(0, 24)}`}
            type="button"
            role="option"
            data-hist-idx={i}
            aria-selected={i === selected}
            className={"history-menu-item" + (i === selected ? " active" : "")}
            onMouseEnter={() => onSelect(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onAccept(entry);
            }}
          >
            <span className="history-menu-arrow" aria-hidden>
              {i === selected ? "›" : ""}
            </span>
            <span className="history-menu-text">
              {historyRowPreview(entry)}
            </span>
          </button>
        ))}
      </div>
      <div className="history-menu-footer muted small">
        ↑↓ navigate · enter select · esc cancel
      </div>
    </div>
  );
}
