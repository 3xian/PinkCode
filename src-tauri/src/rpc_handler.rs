//! RpcHandler trait — unified dispatch for ACP server→client requests.
//!
//! Each reverse-RPC kind (tool permission, fs write, plan approval, ask-user
//! question) registers a handler that knows how to build a PendingPermission
//! from incoming params and how to respond after the user resolves it.
//! The framework (agent_manager) handles gating, bookkeeping, and I/O.

use crate::agent_fs::read_text_file;
use crate::agent_runtime::now_ms;
use crate::agent_types::{PendingPermission, PermissionKind, PermissionOption};
use crate::ask_user_question::{build_user_question, resolve_user_question_response};
use crate::permission_policy::{
    build_tool_permission, pick_allow_option, pick_reject_option, request_id_key, risk_for_path,
};
use crate::plan_approval::{build_plan_approval, resolve_plan_approval_response};
use serde_json::{json, Value};

/// Outcome of handling an incoming server→client request.
pub enum HandleResult {
    Respond(Value),
    Gate(Box<PendingPermission>),
    Error(i64, String),
}

/// Action after a gate-able permission is resolved.
pub enum ResponseAction {
    Send(Value),
    SendError(i64, String),
    WriteFile { path: String, content: String },
}

pub trait RpcHandler: Send + Sync {
    /// ACP methods this handler processes.
    fn method_matchers(&self) -> &[&str];

    /// The PermissionKind handled by this handler's build_response.
    /// None for handlers whose handle_request always returns Respond (no gate).
    fn gated_kind(&self) -> Option<PermissionKind> {
        None
    }

    /// Build an outcome from incoming params.
    fn handle_request(
        &self,
        handle_id: &str,
        session_id: Option<String>,
        request_id: Value,
        params: &Value,
    ) -> HandleResult;

    /// Whether the option_id represents approval/allow for this handler's kind.
    fn is_allow_option(&self, option_id: &str) -> bool {
        let lower = option_id.to_lowercase();
        lower.contains("allow") || lower == "accept" || lower == "submit"
    }

    /// Build action after user resolves a gated permission.
    /// Only called for Gate-returned handlers.
    fn build_response(
        &self,
        pending: &PendingPermission,
        option_id: &str,
        allow: bool,
        comments: Option<&str>,
        payload: Option<&Value>,
    ) -> Result<ResponseAction, String>;
}

// ── ToolPermission (session/request_permission) ──────────────────────

pub struct ToolPermissionHandler;

impl RpcHandler for ToolPermissionHandler {
    fn method_matchers(&self) -> &[&str] {
        &["session/request_permission"]
    }

    fn gated_kind(&self) -> Option<PermissionKind> {
        Some(PermissionKind::ToolPermission)
    }

    fn handle_request(
        &self,
        handle_id: &str,
        session_id: Option<String>,
        request_id: Value,
        params: &Value,
    ) -> HandleResult {
        let pending = build_tool_permission(handle_id, session_id, request_id, params);
        HandleResult::Gate(Box::new(pending))
    }

    fn build_response(
        &self,
        _pending: &PendingPermission,
        option_id: &str,
        _allow: bool,
        _comments: Option<&str>,
        _payload: Option<&Value>,
    ) -> Result<ResponseAction, String> {
        Ok(ResponseAction::Send(json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        })))
    }
}

// ── FsWrite (fs/write_text_file) ────────────────────────────────────

pub struct FsWriteHandler;

impl RpcHandler for FsWriteHandler {
    fn method_matchers(&self) -> &[&str] {
        &["fs/write_text_file"]
    }

    fn gated_kind(&self) -> Option<PermissionKind> {
        Some(PermissionKind::FsWrite)
    }

    fn handle_request(
        &self,
        handle_id: &str,
        session_id: Option<String>,
        request_id: Value,
        params: &Value,
    ) -> HandleResult {
        let path = params
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        let pending = PendingPermission {
            request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
            handle_id: handle_id.to_string(),
            session_id,
            request_id,
            kind: PermissionKind::FsWrite,
            method: "fs/write_text_file".into(),
            title: "Write file".into(),
            detail: path.clone(),
            risk: risk_for_path(&path),
            options: vec![
                PermissionOption {
                    option_id: "allow-once".into(),
                    name: "Allow once".into(),
                    kind: "allow_once".into(),
                },
                PermissionOption {
                    option_id: "reject-once".into(),
                    name: "Deny".into(),
                    kind: "reject_once".into(),
                },
            ],
            raw_params: params.clone(),
            created_at_ms: now_ms(),
        };
        HandleResult::Gate(Box::new(pending))
    }

    fn build_response(
        &self,
        pending: &PendingPermission,
        _option_id: &str,
        allow: bool,
        _comments: Option<&str>,
        _payload: Option<&Value>,
    ) -> Result<ResponseAction, String> {
        if allow {
            let path = pending
                .raw_params
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let content = pending
                .raw_params
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("");
            Ok(ResponseAction::WriteFile {
                path: path.to_string(),
                content: content.to_string(),
            })
        } else {
            Ok(ResponseAction::SendError(
                -32000,
                "User denied file write in PinkCode".into(),
            ))
        }
    }
}

// ── FsRead (fs/read_text_file) — never gated ────────────────────────

pub struct FsReadHandler;

impl RpcHandler for FsReadHandler {
    fn method_matchers(&self) -> &[&str] {
        &["fs/read_text_file"]
    }

    fn build_response(
        &self,
        _pending: &PendingPermission,
        _option_id: &str,
        allow: bool,
        _comments: Option<&str>,
        _payload: Option<&Value>,
    ) -> Result<ResponseAction, String> {
        // FsRead is never gated, but the trait requires build_response.
        if allow {
            Ok(ResponseAction::Send(Value::Null))
        } else {
            Ok(ResponseAction::SendError(
                -32000,
                "User denied file read in PinkCode".into(),
            ))
        }
    }

    fn handle_request(
        &self,
        _handle_id: &str,
        _session_id: Option<String>,
        _request_id: Value,
        params: &Value,
    ) -> HandleResult {
        let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
        match read_text_file(path, params.get("line"), params.get("limit")) {
            Ok(content) => HandleResult::Respond(json!({ "content": content })),
            Err(e) => HandleResult::Error(-32000, e),
        }
    }
}

// ── PlanApproval (x.ai/exit_plan_mode) ──────────────────────────────

pub struct PlanApprovalHandler;

impl RpcHandler for PlanApprovalHandler {
    fn method_matchers(&self) -> &[&str] {
        &["x.ai/exit_plan_mode"]
    }

    fn gated_kind(&self) -> Option<PermissionKind> {
        Some(PermissionKind::PlanApproval)
    }

    fn is_allow_option(&self, option_id: &str) -> bool {
        crate::plan_approval::is_plan_approve_option(option_id)
    }

    fn handle_request(
        &self,
        handle_id: &str,
        session_id: Option<String>,
        request_id: Value,
        params: &Value,
    ) -> HandleResult {
        let pending = build_plan_approval(handle_id, session_id, request_id, params);
        HandleResult::Gate(Box::new(pending))
    }

    fn build_response(
        &self,
        _pending: &PendingPermission,
        option_id: &str,
        _allow: bool,
        comments: Option<&str>,
        _payload: Option<&Value>,
    ) -> Result<ResponseAction, String> {
        let comments = comments.unwrap_or("");
        resolve_plan_approval_response(option_id, comments).map(ResponseAction::Send)
    }
}

// ── UserQuestion (x.ai/ask_user_question) ───────────────────────────

pub struct UserQuestionHandler;

impl RpcHandler for UserQuestionHandler {
    fn method_matchers(&self) -> &[&str] {
        &["x.ai/ask_user_question"]
    }

    fn gated_kind(&self) -> Option<PermissionKind> {
        Some(PermissionKind::UserQuestion)
    }

    fn is_allow_option(&self, option_id: &str) -> bool {
        crate::ask_user_question::is_user_question_accept_option(option_id)
    }

    fn handle_request(
        &self,
        handle_id: &str,
        session_id: Option<String>,
        request_id: Value,
        params: &Value,
    ) -> HandleResult {
        let pending = build_user_question(handle_id, session_id, request_id, params);
        HandleResult::Gate(Box::new(pending))
    }

    fn build_response(
        &self,
        _pending: &PendingPermission,
        option_id: &str,
        _allow: bool,
        _comments: Option<&str>,
        payload: Option<&Value>,
    ) -> Result<ResponseAction, String> {
        resolve_user_question_response(option_id, payload).map(ResponseAction::Send)
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Find a handler whose matchers include `method`.
/// Supports both exact match and suffix match for extension methods (e.g.
/// `_x.ai/method` → matches `x.ai/method` matcher via ends_with).
pub fn find_handler<'a>(
    handlers: &'a [Box<dyn RpcHandler>],
    method: &str,
) -> Option<&'a dyn RpcHandler> {
    handlers
        .iter()
        .find(|h| {
            h.method_matchers()
                .iter()
                .any(|m| method == *m || (m.contains('/') && method.ends_with(m)))
        })
        .map(|b| b.as_ref())
}

/// Find a handler that can handle a given PermissionKind (for resolve_permission).
pub fn find_handler_by_kind(
    handlers: &[Box<dyn RpcHandler>],
    kind: PermissionKind,
) -> Option<&dyn RpcHandler> {
    handlers
        .iter()
        .find(|h| h.gated_kind() == Some(kind))
        .map(|b| b.as_ref())
}

/// Build auto-allow response.
pub fn build_allow_response(
    handler: &dyn RpcHandler,
    pending: &PendingPermission,
) -> Result<ResponseAction, String> {
    let oid = pick_allow_option(&pending.options);
    handler.build_response(pending, &oid, true, None, None)
}

/// Build auto-deny response.
pub fn build_deny_response(
    handler: &dyn RpcHandler,
    pending: &PendingPermission,
) -> Result<ResponseAction, String> {
    let oid = pick_reject_option(&pending.options, "reject-once");
    handler.build_response(pending, &oid, false, None, None)
}

/// Default handler set.
pub fn default_handlers() -> Vec<Box<dyn RpcHandler>> {
    vec![
        Box::new(ToolPermissionHandler),
        Box::new(FsWriteHandler),
        Box::new(FsReadHandler),
        Box::new(PlanApprovalHandler),
        Box::new(UserQuestionHandler),
    ]
}
