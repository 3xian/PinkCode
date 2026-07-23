//! Grok Build ask-user bridge (`x.ai/ask_user_question`).
//!
//! When the agent calls the `ask_user_question` tool, Grok reverse-RPCs the ACP
//! host with `x.ai/ask_user_question` so the client can render a multi-choice
//! form (same role as the TUI question view). Rejecting the method with -32601
//! makes the tool fail / fall back to fire-and-forget without answers.
//!
//! Wire shape (from Grok 0.2.x strings / type metadata):
//! - Request (`AskUserQuestionExtRequest`, 4 fields): `sessionId`, `questions`
//!   (array of `{ question, options[{label,description,preview?}], multiSelect? }`),
//!   plus optional annotations / extras (stored in `raw_params`).
//! - JSON-RPC **result** is an internally tagged enum
//!   (`AskUserQuestionExtResponse`) with **tag field `outcome`** (not `type`):
//!   - `{ "outcome": "accepted", "answers": { "<question>": "label"|["a","b"] }, "partial_answers": bool }`
//!   - `{ "outcome": "skip_interview" }`
//!   - `{ "outcome": "chat_about_this" }`
//! - Shape history (Grok parse errors):
//!   - `{ "type": "accepted", … }` → `missing field \`outcome\``
//!   - `{ "outcome": { "type": … } }` → `map, expected variant identifier`
//!   - `{ "outcome": "accepted", "answers": [["label"]] }` → `sequence, expected a map`
//! - `answers` is a **map** keyed by question text (duplicates rejected by Grok).
//!   Values are untagged `StringOrVec` (single string or string array).

use crate::agent_runtime::{now_ms, truncate_text};
use crate::agent_types::{PendingPermission, PermissionKind, PermissionOption};
use crate::json_util::str_field;
use serde_json::{json, Value};

pub const OPT_ACCEPT: &str = "accepted";
pub const OPT_SKIP_INTERVIEW: &str = "skip_interview";
pub const OPT_CHAT_ABOUT_THIS: &str = "chat_about_this";

/// Build a pending user-question request from the reverse-RPC params.
pub fn build_user_question(
    handle_id: &str,
    session_id: Option<String>,
    request_id: Value,
    params: &Value,
) -> PendingPermission {
    let session = session_id
        .or_else(|| str_field(params, &["sessionId", "session_id"]))
        .unwrap_or_default();

    let questions = normalize_questions(params);
    let count = questions.as_array().map(|a| a.len()).unwrap_or(0);
    let first_q = questions
        .as_array()
        .and_then(|a| a.first())
        .and_then(|q| q.get("question"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let title = if count <= 1 {
        "Agent question".to_string()
    } else {
        format!("Agent questions ({count})")
    };

    let detail = if first_q.is_empty() {
        format!("{count} question(s)")
    } else if count <= 1 {
        truncate_text(first_q, 200)
    } else {
        format!("{} (+{} more)", truncate_text(first_q, 120), count - 1)
    };

    PendingPermission {
        request_key: format!(
            "{handle_id}:ask:{}",
            crate::permission_policy::request_id_key(&request_id)
        ),
        handle_id: handle_id.to_string(),
        session_id: if session.is_empty() {
            None
        } else {
            Some(session)
        },
        request_id,
        kind: PermissionKind::UserQuestion,
        method: "x.ai/ask_user_question".into(),
        title,
        detail,
        risk: "low".into(),
        options: user_question_options(),
        raw_params: json!({
            "sessionId": params.get("sessionId").cloned()
                .or_else(|| params.get("session_id").cloned())
                .unwrap_or(Value::Null),
            "questions": questions,
            "annotations": params.get("annotations").cloned()
                .or_else(|| params.get("annotation").cloned())
                .unwrap_or(Value::Null),
            "source": params,
        }),
        created_at_ms: now_ms(),
    }
}

fn user_question_options() -> Vec<PermissionOption> {
    vec![
        PermissionOption {
            option_id: OPT_ACCEPT.into(),
            name: "Submit".into(),
            kind: "allow_once".into(),
        },
        PermissionOption {
            option_id: OPT_SKIP_INTERVIEW.into(),
            name: "Skip interview".into(),
            kind: "reject_once".into(),
        },
        PermissionOption {
            option_id: OPT_CHAT_ABOUT_THIS.into(),
            name: "Chat about this".into(),
            kind: "reject_once".into(),
        },
    ]
}

/// Normalize questions array from camelCase / snake_case tool params.
pub fn normalize_questions(params: &Value) -> Value {
    let raw = params
        .get("questions")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    let Some(arr) = raw.as_array() else {
        return Value::Array(vec![]);
    };

    let out: Vec<Value> = arr
        .iter()
        .map(|q| {
            let question = str_field(q, &["question", "text", "prompt"]).unwrap_or_default();
            let header = str_field(q, &["header", "title"]).unwrap_or_default();
            let multi = q
                .get("multiSelect")
                .or_else(|| q.get("multi_select"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let options = normalize_options(q);
            json!({
                "header": header,
                "question": question,
                "multiSelect": multi,
                "options": options,
            })
        })
        .filter(|q| {
            !q.get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
                || q.get("options")
                    .and_then(|v| v.as_array())
                    .is_some_and(|a| !a.is_empty())
        })
        .collect();

    Value::Array(out)
}

fn normalize_options(question: &Value) -> Value {
    let raw = question
        .get("options")
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    let Some(arr) = raw.as_array() else {
        return Value::Array(vec![]);
    };
    let out: Vec<Value> = arr
        .iter()
        .map(|o| {
            // Allow bare strings as labels.
            if let Some(s) = o.as_str() {
                return json!({
                    "label": s,
                    "description": "",
                    "preview": Value::Null,
                });
            }
            let label = str_field(o, &["label", "name", "value"]).unwrap_or_default();
            let description = str_field(o, &["description", "desc", "detail"]).unwrap_or_default();
            let preview = o.get("preview").cloned().unwrap_or(Value::Null);
            json!({
                "label": label,
                "description": description,
                "preview": preview,
            })
        })
        .filter(|o| {
            !o.get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .is_empty()
        })
        .collect();
    Value::Array(out)
}

/// Map UI choice + optional answers payload to the ACP ExtResponse result.
///
/// `payload` for accept:
/// - preferred: `{ "answers": { "<question text>": "label" | ["a","b"] }, "partial_answers": bool }`
/// - legacy array (converted when `questions` present): `{ "answers": [["label"], …], "questions": […] }`
///
/// Wire (serde `#[serde(tag = "outcome")]`):
/// `{ "outcome": "accepted", "answers": { … }, "partial_answers": false }`.
pub fn resolve_user_question_response(
    option_id: &str,
    payload: Option<&Value>,
) -> Result<Value, String> {
    match option_id {
        id if is_user_question_accept_option(id) => {
            let partial = payload
                .and_then(|p| p.get("partial_answers").or_else(|| p.get("partialAnswers")))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let answers = payload
                .and_then(|p| p.get("answers"))
                .cloned()
                .unwrap_or(json!({}));
            let questions = payload.and_then(|p| p.get("questions"));
            let normalized = normalize_answers_map(&answers, questions)?;
            Ok(json!({
                "outcome": "accepted",
                "answers": normalized,
                "partial_answers": partial,
            }))
        }
        OPT_SKIP_INTERVIEW | "skip" | "skipInterview" => Ok(json!({
            "outcome": "skip_interview",
        })),
        OPT_CHAT_ABOUT_THIS | "chat" | "chatAboutThis" => Ok(json!({
            "outcome": "chat_about_this",
        })),
        other => Err(format!("Unknown ask-user option: {other}")),
    }
}

/// Whether this option id means the user submitted answers (vs skip/chat).
pub fn is_user_question_accept_option(option_id: &str) -> bool {
    matches!(
        option_id,
        OPT_ACCEPT | "accept" | "submit" | "allow-once" | "allow_once" | "allow"
    )
}

/// Grok expects `answers: Map<question_text, StringOrVec>`.
fn normalize_answers_map(answers: &Value, questions: Option<&Value>) -> Result<Value, String> {
    if let Some(obj) = answers.as_object() {
        let mut out = serde_json::Map::new();
        for (key, val) in obj {
            let k = key.trim();
            if k.is_empty() {
                continue;
            }
            if let Some(v) = normalize_answer_value(val) {
                out.insert(k.to_string(), v);
            }
        }
        return Ok(Value::Object(out));
    }

    // Legacy: parallel array of per-question selections.
    let Some(arr) = answers.as_array() else {
        return Err("answers must be a map of question → answer".into());
    };
    let q_texts: Vec<String> = questions
        .and_then(|q| q.as_array())
        .map(|list| {
            list.iter()
                .map(|q| {
                    str_field(q, &["question", "text", "prompt", "header"]).unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default();

    let mut out = serde_json::Map::new();
    for (i, entry) in arr.iter().enumerate() {
        let labels = labels_from_answer_entry(entry);
        if labels.is_empty() {
            continue;
        }
        let key = q_texts
            .get(i)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("question_{}", i + 1));
        out.insert(key, string_or_vec(&labels));
    }
    Ok(Value::Object(out))
}

/// Untagged StringOrVec: one string, or a non-empty string array.
fn normalize_answer_value(val: &Value) -> Option<Value> {
    let labels = labels_from_answer_entry(val);
    if labels.is_empty() {
        return None;
    }
    Some(string_or_vec(&labels))
}

fn string_or_vec(labels: &[String]) -> Value {
    if labels.len() == 1 {
        Value::String(labels[0].clone())
    } else {
        Value::Array(labels.iter().cloned().map(Value::String).collect())
    }
}

fn labels_from_answer_entry(entry: &Value) -> Vec<String> {
    if let Some(arr) = entry.as_array() {
        return arr
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
    }
    if let Some(s) = entry.as_str() {
        let t = s.trim();
        return if t.is_empty() {
            vec![]
        } else {
            vec![t.to_string()]
        };
    }
    // Object form: { selected: [...], other?: "..." }
    if let Some(obj) = entry.as_object() {
        let mut labels: Vec<String> = Vec::new();
        if let Some(sel) = obj
            .get("selected")
            .or_else(|| obj.get("selectedOptions"))
            .or_else(|| obj.get("selected_options"))
        {
            if let Some(arr) = sel.as_array() {
                for v in arr {
                    if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        labels.push(s.to_string());
                    }
                }
            } else if let Some(s) = sel.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                labels.push(s.to_string());
            }
        }
        if let Some(s) = obj
            .get("other")
            .or_else(|| obj.get("userNotes"))
            .or_else(|| obj.get("user_notes"))
            .or_else(|| obj.get("notes"))
            .or_else(|| obj.get("answer"))
            .and_then(|v| v.as_str())
        {
            let t = s.trim();
            if !t.is_empty() && !labels.iter().any(|l| l == t) {
                labels.push(t.to_string());
            }
        }
        return labels;
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_pending_from_tool_shape() {
        let pending = build_user_question(
            "h1",
            Some("sess".into()),
            json!(7),
            &json!({
                "sessionId": "sess",
                "questions": [{
                    "question": "Which store?",
                    "multiSelect": false,
                    "options": [
                        { "label": "Postgres", "description": "SQL" },
                        { "label": "Redis", "description": "Cache", "preview": "fast" }
                    ]
                }]
            }),
        );
        assert_eq!(pending.kind, PermissionKind::UserQuestion);
        assert_eq!(pending.method, "x.ai/ask_user_question");
        assert!(pending.detail.contains("Which store"));
        let qs = pending
            .raw_params
            .get("questions")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(qs[0]["options"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn accept_response_uses_answers_map() {
        let ok = resolve_user_question_response(
            OPT_ACCEPT,
            Some(&json!({
                "answers": {
                    "Which store?": "Postgres",
                    "Pick two": ["A", "B"],
                },
                "partial_answers": true,
            })),
        )
        .unwrap();
        assert_eq!(ok["outcome"], "accepted");
        assert_eq!(ok["partial_answers"], true);
        let answers = ok["answers"].as_object().unwrap();
        assert_eq!(answers["Which store?"], json!("Postgres"));
        assert_eq!(answers["Pick two"], json!(["A", "B"]));
    }

    #[test]
    fn accept_converts_legacy_array_with_questions() {
        let ok = resolve_user_question_response(
            OPT_ACCEPT,
            Some(&json!({
                "answers": [["Postgres"], { "selected": ["A"], "other": "notes" }],
                "questions": [
                    { "question": "Which store?" },
                    { "question": "Extras?" }
                ],
                "partial_answers": false,
            })),
        )
        .unwrap();
        assert_eq!(ok["answers"]["Which store?"], json!("Postgres"));
        assert_eq!(ok["answers"]["Extras?"], json!(["A", "notes"]));
    }

    #[test]
    fn unit_variants() {
        let skip = resolve_user_question_response(OPT_SKIP_INTERVIEW, None).unwrap();
        assert_eq!(skip, json!({ "outcome": "skip_interview" }));
        let chat = resolve_user_question_response(OPT_CHAT_ABOUT_THIS, None).unwrap();
        assert_eq!(chat, json!({ "outcome": "chat_about_this" }));
    }
}
