//! ACP (Agent Client Protocol) JSON-RPC client over stdio.
//!
//! Architecture:
//! - [`gateway`] — channel-based I/O actor (owns stdin, demuxes responses)
//! - [`protocol`] — type-safe request/response payloads (no hand-rolled maps)

mod gateway;
pub mod protocol;

use gateway::AcpGateway;
use protocol::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

pub use protocol::CLIENT_IDENTIFIER;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("rpc error {code}: {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("timeout waiting for response to {0}")]
    Timeout(String),
    #[error("ACP transport closed: {0}")]
    TransportClosed(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AcpError>;

impl AcpError {
    /// Stable, actionable text for UI surfaces. The error itself retains the
    /// original protocol fields so logs and callers can still inspect them.
    pub fn user_message(&self) -> String {
        match self {
            Self::Rpc {
                code,
                message,
                data,
            } => user_facing_rpc_message(*code, message, data.as_ref()),
            _ => self.to_string(),
        }
    }
}

/// Callback for agent → client notifications / unsolicited messages.
pub type NotifyFn = Arc<dyn Fn(Value) + Send + Sync + 'static>;

/// High-level ACP client. All I/O goes through the channel gateway.
pub struct AcpClient {
    gateway: AcpGateway,
}

impl AcpClient {
    /// Spawn `grok [global_args…] agent [agent flags…] stdio`.
    ///
    /// `global_args` must come **before** `agent` (e.g. `--permission-mode auto`).
    /// `agent_args` come after `agent` and before `stdio` (e.g. `-m model`).
    pub fn spawn_with_notify(
        grok_bin: &str,
        always_approve: bool,
        global_args: &[String],
        agent_args: &[String],
        on_notify: NotifyFn,
    ) -> Result<Self> {
        let args = build_spawn_argv(always_approve, global_args, agent_args);

        let mut cmd = Command::new(grok_bin);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Propagate proxy so grok can reach xAI APIs behind firewalls/proxies.
        if let Some(proxy_url) = crate::proxy::detect_proxy() {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                cmd.env(key, &proxy_url);
            }
        }

        // GUI host on Windows: hide the console window that `grok.exe` would open.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;
        let gateway = AcpGateway::start(child, on_notify)?;
        Ok(Self { gateway })
    }

    pub fn pid(&self) -> u32 {
        self.gateway.pid()
    }

    /// Low-level typed call: serialize params, deserialize result.
    pub fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &'static str,
        params: &P,
        timeout: Duration,
    ) -> Result<R> {
        let params_val = serde_json::to_value(params)?;
        let result = self.gateway.call(method, params_val, timeout)?;
        Ok(serde_json::from_value(result)?)
    }

    /// Low-level typed call that keeps the raw JSON result (flexible responses).
    pub fn call_raw<P: Serialize>(
        &self,
        method: &'static str,
        params: &P,
        timeout: Duration,
    ) -> Result<Value> {
        let params_val = serde_json::to_value(params)?;
        self.gateway.call(method, params_val, timeout)
    }

    /// Typed JSON-RPC notification (no response).
    pub fn notify_typed<P: Serialize>(&self, method: &'static str, params: &P) -> Result<()> {
        let envelope = JsonRpcNotification {
            jsonrpc: "2.0",
            method,
            params,
        };
        let line = serde_json::to_string(&envelope)?;
        self.gateway.write_line(line)
    }

    /// Respond to a server→client JSON-RPC request.
    pub fn respond_result(&self, id: &Value, result: Value) -> Result<()> {
        let envelope = JsonRpcResultResponse {
            jsonrpc: "2.0",
            id: id.clone(),
            result,
        };
        let line = serde_json::to_string(&envelope)?;
        self.gateway.write_line(line)
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<()> {
        let envelope = JsonRpcErrorResponse {
            jsonrpc: "2.0",
            id: id.clone(),
            error: JsonRpcErrorBody {
                code,
                message: message.to_string(),
            },
        };
        let line = serde_json::to_string(&envelope)?;
        self.gateway.write_line(line)
    }

    pub fn initialize(&self) -> Result<InitializeResult> {
        self.call(
            "initialize",
            &InitializeParams::pinkcode(),
            Duration::from_secs(30),
        )
    }

    /// Complete the ACP authentication handshake when initialize advertises a
    /// non-interactive cached-token or API-key method.
    pub fn authenticate_if_available(
        &self,
        initialize: &InitializeResult,
    ) -> Result<Option<Value>> {
        let Some(method_id) = select_non_interactive_auth_method(initialize) else {
            return Ok(None);
        };
        self.call_raw(
            "authenticate",
            &AuthenticateParams {
                method_id: method_id.to_string(),
            },
            Duration::from_secs(30),
        )
        .map(Some)
    }

    pub fn session_new(&self, cwd: &str) -> Result<SessionBootstrapResult> {
        self.call(
            "session/new",
            &SessionNewParams {
                cwd: cwd.to_string(),
                mcp_servers: vec![],
            },
            Duration::from_secs(60),
        )
    }

    pub fn session_load(&self, session_id: &str, cwd: &str) -> Result<SessionBootstrapResult> {
        self.call(
            "session/load",
            &SessionLoadParams {
                session_id: session_id.to_string(),
                cwd: cwd.to_string(),
                mcp_servers: vec![],
            },
            Duration::from_secs(60),
        )
    }

    pub fn session_prompt(&self, session_id: &str, prompt_id: &str, text: &str) -> Result<Value> {
        self.call_raw(
            "session/prompt",
            &SessionPromptParams::text(session_id, prompt_id, text),
            Duration::from_secs(60 * 30),
        )
    }

    /// ACP `session/set_mode` — switch agent operating mode (e.g. `plan`).
    pub fn session_set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value> {
        self.call_raw(
            "session/set_mode",
            &SessionSetModeParams {
                session_id: session_id.to_string(),
                mode_id: mode_id.to_string(),
            },
            Duration::from_secs(30),
        )
    }

    /// Queue a user interjection into the currently running Grok turn.
    pub fn session_interject(&self, session_id: &str, text: &str) -> Result<Value> {
        self.call_raw(
            "x.ai/interject",
            &InterjectParams {
                session_id: session_id.to_string(),
                text: text.to_string(),
                interjection_id: uuid::Uuid::new_v4().to_string(),
            },
            Duration::from_secs(30),
        )
    }

    pub fn queue_remove(&self, session_id: &str, id: &str, expected_version: u64) -> Result<()> {
        self.notify_typed(
            "x.ai/queue/remove",
            &QueueRemoveParams {
                session_id: session_id.to_string(),
                id: id.to_string(),
                expected_version,
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        )
    }

    pub fn queue_reorder(&self, session_id: &str, ordered_ids: &[String]) -> Result<()> {
        self.notify_typed(
            "x.ai/queue/reorder",
            &QueueReorderParams {
                session_id: session_id.to_string(),
                ordered_ids: ordered_ids.to_vec(),
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        )
    }

    pub fn queue_clear(&self, session_id: &str) -> Result<()> {
        self.notify_typed(
            "x.ai/queue/clear",
            &QueueClearParams {
                session_id: session_id.to_string(),
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        )
    }

    pub fn queue_edit(&self, session_id: &str, id: &str, new_text: &str) -> Result<()> {
        self.notify_typed(
            "x.ai/queue/edit",
            &QueueEditParams {
                session_id: session_id.to_string(),
                id: id.to_string(),
                new_text: new_text.to_string(),
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        )
    }

    pub fn queue_interject(&self, session_id: &str, id: &str, expected_version: u64) -> Result<()> {
        self.notify_typed(
            "x.ai/queue/interject",
            &QueueInterjectParams {
                session_id: session_id.to_string(),
                id: id.to_string(),
                expected_version,
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        )
    }

    /// Host permission mode → Grok shell yolo/auto notification.
    pub fn notify_yolo_mode(
        &self,
        yolo_mode: bool,
        auto_mode: bool,
        permission_mode: &'static str,
    ) -> Result<()> {
        self.notify_typed(
            "x.ai/yolo_mode_changed",
            &YoloModeChangedParams {
                yolo_mode,
                auto_mode,
                permission_mode,
            },
        )
    }

    /// ACP `session/cancel` — cancel in-flight turn gracefully.
    pub fn session_cancel(&self, session_id: &str, reason: &str) -> Result<()> {
        self.notify_typed(
            "session/cancel",
            &SessionCancelParams {
                session_id: session_id.to_string(),
                reason: reason.to_string(),
            },
        )
    }

    pub fn kill(&self) -> Result<()> {
        self.gateway.kill()
    }
}

fn select_non_interactive_auth_method(initialize: &InitializeResult) -> Option<&str> {
    let default = initialize.default_auth_method_id();
    if let Some(id @ ("cached_token" | "xai.api_key")) = default {
        if initialize.has_auth_method(id) {
            return Some(id);
        }
    }
    ["cached_token", "xai.api_key"]
        .into_iter()
        .find(|id| initialize.has_auth_method(id))
}

/// ACP keeps its stable JSON-RPC label in `error.message` and puts the useful
/// upstream failure in `error.data`. Prefer that detail for UI-facing errors.
fn user_facing_rpc_message(code: i64, message: &str, data: Option<&Value>) -> String {
    let detail = data.and_then(rpc_error_detail);
    let http_status = data
        .and_then(|value| value.get("http_status").or_else(|| value.get("httpStatus")))
        .and_then(Value::as_u64);

    if http_status == Some(402)
        || detail.is_some_and(|text| {
            let lower = text.to_ascii_lowercase();
            lower.contains("402") && lower.contains("usage balance exhausted")
        })
    {
        return "Grok Build usage balance exhausted. Add credits or switch to an account with available balance. (HTTP 402 Payment Required)".into();
    }

    if let Some(detail) = detail.filter(|detail| !detail.trim().is_empty()) {
        return detail.trim().to_string();
    }

    if message.eq_ignore_ascii_case("internal error") {
        return format!("Grok Build returned an internal error (RPC {code}).");
    }

    message.to_string()
}

fn rpc_error_detail(data: &Value) -> Option<&str> {
    data.as_str()
        .or_else(|| data.get("message").and_then(Value::as_str))
        .or_else(|| data.pointer("/error/message").and_then(Value::as_str))
}

/// Build the argv passed to `grok` for ACP stdio (production spawn + tests).
fn build_spawn_argv(
    always_approve: bool,
    global_args: &[String],
    agent_args: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.extend(global_args.iter().cloned());
    args.push("agent".into());
    if always_approve {
        args.push("--always-approve".into());
    }
    args.extend(agent_args.iter().cloned());
    args.push("stdio".into());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    #[test]
    fn transport_close_wakes_all_pending_requests() {
        let pending = parking_lot::Mutex::new(std::collections::HashMap::new());
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        pending.lock().insert(10, gateway::pending_with(tx1));
        pending.lock().insert(11, gateway::pending_with(tx2));

        gateway::fail_all_pending_for_test(&pending, "closed");

        assert!(pending.lock().is_empty());
        match rx1.recv().expect("first waiter") {
            Err(AcpError::TransportClosed(msg)) => assert_eq!(msg, "closed"),
            other => panic!("unexpected {other:?}"),
        }
        match rx2.recv().expect("second waiter") {
            Err(AcpError::TransportClosed(msg)) => assert_eq!(msg, "closed"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn transport_closed_message_includes_stderr_tail() {
        let empty = parking_lot::Mutex::new(VecDeque::new());
        assert_eq!(
            gateway::transport_closed_message_for_test(&empty),
            "ACP transport closed"
        );

        let mut tail = VecDeque::new();
        tail.push_back("error: unexpected argument '--permission-mode' found".into());
        let with = parking_lot::Mutex::new(tail);
        let msg = gateway::transport_closed_message_for_test(&with);
        assert!(msg.starts_with("ACP transport closed: "));
        assert!(msg.contains("unexpected argument"));
    }

    #[test]
    fn rpc_error_uses_structured_detail_instead_of_internal_error_label() {
        let data = json!({
            "message": "API error (status 500): upstream unavailable",
            "http_status": 500
        });
        assert_eq!(
            user_facing_rpc_message(-32603, "Internal error", Some(&data)),
            "API error (status 500): upstream unavailable"
        );
    }

    #[test]
    fn rpc_error_explains_exhausted_grok_build_balance() {
        let data = json!({
            "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",
            "http_status": 402
        });
        let error = AcpError::Rpc {
            code: -32603,
            message: "Internal error".into(),
            data: Some(data),
        };
        assert_eq!(error.to_string(), "rpc error -32603: Internal error");
        assert_eq!(
            error.user_message(),
            "Grok Build usage balance exhausted. Add credits or switch to an account with available balance. (HTTP 402 Payment Required)"
        );
    }

    #[test]
    fn rpc_error_keeps_code_when_no_detail_is_available() {
        assert_eq!(
            user_facing_rpc_message(-32603, "Internal error", None),
            "Grok Build returned an internal error (RPC -32603)."
        );
    }

    #[test]
    fn spawn_argv_places_permission_mode_before_agent() {
        let global = vec!["--permission-mode".into(), "auto".into()];
        let agent = vec!["-m".into(), "grok-4".into()];
        assert_eq!(
            build_spawn_argv(false, &global, &agent),
            vec![
                "--permission-mode",
                "auto",
                "agent",
                "-m",
                "grok-4",
                "stdio",
            ]
        );
        assert_eq!(
            build_spawn_argv(true, &[], &[]),
            vec!["agent", "--always-approve", "stdio"]
        );
    }

    #[test]
    fn auth_selection_prefers_agent_default_but_skips_interactive_methods() {
        let initialized: InitializeResult = serde_json::from_value(json!({
            "authMethods": [
                { "id": "grok.com", "name": "Grok" },
                { "id": "xai.api_key", "name": "API key" },
                { "id": "cached_token", "name": "Cached token" }
            ],
            "_meta": { "defaultAuthMethodId": "xai.api_key" }
        }))
        .unwrap();
        assert_eq!(
            select_non_interactive_auth_method(&initialized),
            Some("xai.api_key")
        );

        let interactive_only: InitializeResult = serde_json::from_value(json!({
            "authMethods": [{ "id": "grok.com", "name": "Grok" }],
            "_meta": { "defaultAuthMethodId": "grok.com" }
        }))
        .unwrap();
        assert_eq!(select_non_interactive_auth_method(&interactive_only), None);
    }

    #[test]
    fn initialize_params_serialize_with_client_identifier_meta() {
        let v = serde_json::to_value(InitializeParams::pinkcode()).unwrap();
        assert_eq!(v["protocolVersion"], 1);
        assert_eq!(v["clientInfo"]["name"], "pinkcode");
        assert_eq!(v["meta"]["clientIdentifier"], CLIENT_IDENTIFIER);
        assert_eq!(
            v["clientCapabilities"]["meta"]["x.ai/incrementalBashOutput"],
            true
        );
    }

    #[test]
    fn session_bootstrap_result_reads_model() {
        let r: SessionBootstrapResult = serde_json::from_value(json!({
            "sessionId": "sess-1",
            "models": { "currentModelId": "grok-4" }
        }))
        .unwrap();
        assert_eq!(r.session_id, "sess-1");
        assert_eq!(r.current_model_id(), Some("grok-4"));
    }

    #[test]
    fn handshake_session_new_and_kill() {
        if std::env::var("CI").is_ok() {
            eprintln!("skip: CI environment detected");
            return;
        }
        let grok = std::env::var("GROK_BIN")
            .ok()
            .filter(|p| std::path::Path::new(p).is_file())
            .or_else(|| {
                std::env::var("GROK_HOME").ok().and_then(|h| {
                    let base = std::path::PathBuf::from(h).join("bin").join("grok");
                    #[cfg(windows)]
                    {
                        let exe = base.with_extension("exe");
                        if exe.is_file() {
                            return Some(exe.display().to_string());
                        }
                    }
                    base.is_file().then(|| base.display().to_string())
                })
            })
            .or_else(|| {
                let home = dirs::home_dir()?;
                let base = home.join(".grok").join("bin").join("grok");
                #[cfg(windows)]
                {
                    let exe = base.with_extension("exe");
                    if exe.is_file() {
                        return Some(exe.display().to_string());
                    }
                }
                base.is_file().then(|| base.display().to_string())
            });
        let Some(grok) = grok else {
            eprintln!("skip: grok not installed");
            return;
        };
        let cwd = std::env::temp_dir();
        let notifs = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&notifs);
        let client = AcpClient::spawn_with_notify(
            &grok,
            true,
            &[],
            &[],
            Arc::new(move |_m| {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("spawn");
        client.initialize().expect("init");
        let res = client
            .session_new(&cwd.display().to_string())
            .expect("session/new");
        assert!(!res.session_id.is_empty());
        client.kill().expect("kill");
        assert!(notifs.load(Ordering::SeqCst) > 0);
    }
}
