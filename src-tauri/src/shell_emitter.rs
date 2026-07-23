use crate::agent_manager;
use crate::agent_runtime::now_ms;
use crate::shell_stream::ShellStream;
use serde_json::{json, Value};
use std::sync::Arc;

/// Extract shell command info from ACP session/update and publish to shell stream.
pub fn maybe_emit_shell(
    shell_stream: &ShellStream,
    inner: &Arc<agent_manager::Inner>,
    handle_id: &str,
    session_id: &Option<String>,
    params: &Value,
) {
    let update = match params.get("update") {
        Some(u) => u,
        None => return,
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if kind != "tool_call" && kind != "tool_call_update" {
        return;
    }

    let tool_meta_name = update
        .pointer("/_meta/x.ai/tool/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool_kind = update
        .get("kind")
        .and_then(|k| k.as_str())
        .or_else(|| {
            update
                .pointer("/_meta/x.ai/tool/kind")
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");
    let title = update.get("title").and_then(|t| t.as_str()).unwrap_or("");

    let is_shell = tool_meta_name == "run_terminal_command"
        || tool_kind == "execute"
        || title.contains("run_terminal")
        || title.to_lowercase().contains("execute `");

    if !is_shell && kind == "tool_call" {
        let raw_cmd = update.pointer("/rawInput/command").and_then(|c| c.as_str());
        if raw_cmd.is_none() {
            return;
        }
    } else if !is_shell {
        let has_bash_output =
            update.pointer("/rawOutput/type").and_then(|t| t.as_str()) == Some("Bash");
        if !has_bash_output {
            return;
        }
    }

    let tool_call_id = update
        .get("toolCallId")
        .and_then(|id| id.as_str())
        .unwrap_or("")
        .to_string();
    let command = update
        .pointer("/rawInput/command")
        .and_then(|c| c.as_str())
        .or_else(|| {
            update
                .pointer("/rawOutput/command")
                .and_then(|c| c.as_str())
        })
        .unwrap_or("")
        .to_string();
    let status = update
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or(if kind == "tool_call" {
            "pending"
        } else {
            "in_progress"
        })
        .to_string();
    let output = update
        .pointer("/rawOutput/output_for_prompt")
        .and_then(|o| o.as_str())
        .or_else(|| {
            update
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    arr.iter()
                        .find_map(|block| block.pointer("/content/text").and_then(|t| t.as_str()))
                })
        })
        .unwrap_or("")
        .to_string();
    let exit_code = update
        .pointer("/rawOutput/exit_code")
        .and_then(|c| c.as_i64());
    let description = update
        .pointer("/rawInput/description")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string();

    let shell_payload = json!({
        "handleId": handle_id,
        "sessionId": session_id,
        "toolCallId": tool_call_id,
        "command": command,
        "description": description,
        "status": status,
        "output": output,
        "exitCode": exit_code,
        "ts": now_ms(),
    });

    let emit_inner = Arc::clone(inner);
    shell_stream.publish(
        shell_payload,
        Arc::new(move |payload| {
            agent_manager::AgentManager::emit(&emit_inner, "agent-shell", payload)
        }),
    );
}
