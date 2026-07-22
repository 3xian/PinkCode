use crate::agent_runtime::{now_ms, truncate_text};
use crate::agent_types::{PendingPermission, PermissionKind, PermissionMode, PermissionOption};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Deny,
    Ask,
}

pub fn build_tool_permission(
    handle_id: &str,
    session_id: Option<String>,
    request_id: Value,
    params: &Value,
) -> PendingPermission {
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| tool.get("toolCallId").and_then(Value::as_str))
        .unwrap_or("Tool permission")
        .to_string();
    let detail = tool
        .get("rawInput")
        .map(Value::to_string)
        .or_else(|| {
            tool.get("locations")
                .and_then(Value::as_array)
                .and_then(|locations| locations.first())
                .and_then(|location| location.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    Some(PermissionOption {
                        option_id: option.get("optionId")?.as_str()?.to_string(),
                        name: option
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("Option")
                            .to_string(),
                        kind: option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_else(default_options);
    let lower_title = title.to_lowercase();
    let risk = if ["bash", "terminal", "execute"]
        .iter()
        .any(|keyword| lower_title.contains(keyword))
    {
        "high"
    } else if ["write", "edit", "replace"]
        .iter()
        .any(|keyword| lower_title.contains(keyword))
    {
        "medium"
    } else {
        "low"
    };
    PendingPermission {
        request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
        handle_id: handle_id.to_string(),
        session_id,
        request_id,
        kind: PermissionKind::ToolPermission,
        method: "session/request_permission".into(),
        title,
        detail: truncate_text(&detail, 400),
        risk: risk.into(),
        options,
        raw_params: params.clone(),
        created_at_ms: now_ms(),
    }
}

pub fn request_id_key(id: &Value) -> String {
    match id {
        Value::Number(number) => number.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

pub fn decide_gate(mode: PermissionMode, pending: &PendingPermission) -> GateDecision {
    match mode {
        PermissionMode::BypassPermissions => GateDecision::Allow,
        PermissionMode::DontAsk => GateDecision::Deny,
        PermissionMode::Default => GateDecision::Ask,
        PermissionMode::AcceptEdits if is_edit_permission(pending) => GateDecision::Allow,
        PermissionMode::AcceptEdits => GateDecision::Ask,
        // Live Auto is host-side only (see PermissionMode::Auto docs).
        PermissionMode::Auto if pending.risk == "high" => GateDecision::Ask,
        PermissionMode::Auto => GateDecision::Allow,
    }
}

pub fn pick_allow_option(options: &[PermissionOption]) -> String {
    options
        .iter()
        .find(|option| {
            option.kind.contains("allow_once")
                || option.option_id == "allow-once"
                || (option.option_id.contains("allow") && option.option_id.contains("once"))
        })
        .or_else(|| {
            options.iter().find(|option| {
                let allow = option.kind.contains("allow") || option.option_id.contains("allow");
                let always = option.kind.contains("always") || option.option_id.contains("always");
                allow && !always
            })
        })
        .or_else(|| {
            options
                .iter()
                .find(|option| option.kind.contains("allow") || option.option_id.contains("allow"))
        })
        .map(|option| option.option_id.clone())
        .unwrap_or_else(|| "allow-once".into())
}

pub fn pick_reject_option(options: &[PermissionOption], chosen: &str) -> String {
    if options.iter().any(|option| option.option_id == chosen) {
        return chosen.to_string();
    }
    options
        .iter()
        .find(|option| option.kind.contains("reject") || option.option_id.contains("reject"))
        .map(|option| option.option_id.clone())
        .unwrap_or_else(|| "reject-once".into())
}

pub fn is_allow_option(option_id: &str, options: &[PermissionOption]) -> bool {
    options
        .iter()
        .find(|option| option.option_id == option_id)
        .map(|option| option.kind.contains("allow") || option_id.contains("allow"))
        .unwrap_or_else(|| option_id.contains("allow"))
}

pub fn risk_for_path(path: &str) -> String {
    let path = path.to_lowercase();
    if [
        ".env",
        "id_rsa",
        "id_ed25519",
        "credentials",
        "secret",
        ".pem",
        "keystore",
        "wallet",
    ]
    .iter()
    .any(|keyword| path.contains(keyword))
    {
        return "high".into();
    }
    if ["/tmp/", "\\tmp\\", "/temp/", "\\temp\\"]
        .iter()
        .any(|keyword| path.contains(keyword))
    {
        return "low".into();
    }
    "medium".into()
}

fn is_edit_permission(pending: &PendingPermission) -> bool {
    if pending.kind == PermissionKind::FsWrite {
        return true;
    }
    if pending.kind == PermissionKind::FsRead {
        return false;
    }
    let title = pending.title.to_lowercase();
    let detail = pending.detail.to_lowercase();
    if ["bash", "shell", "terminal", "execute"]
        .iter()
        .any(|keyword| title.contains(keyword))
        || detail.contains("\"command\"")
    {
        return false;
    }
    let value = format!("{title} {detail}");
    [
        "write",
        "edit",
        "replace",
        "search_replace",
        "str_replace",
        "create_file",
        "apply_patch",
        "apply_diff",
        "write_text_file",
        "write_file",
        "fs/write",
        "multi_edit",
        "notebook_edit",
    ]
    .iter()
    .any(|keyword| value.contains(keyword))
}

fn default_options() -> Vec<PermissionOption> {
    vec![
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
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, kind: &str) -> PermissionOption {
        PermissionOption {
            option_id: id.into(),
            name: id.into(),
            kind: kind.into(),
        }
    }

    fn pending(kind: PermissionKind, title: &str, detail: &str) -> PendingPermission {
        PendingPermission {
            request_key: "request".into(),
            handle_id: "handle".into(),
            session_id: None,
            request_id: Value::Null,
            kind,
            method: "method".into(),
            title: title.into(),
            detail: detail.into(),
            risk: "medium".into(),
            options: vec![],
            raw_params: Value::Null,
            created_at_ms: 0,
        }
    }

    #[test]
    fn automatic_allow_prefers_once() {
        let options = vec![
            option("allow-always", "allow_always"),
            option("allow-once", "allow_once"),
        ];
        assert_eq!(pick_allow_option(&options), "allow-once");
    }

    #[test]
    fn modes_distinguish_edits_from_shell() {
        let edit = pending(PermissionKind::FsWrite, "Write file", "/tmp/a.rs");
        let shell = pending(
            PermissionKind::ToolPermission,
            "Bash",
            r#"{"command":"rm"}"#,
        );
        assert_eq!(
            decide_gate(PermissionMode::AcceptEdits, &edit),
            GateDecision::Allow
        );
        assert_eq!(
            decide_gate(PermissionMode::AcceptEdits, &shell),
            GateDecision::Ask
        );
        assert_eq!(
            decide_gate(PermissionMode::DontAsk, &edit),
            GateDecision::Deny
        );
    }

    #[test]
    fn auto_allows_safe_asks_on_high_risk() {
        let edit = pending(PermissionKind::FsWrite, "Write file", "/tmp/a.rs");
        let shell = pending(
            PermissionKind::ToolPermission,
            "Bash",
            r#"{"command":"rm"}"#,
        );
        // Shell title sets risk high via build_tool_permission; set explicitly here.
        let mut high = shell;
        high.risk = "high".into();
        assert_eq!(
            decide_gate(PermissionMode::Auto, &edit),
            GateDecision::Allow
        );
        assert_eq!(
            decide_gate(PermissionMode::Auto, &high),
            GateDecision::Ask
        );
    }
}
