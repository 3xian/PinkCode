//! Grok Build plan-approval bridge (`x.ai/exit_plan_mode`).
//!
//! When the agent finishes planning it calls the `exit_plan_mode` tool. Grok
//! intercepts that tool and reverse-RPCs the ACP client with
//! `x.ai/exit_plan_mode` so the host can show a plan preview (same role as the
//! TUI plan-approval view).
//!
//! Wire types are defined in upstream `xai-org/grok-build`:
//! `crates/codegen/xai-grok-tools/.../exit_plan_mode/types.rs`
//!
//! **Request** (`ExitPlanModeExtRequest`, camelCase):
//! ```json
//! { "sessionId": "...", "toolCallId": "...", "planContent": "# Plan..." | null }
//! ```
//!
//! **Response** (`ExitPlanModeExtResponse` — field names are **not** renamed):
//! ```json
//! { "outcome": "approved" | "cancelled" | "abandoned", "feedback": "..."? }
//! ```
//! - `approved`  → leave plan mode and implement. **No** `feedback` on the wire
//!   (TUI `send_approved` always passes `None`). Approve-with-comments is a
//!   separate user interjection after the reverse-RPC returns.
//! - `cancelled` → stay in plan mode / revise (Request changes). Optional
//!   `feedback` becomes "The user wants to revise the plan. The user said:…"
//! - `abandoned` → quit plan mode
//! - unknown `outcome` (or wrong field names like `decision`) → treated as
//!   **cancelled** (fail-closed). That is why Approve previously looked like
//!   "user wants to revise".

use crate::agent_runtime::{now_ms, truncate_text};
use crate::agent_types::{PendingPermission, PermissionKind, PermissionOption};
use crate::json_util::str_field;
use serde_json::{json, Value};

/// Option ids used by the MarsBuild plan-approval UI / resolve path.
pub const OPT_APPROVE: &str = "approve";
pub const OPT_REQUEST_CHANGES: &str = "request-changes";
pub const OPT_ABANDON: &str = "abandon";

/// Build a pending plan-approval request from the reverse-RPC params.
pub fn build_plan_approval(
    handle_id: &str,
    session_id: Option<String>,
    request_id: Value,
    params: &Value,
) -> PendingPermission {
    // Upstream: sessionId, toolCallId, planContent (camelCase).
    let plan_content = str_field(params, &["planContent", "plan_content"]).unwrap_or_default();
    let plan_path =
        str_field(params, &["planFilePath", "plan_file_path", "plan_file"]).unwrap_or_default();
    let tool_call_id = str_field(params, &["toolCallId", "tool_call_id"]).unwrap_or_default();
    let session = session_id
        .or_else(|| str_field(params, &["sessionId", "session_id"]))
        .unwrap_or_default();

    let title = if plan_content.trim().is_empty() {
        "Plan approval · empty plan".to_string()
    } else {
        "Plan approval".to_string()
    };

    // Detail carries the path (short); full markdown stays in raw_params for the UI.
    let detail = if !plan_path.is_empty() {
        plan_path.clone()
    } else {
        truncate_text(&plan_content, 200)
    };

    PendingPermission {
        request_key: format!(
            "{handle_id}:plan:{}",
            crate::permission_policy::request_id_key(&request_id)
        ),
        handle_id: handle_id.to_string(),
        session_id: if session.is_empty() {
            None
        } else {
            Some(session)
        },
        request_id,
        kind: PermissionKind::PlanApproval,
        method: "x.ai/exit_plan_mode".into(),
        title,
        detail,
        risk: "low".into(),
        options: plan_approval_options(),
        raw_params: json!({
            "sessionId": params.get("sessionId").cloned()
                .or_else(|| params.get("session_id").cloned())
                .unwrap_or(Value::Null),
            "toolCallId": tool_call_id,
            "planContent": plan_content,
            "planFilePath": plan_path,
            "source": params,
        }),
        created_at_ms: now_ms(),
    }
}

fn plan_approval_options() -> Vec<PermissionOption> {
    vec![
        PermissionOption {
            option_id: OPT_APPROVE.into(),
            name: "Approve".into(),
            kind: "allow_once".into(),
        },
        PermissionOption {
            option_id: OPT_REQUEST_CHANGES.into(),
            name: "Request changes".into(),
            kind: "reject_once".into(),
        },
        PermissionOption {
            option_id: OPT_ABANDON.into(),
            name: "Quit plan".into(),
            kind: "reject_once".into(),
        },
    ]
}

/// Map a UI option (+ optional freeform comments) to the ACP JSON-RPC **result**.
///
/// Always returns `Ok(result)` for known options — request-changes is a normal
/// `outcome: "cancelled"` result, **not** a JSON-RPC error (upstream TUI does
/// the same via `send_cancelled`).
pub fn resolve_plan_approval_response(option_id: &str, comments: &str) -> Result<Value, String> {
    let feedback = comments.trim();
    match option_id {
        OPT_APPROVE | "allow-once" | "allow_once" | "allow" => {
            Ok(exit_plan_ext_response("approved", None))
        }
        OPT_ABANDON | "reject-once" | "reject_once" | "reject" | "quit" => {
            Ok(exit_plan_ext_response("abandoned", None))
        }
        // Stay in plan mode; optional feedback is shown to the model.
        OPT_REQUEST_CHANGES | "request_changes" | "changes" | "cancelled" | "cancel" => {
            let fb = if feedback.is_empty() {
                None
            } else {
                Some(feedback.to_string())
            };
            Ok(exit_plan_ext_response("cancelled", fb))
        }
        other => Err(format!("Unknown plan-approval option: {other}")),
    }
}

/// Grok `ExitPlanModeExtResponse` JSON-RPC result body.
///
/// From upstream types.rs (no rename_all — keys are snake_case-free wire names):
/// - `outcome`: `"approved"` | `"cancelled"` | `"abandoned"`
/// - `feedback`: optional string, only when cancelling with notes
///
/// **Do not** send `decision` / `additionalFeedback` — those are ignored and
/// missing `outcome` is classified as cancelled ("user wants to revise").
fn exit_plan_ext_response(outcome: &str, feedback: Option<String>) -> Value {
    match feedback {
        Some(fb) if !fb.is_empty() => json!({
            "outcome": outcome,
            "feedback": fb,
        }),
        _ => json!({
            "outcome": outcome,
        }),
    }
}

pub fn is_plan_approve_option(option_id: &str) -> bool {
    matches!(
        option_id,
        OPT_APPROVE | "allow-once" | "allow_once" | "allow"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_pending_from_camel_case() {
        let pending = build_plan_approval(
            "h1",
            Some("sess".into()),
            json!(42),
            &json!({
                "sessionId": "sess",
                "toolCallId": "tc-1",
                "planContent": "# Hello\n\nDo the thing.",
            }),
        );
        assert_eq!(pending.kind, PermissionKind::PlanApproval);
        assert_eq!(pending.method, "x.ai/exit_plan_mode");
        assert!(pending
            .raw_params
            .get("planContent")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Hello"));
        assert_eq!(
            pending
                .raw_params
                .get("toolCallId")
                .and_then(|v| v.as_str()),
            Some("tc-1")
        );
        assert_eq!(pending.options.len(), 3);
    }

    #[test]
    fn builds_pending_from_snake_case() {
        let pending = build_plan_approval(
            "h1",
            None,
            json!("rid"),
            &json!({
                "session_id": "s2",
                "plan_content": "body",
                "plan_file_path": "/p/plan.md",
            }),
        );
        assert_eq!(pending.session_id.as_deref(), Some("s2"));
        assert_eq!(pending.detail, "/p/plan.md");
    }

    #[test]
    fn approve_response_matches_upstream() {
        // Official shape: { "outcome": "approved" } — no feedback key.
        let ok = resolve_plan_approval_response(OPT_APPROVE, " nits ").unwrap();
        assert_eq!(ok["outcome"], "approved");
        assert!(ok.get("feedback").is_none());
        assert!(ok.get("decision").is_none());
        assert!(ok.get("additionalFeedback").is_none());
    }

    #[test]
    fn abandon_response_matches_upstream() {
        let quit = resolve_plan_approval_response(OPT_ABANDON, "").unwrap();
        assert_eq!(quit["outcome"], "abandoned");
        assert!(quit.get("feedback").is_none());
    }

    #[test]
    fn request_changes_is_cancelled_result_not_rpc_error() {
        let rev = resolve_plan_approval_response(OPT_REQUEST_CHANGES, "use JWT").unwrap();
        assert_eq!(rev["outcome"], "cancelled");
        assert_eq!(rev["feedback"], "use JWT");

        let empty = resolve_plan_approval_response(OPT_REQUEST_CHANGES, "  ").unwrap();
        assert_eq!(empty["outcome"], "cancelled");
        assert!(empty.get("feedback").is_none());
    }
}
