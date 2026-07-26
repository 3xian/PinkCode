import { useEffect, useState } from "react";
import type { PromptQueueController } from "../hooks/usePromptQueueController";
import { moveQueuedPromptIds } from "../utils/promptQueue";

interface Props {
  controller: PromptQueueController;
}

export function PromptQueue({ controller }: Props) {
  const { queue, remove, edit, reorder, clear, interject } = controller;
  const entries = queue?.entries ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (editingId && !entries.some((entry) => entry.id === editingId)) {
      setEditingId(null);
      setDraft("");
    }
  }, [editingId, entries]);

  if (!entries.length) return null;

  async function run(key: string, action: () => Promise<void>) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await action();
    } catch {
      // App owns the visible error banner; keep the row/edit state intact.
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="prompt-queue" aria-label="Queued prompts">
      <div className="prompt-queue-header">
        <span>
          Queued <strong>{entries.length}</strong>
        </span>
        <button
          type="button"
          className="queue-text-btn danger"
          disabled={Boolean(busyKey)}
          onClick={() => void run("clear", clear)}
        >
          Clear
        </button>
      </div>
      <ol className="prompt-queue-list">
        {entries.map((entry, index) => {
          const editing = editingId === entry.id;
          const busy = busyKey === entry.id;
          return (
            <li className="prompt-queue-row" key={entry.id}>
              <span className="prompt-queue-position">{index + 1}</span>
              {editing ? (
                <textarea
                  className="prompt-queue-edit"
                  rows={2}
                  value={draft}
                  autoFocus
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setEditingId(null);
                      setDraft("");
                    }
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      const text = draft.trim();
                      if (!text) return;
                      void run(entry.id, async () => {
                        await edit(entry, text);
                        setEditingId(null);
                        setDraft("");
                      });
                    }
                  }}
                />
              ) : (
                <div className="prompt-queue-text" title={entry.text}>
                  {entry.text}
                </div>
              )}
              <div className="prompt-queue-actions">
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="queue-text-btn"
                      disabled={busy || !draft.trim()}
                      onClick={() =>
                        void run(entry.id, async () => {
                          await edit(entry, draft.trim());
                          setEditingId(null);
                          setDraft("");
                        })
                      }
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="queue-text-btn"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null);
                        setDraft("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="queue-icon-btn"
                      title="Move up"
                      aria-label="Move queued prompt up"
                      disabled={Boolean(busyKey) || index === 0}
                      onClick={() => {
                        const ids = moveQueuedPromptIds(entries, index, -1);
                        if (ids) void run(entry.id, () => reorder(ids));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="queue-icon-btn"
                      title="Move down"
                      aria-label="Move queued prompt down"
                      disabled={Boolean(busyKey) || index === entries.length - 1}
                      onClick={() => {
                        const ids = moveQueuedPromptIds(entries, index, 1);
                        if (ids) void run(entry.id, () => reorder(ids));
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="queue-text-btn"
                      disabled={Boolean(busyKey)}
                      onClick={() => {
                        setEditingId(entry.id);
                        setDraft(entry.text);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="queue-text-btn accent"
                      disabled={Boolean(busyKey)}
                      title="Cancel the current turn and run this queued prompt now"
                      onClick={() => void run(entry.id, () => interject(entry))}
                    >
                      Send now
                    </button>
                    <button
                      type="button"
                      className="queue-text-btn danger"
                      disabled={Boolean(busyKey)}
                      onClick={() => void run(entry.id, () => remove(entry))}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
