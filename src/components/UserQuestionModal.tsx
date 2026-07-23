import { useEffect, useMemo, useReducer, useState } from "react";
import type { PendingPermission } from "../types";
import {
  questionsOf,
  type ResolvePermissionFn,
} from "../utils/permissionPayload";
import { useDraggableDialog } from "../hooks/useDraggableDialog";

interface QuestionState {
  selected: string[];
  otherOn: boolean;
  otherText: string;
}

type Action =
  | { type: "toggle-option"; qi: number; label: string; multi: boolean }
  | { type: "toggle-other"; qi: number; multi: boolean }
  | { type: "set-other-text"; qi: number; text: string }
  | { type: "reset"; count: number };

function makeState(): QuestionState {
  return { selected: [], otherOn: false, otherText: "" };
}

function reducer(states: QuestionState[], action: Action): QuestionState[] {
  switch (action.type) {
    case "toggle-option": {
      const { qi, label, multi } = action;
      return states.map((s, i) => {
        if (i !== qi) return s;
        if (multi) {
          const has = s.selected.includes(label);
          return {
            ...s,
            selected: has
              ? s.selected.filter((x) => x !== label)
              : [...s.selected, label],
          };
        }
        return { ...s, selected: [label], otherOn: false };
      });
    }
    case "toggle-other": {
      const { qi, multi } = action;
      return states.map((s, i) => {
        if (i !== qi) return s;
        if (multi) return { ...s, otherOn: !s.otherOn };
        return { ...s, otherOn: true, selected: [] };
      });
    }
    case "set-other-text": {
      const { qi, text } = action;
      return states.map((s, i) =>
        i === qi ? { ...s, otherOn: true, otherText: text } : s,
      );
    }
    case "reset":
      return Array.from({ length: action.count }, () => makeState());
  }
}

interface Props {
  item: PendingPermission;
  busy: boolean;
  onResolve: ResolvePermissionFn;
}

/** Multi-choice ask-user form (`x.ai/ask_user_question`). */
export function UserQuestionModal({ item, busy, onResolve }: Props) {
  const questions = useMemo(() => questionsOf(item), [item]);
  const [states, dispatch] = useReducer(
    reducer,
    questions.length,
    (n: number) => Array.from({ length: n }, () => makeState()),
  );

  useEffect(() => {
    dispatch({ type: "reset", count: questions.length });
  }, [item.requestKey, questions.length]);

  const {
    dialogRef,
    pos,
    dialogStyle,
    onDragPointerDown,
    onDragPointerMove,
    onDragPointerUp,
  } = useDraggableDialog();

  const [focusPreview, setFocusPreview] = useState<string | null>(null);

  function labelsFor(qi: number): string[] {
    const s = states[qi] ?? makeState();
    const out = [...s.selected];
    if (s.otherOn) {
      const t = s.otherText.trim();
      if (t) out.push(t);
    }
    return out;
  }

  function answeredCount(): number {
    return questions.reduce(
      (n, _, qi) => n + (labelsFor(qi).length > 0 ? 1 : 0),
      0,
    );
  }

  function submit() {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const labels = labelsFor(qi);
      if (labels.length === 0) return;
      const key = (q.question || q.header || `question_${qi + 1}`).trim();
      if (!key) return;
      answers[key] =
        q.multiSelect || labels.length > 1 ? labels : labels[0];
    });
    const answered = Object.keys(answers).length;
    onResolve(item, "accepted", undefined, {
      answers,
      partial_answers: answered > 0 && answered < questions.length,
    });
  }

  return (
    <div className="drag-dialog-overlay" role="presentation">
      <div
        ref={dialogRef}
        className={`drag-dialog user-question-dialog${
          pos ? " is-positioned" : ""
        }`}
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`user-question-title-${item.requestKey}`}
      >
        <div
          className="drag-dialog-handle user-question-drag-handle"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <div className="drag-dialog-header">
            <span className="plan-approval-grip" aria-hidden title="Drag">
              ⋮⋮
            </span>
            <span className="user-question-mark">?</span>
            <strong id={`user-question-title-${item.requestKey}`}>
              Agent question
              {questions.length > 1 ? `s (${questions.length})` : ""}
            </strong>
            <span className="muted">Choose options · Other for free text</span>
          </div>
        </div>

        <div className="drag-dialog-body user-question-body">
          {questions.length === 0 ? (
            <p className="muted plan-approval-empty">
              The agent asked a question but sent no options. Use Chat about
              this, or Skip.
            </p>
          ) : (
            questions.map((q, qi) => {
              const st = states[qi] ?? makeState();
              return (
                <fieldset key={qi} className="user-question-block">
                  {q.header ? (
                    <legend className="user-question-header">{q.header}</legend>
                  ) : null}
                  <div className="user-question-text">{q.question}</div>
                  {q.multiSelect && (
                    <div className="user-question-hint muted">
                      Multi-select · pick one or more
                    </div>
                  )}
                  <div
                    className="user-question-options"
                    role={q.multiSelect ? "group" : "radiogroup"}
                    aria-label={q.question}
                  >
                    {q.options.map((opt) => {
                      const active = st.selected.includes(opt.label);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          className={`user-question-option${
                            active ? " selected" : ""
                          }`}
                          disabled={busy}
                          aria-pressed={active}
                          onMouseEnter={() =>
                            setFocusPreview(opt.preview ?? null)
                          }
                          onFocus={() => setFocusPreview(opt.preview ?? null)}
                          onClick={() =>
                            dispatch({
                              type: "toggle-option",
                              qi,
                              label: opt.label,
                              multi: q.multiSelect,
                            })
                          }
                        >
                          <span
                            className="user-question-option-mark"
                            aria-hidden
                          >
                            {q.multiSelect
                              ? active
                                ? "☑"
                                : "☐"
                              : active
                                ? "●"
                                : "○"}
                          </span>
                          <span className="user-question-option-body">
                            <span className="user-question-option-label">
                              {opt.label}
                            </span>
                            {opt.description ? (
                              <span className="user-question-option-desc">
                                {opt.description}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                    <div
                      className={`user-question-option user-question-other${
                        st.otherOn ? " selected" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="user-question-other-toggle"
                        disabled={busy}
                        aria-pressed={st.otherOn}
                        onClick={() =>
                          dispatch({
                            type: "toggle-other",
                            qi,
                            multi: q.multiSelect,
                          })
                        }
                      >
                        <span
                          className="user-question-option-mark"
                          aria-hidden
                        >
                          {q.multiSelect
                            ? st.otherOn
                              ? "☑"
                              : "☐"
                            : st.otherOn
                              ? "●"
                              : "○"}
                        </span>
                        <span className="user-question-option-label">Other</span>
                      </button>
                      {(st.otherOn || !q.multiSelect) && (
                        <input
                          type="text"
                          className="user-question-other-input"
                          disabled={busy}
                          placeholder="Type your answer here"
                          value={st.otherText}
                          onFocus={() => {
                            if (!q.multiSelect) {
                              dispatch({
                                type: "toggle-other",
                                qi,
                                multi: false,
                              });
                            } else if (!st.otherOn) {
                              dispatch({
                                type: "toggle-other",
                                qi,
                                multi: true,
                              });
                            }
                          }}
                          onChange={(e) =>
                            dispatch({
                              type: "set-other-text",
                              qi,
                              text: e.target.value,
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                </fieldset>
              );
            })
          )}
          {focusPreview ? (
            <div className="user-question-preview">
              <div className="user-question-preview-label muted">Preview</div>
              <pre>{focusPreview}</pre>
            </div>
          ) : null}
        </div>

        <div className="drag-dialog-footer">
          <div className="user-question-progress muted">
            {questions.length > 0
              ? `${answeredCount()} / ${questions.length} answered`
              : null}
          </div>
          <div className="perm-actions drag-dialog-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || answeredCount() === 0}
              onClick={submit}
              title="Submit selected answers"
            >
              {busy ? "…" : "Submit"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onResolve(item, "chat_about_this")}
              title="Close the form and continue in free chat"
            >
              Chat about this
            </button>
            <button
              type="button"
              className="btn danger-btn"
              disabled={busy}
              onClick={() => onResolve(item, "skip_interview")}
              title="Skip remaining clarifying questions (plan interview)"
            >
              Skip interview
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
