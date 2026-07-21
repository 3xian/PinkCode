//! Multi-agent process manager: spawn / attach / prompt / stop / permissions via ACP.
//!
//! Permission modes mirror Grok Build's prompt policy (see `22-permissions-and-safety.md`):
//! - `default` — ask the user on gated ops
//! - `acceptEdits` — auto-allow file edits; ask for shell / other tools
//! - `bypassPermissions` — auto-allow (spawn with `grok --always-approve`)
//! - `dontAsk` — auto-deny anything that would have prompted
//!
//! Process flag `--always-approve` is only available on `grok agent`; other modes are
//! enforced by this ACP host. Runtime mode changes update host decisions only.

use crate::acp::{AcpClient, NotifyFn};
use crate::task_prefs;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Min interval between intermediate shell stdout emits for the same tool call.
const SHELL_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(120);
/// Always re-emit when stdout grew by at least this many bytes (even inside interval).
const SHELL_EMIT_MIN_BYTES: usize = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManagedStatus {
    Starting,
    Ready,
    Running,
    AwaitingPermission,
    Error,
    Stopped,
}

/// Grok Build permission prompt policy (subset that is meaningful for an ACP host).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    /// Prompt for anything not pre-approved (default interactive).
    #[default]
    Default,
    /// Auto-approve file edits; ask for shell / other tools.
    AcceptEdits,
    /// Auto-approve tool calls (`--always-approve` / bypassPermissions).
    BypassPermissions,
    /// Deny anything that would prompt (CI / high-security style).
    DontAsk,
}

impl PermissionMode {
    /// Whether to pass `grok agent --always-approve` at process spawn.
    pub fn spawns_always_approve(self) -> bool {
        matches!(self, Self::BypassPermissions)
    }

    pub fn from_request(
        mode: Option<PermissionMode>,
        always_approve: Option<bool>,
    ) -> Self {
        if let Some(m) = mode {
            return m;
        }
        if always_approve == Some(true) {
            return Self::BypassPermissions;
        }
        Self::Default
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentInfo {
    pub handle_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: ManagedStatus,
    /// Grok-aligned permission mode for this agent.
    pub permission_mode: PermissionMode,
    /// Convenience mirror of `permission_mode == bypassPermissions` (UI / legacy).
    pub always_approve: bool,
    pub model_id: Option<String>,
    pub last_error: Option<String>,
    pub title: Option<String>,
    pub created_at: String,
    pub pending_permission_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub cwd: String,
    pub prompt: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    /// Legacy alias: `true` → `bypassPermissions` when `permission_mode` is omitted.
    pub always_approve: Option<bool>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachRequest {
    pub session_id: String,
    pub cwd: String,
    pub permission_mode: Option<PermissionMode>,
    /// Legacy alias: `true` → `bypassPermissions` when `permission_mode` is omitted.
    pub always_approve: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    /// ACP `session/request_permission`
    ToolPermission,
    /// Client-side `fs/write_text_file`
    FsWrite,
    /// Client-side `fs/read_text_file` (normally auto)
    FsRead,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    pub request_key: String,
    pub handle_id: String,
    pub session_id: Option<String>,
    pub request_id: Value,
    pub kind: PermissionKind,
    pub method: String,
    pub title: String,
    pub detail: String,
    pub risk: String,
    pub options: Vec<PermissionOption>,
    pub raw_params: Value,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePermissionRequest {
    pub handle_id: String,
    pub request_key: String,
    pub option_id: String,
}

struct LiveAgent {
    info: ManagedAgentInfo,
    client: Arc<AcpClient>,
}

/// Throttle state for `agent-shell` IPC (full stdout re-send is expensive).
struct ShellEmitState {
    last_at: Instant,
    last_status: String,
    last_out_len: usize,
    last_exit: Option<i64>,
    /// Latest intermediate payload suppressed by the rate limit; flushed after interval.
    pending_payload: Option<Value>,
    /// Bumped on every update; trailing flush only emits if gen still matches.
    gen: u64,
}

struct Inner {
    app: Mutex<Option<AppHandle>>,
    agents: Mutex<HashMap<String, LiveAgent>>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    /// Server→client requests that arrived before the agent was registered.
    early_requests: Mutex<Vec<(String, Value)>>,
    grok_bin: Mutex<Option<String>>,
    /// Key: `{handleId}:{toolCallId}` → last shell emit snapshot.
    shell_emit: Mutex<HashMap<String, ShellEmitState>>,
}

#[derive(Clone)]
pub struct AgentManager {
    inner: Arc<Inner>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                app: Mutex::new(None),
                agents: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                early_requests: Mutex::new(Vec::new()),
                grok_bin: Mutex::new(None),
                shell_emit: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Change host-side permission mode for a live agent.
    ///
    /// Process-level `grok --always-approve` is fixed at spawn/attach; this updates
    /// MarsBuild's ACP auto-response only. Pending requests are reconciled for the
    /// new mode (allow / deny / leave for acceptEdits partial matches).
    pub fn set_permission_mode(
        &self,
        handle_id: &str,
        mode: PermissionMode,
    ) -> Result<ManagedAgentInfo, String> {
        let session_id = {
            let mut agents = self.inner.agents.lock();
            let agent = agents
                .get_mut(handle_id)
                .ok_or_else(|| format!("unknown handle {handle_id}"))?;
            agent.info.permission_mode = mode;
            agent.info.always_approve = mode.spawns_always_approve();
            Self::emit_status(&self.inner, &agent.info);
            agent.info.session_id.clone()
        };
        if let Some(sid) = session_id.as_deref() {
            task_prefs::set_permission_mode(sid, mode);
        }
        self.reconcile_pending_for_mode(handle_id, mode);
        self.get(handle_id)
            .ok_or_else(|| format!("unknown handle {handle_id}"))
    }

    /// Auto-resolve pending requests that the new mode no longer wants to ask about.
    fn reconcile_pending_for_mode(&self, handle_id: &str, mode: PermissionMode) {
        let items: Vec<(String, GateDecision, String)> = {
            let pending = self.inner.pending.lock();
            pending
                .values()
                .filter(|p| p.handle_id == handle_id)
                .filter_map(|p| {
                    let decision = decide_gate(mode, p);
                    match decision {
                        GateDecision::Ask => None,
                        GateDecision::Allow => Some((
                            p.request_key.clone(),
                            decision,
                            pick_allow_option(&p.options),
                        )),
                        GateDecision::Deny => Some((
                            p.request_key.clone(),
                            decision,
                            pick_reject_option(&p.options, "reject-once"),
                        )),
                    }
                })
                .collect()
        };
        for (key, _decision, option_id) in items {
            let _ = self.resolve_permission(ResolvePermissionRequest {
                handle_id: handle_id.to_string(),
                request_key: key,
                option_id,
            });
        }
    }

    /// Kill process, clear pending permissions, keep agent in map as `Error`
    /// so the UI can show the failure and the user can Stop to drop it.
    fn fail_registered_agent(
        inner: &Arc<Inner>,
        handle_id: &str,
        info: &mut ManagedAgentInfo,
        err: String,
    ) -> String {
        // Drop queued permissions (agent is unusable).
        {
            let mut pending = inner.pending.lock();
            pending.retain(|_, p| p.handle_id != handle_id);
        }

        let client = {
            let mut agents = inner.agents.lock();
            agents.get_mut(handle_id).map(|a| Arc::clone(&a.client))
        };
        if let Some(client) = client {
            let _ = client.kill();
        }

        info.status = ManagedStatus::Error;
        info.last_error = Some(err.clone());
        info.pid = None;
        info.pending_permission_count = 0;
        if let Some(a) = inner.agents.lock().get_mut(handle_id) {
            a.info = info.clone();
        }
        Self::emit_status(inner, info);
        err
    }

    pub fn set_app(&self, app: AppHandle) {
        *self.inner.app.lock() = Some(app);
    }

    fn emit(inner: &Inner, event: &str, payload: Value) {
        if let Some(app) = inner.app.lock().as_ref() {
            let _ = app.emit(event, payload);
        }
    }

    fn emit_status(inner: &Inner, info: &ManagedAgentInfo) {
        if let Ok(v) = serde_json::to_value(info) {
            Self::emit(inner, "agent-status", v);
        }
    }

    pub fn resolve_grok_bin(&self) -> Result<String, String> {
        if let Some(cached) = self.inner.grok_bin.lock().clone() {
            return Ok(cached);
        }
        let bin = find_grok_bin().ok_or_else(|| {
            "Could not find `grok` binary. Set GROK_BIN or install Grok Build.".to_string()
        })?;
        *self.inner.grok_bin.lock() = Some(bin.clone());
        Ok(bin)
    }

    pub fn list(&self) -> Vec<ManagedAgentInfo> {
        self.inner
            .agents
            .lock()
            .values()
            .map(|a| a.info.clone())
            .collect()
    }

    pub fn get(&self, handle_id: &str) -> Option<ManagedAgentInfo> {
        self.inner
            .agents
            .lock()
            .get(handle_id)
            .map(|a| a.info.clone())
    }

    pub fn find_by_session(&self, session_id: &str) -> Option<ManagedAgentInfo> {
        self.inner
            .agents
            .lock()
            .values()
            .find(|a| a.info.session_id.as_deref() == Some(session_id))
            .map(|a| a.info.clone())
    }

    pub fn list_pending_permissions(&self, handle_id: Option<String>) -> Vec<PendingPermission> {
        let mut list: Vec<_> = self
            .inner
            .pending
            .lock()
            .values()
            .filter(|p| {
                handle_id
                    .as_ref()
                    .map(|h| h == &p.handle_id)
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        list.sort_by_key(|p| p.created_at_ms);
        list
    }

    fn make_notify(inner: &Arc<Inner>, handle_id: &str) -> NotifyFn {
        let inner = Arc::clone(inner);
        let handle_id = handle_id.to_string();
        Arc::new(move |msg: Value| {
            let method = msg
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            let has_id = msg.get("id").is_some();
            let is_response_shape =
                msg.get("result").is_some() || msg.get("error").is_some();

            // Server → client request
            if has_id && !method.is_empty() && !is_response_shape {
                Self::handle_server_request(&inner, &handle_id, &msg);
                return;
            }

            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let session_id = params
                .get("sessionId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());

            let payload = json!({
                "handleId": handle_id,
                "sessionId": session_id,
                "method": method,
                "params": params,
            });

            // Standard ACP + Grok x.ai extension (`_x.ai/session/update` for
            // turn_completed, session_recap, compact, rewind, …).
            if method == "session/update" || method.ends_with("/session/update") {
                Self::emit(&inner, "agent-update", payload.clone());
                Self::maybe_emit_shell(&inner, &handle_id, &session_id, &params);
            } else if !method.is_empty() {
                Self::emit(&inner, "agent-notification", payload);
            }
        })
    }

    fn maybe_emit_shell(
        inner: &Arc<Inner>,
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
        let title = update
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Keep in sync with frontend `isShellToolUpdate` in format.ts.
        let is_shell = tool_meta_name == "run_terminal_command"
            || tool_kind == "execute"
            || title.contains("run_terminal")
            || title.to_lowercase().contains("execute `");

        if !is_shell && kind == "tool_call" {
            // still not shell
            let raw_cmd = update
                .pointer("/rawInput/command")
                .and_then(|c| c.as_str());
            if raw_cmd.is_none() {
                return;
            }
        } else if !is_shell {
            let has_bash_output = update
                .pointer("/rawOutput/type")
                .and_then(|t| t.as_str())
                == Some("Bash");
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
            .or_else(|| update.pointer("/rawOutput/command").and_then(|c| c.as_str()))
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
                        arr.iter().find_map(|block| {
                            block.pointer("/content/text").and_then(|t| t.as_str())
                        })
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

        // Throttle intermediate stdout floods; always emit first / status change / terminal.
        // Suppressed updates schedule a trailing flush so the last snapshot is not stuck.
        let throttle_key = format!("{handle_id}:{tool_call_id}");
        let out_len = output.len();
        let is_terminal = status == "completed"
            || status == "failed"
            || status == "cancelled"
            || exit_code.is_some();
        {
            let mut map = inner.shell_emit.lock();
            let now = Instant::now();
            if let Some(prev) = map.get_mut(&throttle_key) {
                let status_changed = prev.last_status != status;
                let exit_changed = prev.last_exit != exit_code;
                let grew = out_len.saturating_sub(prev.last_out_len) >= SHELL_EMIT_MIN_BYTES;
                let interval_ok = now.duration_since(prev.last_at) >= SHELL_EMIT_MIN_INTERVAL;
                let same_snapshot = !status_changed
                    && !exit_changed
                    && out_len == prev.last_out_len;
                if same_snapshot {
                    return;
                }
                if !is_terminal && !status_changed && !exit_changed && !grew && !interval_ok
                {
                    // Rate-limited: keep latest payload and schedule a deferred emit.
                    prev.pending_payload = Some(shell_payload);
                    prev.gen = prev.gen.wrapping_add(1);
                    let gen = prev.gen;
                    drop(map);
                    let inner_flush = Arc::clone(inner);
                    let key_flush = throttle_key;
                    thread::spawn(move || {
                        thread::sleep(SHELL_EMIT_MIN_INTERVAL);
                        let mut map = inner_flush.shell_emit.lock();
                        let Some(state) = map.get_mut(&key_flush) else {
                            return;
                        };
                        if state.gen != gen {
                            return; // superseded by a newer update
                        }
                        let Some(payload) = state.pending_payload.take() else {
                            return;
                        };
                        let out_len = payload
                            .get("output")
                            .and_then(|o| o.as_str())
                            .map(|s| s.len())
                            .unwrap_or(0);
                        let status = payload
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let exit = payload.get("exitCode").and_then(|c| c.as_i64());
                        state.last_at = Instant::now();
                        state.last_out_len = out_len;
                        state.last_status = status;
                        state.last_exit = exit;
                        drop(map);
                        Self::emit(&inner_flush, "agent-shell", payload);
                    });
                    return;
                }
            }

            if is_terminal {
                // Terminal: drop throttle entry so the map does not grow unbounded.
                map.remove(&throttle_key);
            } else {
                map.insert(
                    throttle_key,
                    ShellEmitState {
                        last_at: Instant::now(),
                        last_status: status.clone(),
                        last_out_len: out_len,
                        last_exit: exit_code,
                        pending_payload: None,
                        gen: 0,
                    },
                );
            }
        }

        Self::emit(inner, "agent-shell", shell_payload);
    }

    fn handle_server_request(inner: &Arc<Inner>, handle_id: &str, msg: &Value) {
        let method = msg
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let request_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let (client, permission_mode, session_hint) = {
            let agents = inner.agents.lock();
            match agents.get(handle_id) {
                Some(a) => (
                    Arc::clone(&a.client),
                    a.info.permission_mode,
                    a.info.session_id.clone(),
                ),
                None => {
                    // Agent not registered yet (race with spawn) — buffer for drain after insert.
                    inner
                        .early_requests
                        .lock()
                        .push((handle_id.to_string(), msg.clone()));
                    return;
                }
            }
        };

        let session_id = params
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
            .or(session_hint);

        match method.as_str() {
            "session/request_permission" => {
                let pending = build_tool_permission(
                    handle_id,
                    session_id.clone(),
                    request_id.clone(),
                    &params,
                );
                match decide_gate(permission_mode, &pending) {
                    GateDecision::Allow => {
                        let oid = pick_allow_option(&pending.options);
                        let _ = client.respond_result(
                            &request_id,
                            json!({ "outcome": { "outcome": "selected", "optionId": oid } }),
                        );
                    }
                    GateDecision::Deny => {
                        let oid = pick_reject_option(&pending.options, "reject-once");
                        let _ = client.respond_result(
                            &request_id,
                            json!({ "outcome": { "outcome": "selected", "optionId": oid } }),
                        );
                    }
                    GateDecision::Ask => {
                        Self::enqueue_permission(inner, handle_id, pending);
                    }
                }
            }
            "fs/read_text_file" => {
                // Reads are always fulfilled (Grok treats read-only tools as auto-safe).
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                match read_text_file(path, params.get("line"), params.get("limit")) {
                    Ok(content) => {
                        let _ = client.respond_result(&request_id, json!({ "content": content }));
                    }
                    Err(e) => {
                        let _ = client.respond_error(&request_id, -32000, &e);
                    }
                }
            }
            "fs/write_text_file" => {
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
                let content = params
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let pending = PendingPermission {
                    request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
                    handle_id: handle_id.to_string(),
                    session_id: session_id.clone(),
                    request_id: request_id.clone(),
                    kind: PermissionKind::FsWrite,
                    method: method.clone(),
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
                match decide_gate(permission_mode, &pending) {
                    GateDecision::Allow => match write_text_file(&path, &content) {
                        Ok(()) => {
                            let _ = client.respond_result(&request_id, Value::Null);
                        }
                        Err(e) => {
                            let _ = client.respond_error(&request_id, -32000, &e);
                        }
                    },
                    GateDecision::Deny => {
                        let _ = client.respond_error(
                            &request_id,
                            -32000,
                            "Denied by permission mode (dontAsk)",
                        );
                    }
                    GateDecision::Ask => {
                        Self::enqueue_permission(inner, handle_id, pending);
                    }
                }
            }
            other => {
                // Unknown client methods: reject so agent can fall back.
                let _ = client.respond_error(
                    &request_id,
                    -32601,
                    &format!("MarsBuild does not implement {other}"),
                );
            }
        }
    }

    fn enqueue_permission(inner: &Arc<Inner>, handle_id: &str, pending: PendingPermission) {
        let key = pending.request_key.clone();
        if let Ok(v) = serde_json::to_value(&pending) {
            Self::emit(inner, "agent-permission", v);
        }
        // Hold agents lock while recomputing count so concurrent enqueues cannot
        // write a stale pending_permission_count.
        let mut agents = inner.agents.lock();
        let count = {
            let mut map = inner.pending.lock();
            map.insert(key, pending);
            map.values().filter(|p| p.handle_id == handle_id).count() as u32
        };
        if let Some(a) = agents.get_mut(handle_id) {
            a.info.pending_permission_count = count;
            a.info.status = ManagedStatus::AwaitingPermission;
            Self::emit_status(inner, &a.info);
        }
    }

    /// Process server→client requests that arrived before agent registration.
    fn drain_early_requests(inner: &Arc<Inner>, handle_id: &str) {
        let early: Vec<Value> = {
            let mut q = inner.early_requests.lock();
            let mut take = Vec::new();
            q.retain(|(h, msg)| {
                if h == handle_id {
                    take.push(msg.clone());
                    false
                } else {
                    true
                }
            });
            take
        };
        for msg in early {
            Self::handle_server_request(inner, handle_id, &msg);
        }
    }

    pub fn resolve_permission(
        &self,
        req: ResolvePermissionRequest,
    ) -> Result<PendingPermission, String> {
        let mut pending_map = self.inner.pending.lock();
        let pending = pending_map
            .remove(&req.request_key)
            .ok_or_else(|| format!("unknown permission request {}", req.request_key))?;
        drop(pending_map);

        if pending.handle_id != req.handle_id {
            // put back
            self.inner
                .pending
                .lock()
                .insert(req.request_key.clone(), pending.clone());
            return Err("handle_id mismatch".into());
        }

        let client = {
            let agents = self.inner.agents.lock();
            match agents.get(&req.handle_id).map(|a| Arc::clone(&a.client)) {
                Some(c) => c,
                None => {
                    // Put back so a transient race does not drop the request forever.
                    self.inner
                        .pending
                        .lock()
                        .insert(req.request_key.clone(), pending);
                    return Err("agent gone".into());
                }
            }
        };

        let allow = is_allow_option(&req.option_id, &pending.options);

        match pending.kind {
            PermissionKind::ToolPermission => {
                if allow {
                    let _ = client.respond_result(
                        &pending.request_id,
                        json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": req.option_id,
                            }
                        }),
                    );
                } else {
                    // Prefer reject option id from request; fall back
                    let reject_id = pick_reject_option(&pending.options, &req.option_id);
                    let _ = client.respond_result(
                        &pending.request_id,
                        json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": reject_id,
                            }
                        }),
                    );
                }
            }
            PermissionKind::FsWrite => {
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
                    match write_text_file(path, content) {
                        Ok(()) => {
                            let _ = client.respond_result(&pending.request_id, Value::Null);
                        }
                        Err(e) => {
                            let _ = client.respond_error(&pending.request_id, -32000, &e);
                        }
                    }
                } else {
                    let _ = client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied file write in MarsBuild",
                    );
                }
            }
            PermissionKind::FsRead => {
                if allow {
                    let path = pending
                        .raw_params
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("");
                    match read_text_file(
                        path,
                        pending.raw_params.get("line"),
                        pending.raw_params.get("limit"),
                    ) {
                        Ok(content) => {
                            let _ = client
                                .respond_result(&pending.request_id, json!({ "content": content }));
                        }
                        Err(e) => {
                            let _ = client.respond_error(&pending.request_id, -32000, &e);
                        }
                    }
                } else {
                    let _ = client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied file read in MarsBuild",
                    );
                }
            }
            PermissionKind::Other => {
                if allow {
                    let _ = client.respond_result(&pending.request_id, Value::Null);
                } else {
                    let _ = client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied request in MarsBuild",
                    );
                }
            }
        }

        // Update counts / status (recompute under agents lock to avoid stale counts)
        {
            let mut agents = self.inner.agents.lock();
            let count = self
                .inner
                .pending
                .lock()
                .values()
                .filter(|p| p.handle_id == req.handle_id)
                .count() as u32;
            if let Some(a) = agents.get_mut(&req.handle_id) {
                a.info.pending_permission_count = count;
                if count == 0 && a.info.status == ManagedStatus::AwaitingPermission {
                    a.info.status = ManagedStatus::Running;
                }
                Self::emit_status(&self.inner, &a.info);
            }
        }

        if let Ok(v) = serde_json::to_value(&pending) {
            Self::emit(
                &self.inner,
                "agent-permission-resolved",
                json!({
                    "pending": v,
                    "optionId": req.option_id,
                    "allowed": allow,
                }),
            );
        }

        Ok(pending)
    }

    pub fn spawn(&self, req: SpawnRequest) -> Result<ManagedAgentInfo, String> {
        let cwd = req.cwd.trim().to_string();
        if cwd.is_empty() || !PathBuf::from(&cwd).is_dir() {
            return Err(format!("Invalid working directory: {cwd}"));
        }
        let permission_mode =
            PermissionMode::from_request(req.permission_mode, req.always_approve);
        let always_approve = permission_mode.spawns_always_approve();
        task_prefs::set_last_spawn_mode(permission_mode);
        let handle_id = Uuid::new_v4().to_string();
        let grok_bin = self.resolve_grok_bin()?;

        let mut extra = Vec::new();
        if let Some(model) = &req.model {
            if !model.is_empty() {
                extra.push("-m".into());
                extra.push(model.clone());
            }
        }

        let mut info = ManagedAgentInfo {
            handle_id: handle_id.clone(),
            session_id: None,
            cwd: cwd.clone(),
            pid: None,
            status: ManagedStatus::Starting,
            permission_mode,
            always_approve,
            model_id: req.model.clone(),
            last_error: None,
            title: req
                .prompt
                .as_ref()
                .map(|p| truncate(p, 80))
                .or_else(|| Some("New agent".into())),
            created_at: now_iso(),
            pending_permission_count: 0,
        };
        Self::emit_status(&self.inner, &info);

        let notify = Self::make_notify(&self.inner, &handle_id);
        let client = AcpClient::spawn_with_notify(&grok_bin, always_approve, &extra, notify)
            .map_err(|e| e.to_string())?;
        let client = Arc::new(client);
        info.pid = Some(client.pid());

        // Register early so server→client requests during handshake can resolve.
        self.inner.agents.lock().insert(
            handle_id.clone(),
            LiveAgent {
                info: info.clone(),
                client: Arc::clone(&client),
            },
        );
        Self::drain_early_requests(&self.inner, &handle_id);

        if let Err(e) = client.initialize() {
            return Err(Self::fail_registered_agent(
                &self.inner,
                &handle_id,
                &mut info,
                e.to_string(),
            ));
        }

        let result = match client.session_new(&cwd) {
            Ok(r) => r,
            Err(e) => {
                return Err(Self::fail_registered_agent(
                    &self.inner,
                    &handle_id,
                    &mut info,
                    e.to_string(),
                ));
            }
        };

        let session_id = match result.get("sessionId").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => {
                return Err(Self::fail_registered_agent(
                    &self.inner,
                    &handle_id,
                    &mut info,
                    "session/new missing sessionId".into(),
                ));
            }
        };

        info.session_id = Some(session_id.clone());
        task_prefs::set_permission_mode(&session_id, permission_mode);
        if let Some(m) = result
            .pointer("/models/currentModelId")
            .and_then(|v| v.as_str())
        {
            info.model_id = Some(m.to_string());
        }
        info.status = ManagedStatus::Ready;
        if let Some(a) = self.inner.agents.lock().get_mut(&handle_id) {
            a.info = info.clone();
        }
        Self::emit_status(&self.inner, &info);

        if let Some(prompt) = req.prompt.filter(|p| !p.trim().is_empty()) {
            self.dispatch_prompt(&handle_id, &session_id, prompt, client);
        }

        Ok(info)
    }

    pub fn attach(&self, req: AttachRequest) -> Result<ManagedAgentInfo, String> {
        let cwd = req.cwd.trim().to_string();
        let session_id = req.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("session_id required".into());
        }
        if cwd.is_empty() || !PathBuf::from(&cwd).is_dir() {
            return Err(format!("Invalid working directory: {cwd}"));
        }

        {
            let agents = self.inner.agents.lock();
            if let Some(existing) = agents.values().find(|a| {
                a.info.session_id.as_deref() == Some(session_id.as_str())
                    && !matches!(
                        a.info.status,
                        ManagedStatus::Stopped | ManagedStatus::Error
                    )
            }) {
                return Ok(existing.info.clone());
            }
        }

        // Explicit request wins; otherwise restore this task's saved mode.
        let permission_mode = match (req.permission_mode, req.always_approve) {
            (Some(m), _) => m,
            (None, Some(true)) => PermissionMode::BypassPermissions,
            (None, Some(false)) | (None, None) => task_prefs::get_permission_mode(&session_id)
                .unwrap_or(PermissionMode::Default),
        };
        let always_approve = permission_mode.spawns_always_approve();
        task_prefs::set_permission_mode(&session_id, permission_mode);
        let handle_id = Uuid::new_v4().to_string();
        let grok_bin = self.resolve_grok_bin()?;

        let mut info = ManagedAgentInfo {
            handle_id: handle_id.clone(),
            session_id: Some(session_id.clone()),
            cwd: cwd.clone(),
            pid: None,
            status: ManagedStatus::Starting,
            permission_mode,
            always_approve,
            model_id: None,
            last_error: None,
            title: Some(format!(
                "Attached {}",
                &session_id[..session_id.len().min(8)]
            )),
            created_at: now_iso(),
            pending_permission_count: 0,
        };
        Self::emit_status(&self.inner, &info);

        let notify = Self::make_notify(&self.inner, &handle_id);
        let client = AcpClient::spawn_with_notify(&grok_bin, always_approve, &[], notify)
            .map_err(|e| e.to_string())?;
        let client = Arc::new(client);
        info.pid = Some(client.pid());

        self.inner.agents.lock().insert(
            handle_id.clone(),
            LiveAgent {
                info: info.clone(),
                client: Arc::clone(&client),
            },
        );
        Self::drain_early_requests(&self.inner, &handle_id);

        if let Err(e) = client.initialize() {
            return Err(Self::fail_registered_agent(
                &self.inner,
                &handle_id,
                &mut info,
                e.to_string(),
            ));
        }
        let result = match client.session_load(&session_id, &cwd) {
            Ok(r) => r,
            Err(e) => {
                return Err(Self::fail_registered_agent(
                    &self.inner,
                    &handle_id,
                    &mut info,
                    e.to_string(),
                ));
            }
        };

        if let Some(m) = result
            .pointer("/models/currentModelId")
            .and_then(|v| v.as_str())
        {
            info.model_id = Some(m.to_string());
        }
        info.status = ManagedStatus::Ready;
        if let Some(a) = self.inner.agents.lock().get_mut(&handle_id) {
            a.info = info.clone();
        }
        Self::emit_status(&self.inner, &info);

        Ok(info)
    }

    pub fn prompt(&self, handle_id: &str, text: &str) -> Result<Value, String> {
        if text.trim().is_empty() {
            return Err("prompt is empty".into());
        }
        let (session_id, client) = {
            let agents = self.inner.agents.lock();
            let agent = agents
                .get(handle_id)
                .ok_or_else(|| format!("unknown handle {handle_id}"))?;
            if matches!(
                agent.info.status,
                ManagedStatus::Stopped
                    | ManagedStatus::Error
                    | ManagedStatus::Starting
                    | ManagedStatus::AwaitingPermission
            ) {
                return Err(format!("agent not ready ({:?})", agent.info.status));
            }
            let sid = agent
                .info
                .session_id
                .clone()
                .ok_or_else(|| "agent has no session_id".to_string())?;
            (sid, Arc::clone(&agent.client))
        };

        self.dispatch_prompt(handle_id, &session_id, text.to_string(), client);
        Ok(json!({
            "accepted": true,
            "handleId": handle_id,
            "sessionId": session_id,
        }))
    }

    fn dispatch_prompt(
        &self,
        handle_id: &str,
        session_id: &str,
        text: String,
        client: Arc<AcpClient>,
    ) {
        {
            let mut agents = self.inner.agents.lock();
            // Recompute from pending map so we don't race a just-enqueued permission.
            let pending_count = self
                .inner
                .pending
                .lock()
                .values()
                .filter(|p| p.handle_id == handle_id)
                .count() as u32;
            if let Some(a) = agents.get_mut(handle_id) {
                a.info.pending_permission_count = pending_count;
                if pending_count == 0 {
                    a.info.status = ManagedStatus::Running;
                }
                if a.info
                    .title
                    .as_ref()
                    .map(|t| t == "New agent" || t.starts_with("Attached "))
                    .unwrap_or(true)
                {
                    a.info.title = Some(truncate(&text, 80));
                }
                Self::emit_status(&self.inner, &a.info);
            }
        }

        let inner = Arc::clone(&self.inner);
        let handle_id = handle_id.to_string();
        let session_id = session_id.to_string();

        thread::spawn(move || {
            let result = client.session_prompt(&session_id, &text);
            let mut agents = inner.agents.lock();
            if let Some(a) = agents.get_mut(&handle_id) {
                match &result {
                    Ok(r) => {
                        if a.info.pending_permission_count == 0 {
                            a.info.status = ManagedStatus::Ready;
                        }
                        a.info.last_error = None;
                        Self::emit(
                            &inner,
                            "agent-prompt-complete",
                            json!({
                                "handleId": handle_id,
                                "sessionId": session_id,
                                "result": r,
                            }),
                        );
                    }
                    Err(e) => {
                        if a.info.pending_permission_count == 0 {
                            a.info.status = ManagedStatus::Ready;
                        }
                        a.info.last_error = Some(e.to_string());
                        Self::emit(
                            &inner,
                            "agent-prompt-complete",
                            json!({
                                "handleId": handle_id,
                                "sessionId": session_id,
                                "error": e.to_string(),
                            }),
                        );
                    }
                }
                Self::emit_status(&inner, &a.info);
            }
        });
    }

    pub fn stop(&self, handle_id: &str) -> Result<ManagedAgentInfo, String> {
        // Drop shell throttle entries for this agent.
        {
            let prefix = format!("{handle_id}:");
            let mut map = self.inner.shell_emit.lock();
            map.retain(|k, _| !k.starts_with(&prefix));
        }

        let cancelled: Vec<PendingPermission> = {
            let mut pending = self.inner.pending.lock();
            let keys: Vec<_> = pending
                .iter()
                .filter(|(_, p)| p.handle_id == handle_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| pending.remove(&k))
                .collect()
        };

        let agent = {
            let mut agents = self.inner.agents.lock();
            agents
                .remove(handle_id)
                .ok_or_else(|| format!("unknown handle {handle_id}"))?
        };

        for p in cancelled {
            match p.kind {
                PermissionKind::ToolPermission => {
                    let _ = agent.client.respond_result(
                        &p.request_id,
                        json!({ "outcome": { "outcome": "cancelled" } }),
                    );
                }
                _ => {
                    let _ = agent
                        .client
                        .respond_error(&p.request_id, -32000, "Session stopped");
                }
            }
        }

        agent.client.kill().map_err(|e| e.to_string())?;

        let mut info = agent.info;
        info.status = ManagedStatus::Stopped;
        info.pid = None;
        info.pending_permission_count = 0;
        Self::emit_status(&self.inner, &info);
        Ok(info)
    }
}

fn build_tool_permission(
    handle_id: &str,
    session_id: Option<String>,
    request_id: Value,
    params: &Value,
) -> PendingPermission {
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = tool
        .get("title")
        .and_then(|t| t.as_str())
        .or_else(|| tool.get("toolCallId").and_then(|t| t.as_str()))
        .unwrap_or("Tool permission")
        .to_string();
    let detail = tool
        .get("rawInput")
        .map(|r| r.to_string())
        .or_else(|| {
            tool.get("locations")
                .and_then(|l| l.as_array())
                .and_then(|a| a.first())
                .and_then(|x| x.get("path"))
                .and_then(|p| p.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    let options = params
        .get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    Some(PermissionOption {
                        option_id: o.get("optionId")?.as_str()?.to_string(),
                        name: o
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("Option")
                            .to_string(),
                        kind: o
                            .get("kind")
                            .and_then(|k| k.as_str())
                            .unwrap_or("")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_else(|| {
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
        });

    let risk = if title.to_lowercase().contains("bash")
        || title.to_lowercase().contains("terminal")
        || title.to_lowercase().contains("execute")
    {
        "high".into()
    } else if title.to_lowercase().contains("write")
        || title.to_lowercase().contains("edit")
        || title.to_lowercase().contains("replace")
    {
        "medium".into()
    } else {
        "low".into()
    };

    PendingPermission {
        request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
        handle_id: handle_id.to_string(),
        session_id,
        request_id,
        kind: PermissionKind::ToolPermission,
        method: "session/request_permission".into(),
        title,
        detail: truncate(&detail, 400),
        risk,
        options,
        raw_params: params.clone(),
        created_at_ms: now_ms(),
    }
}

fn request_id_key(id: &Value) -> String {
    match id {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Map Grok-style permission mode → host gate decision for one pending request.
fn decide_gate(mode: PermissionMode, pending: &PendingPermission) -> GateDecision {
    match mode {
        PermissionMode::BypassPermissions => GateDecision::Allow,
        PermissionMode::DontAsk => GateDecision::Deny,
        PermissionMode::Default => GateDecision::Ask,
        PermissionMode::AcceptEdits => {
            if is_edit_permission(pending) {
                GateDecision::Allow
            } else {
                GateDecision::Ask
            }
        }
    }
}

/// Heuristic: file-write / edit tools that `acceptEdits` should auto-approve.
fn is_edit_permission(pending: &PendingPermission) -> bool {
    if matches!(pending.kind, PermissionKind::FsWrite) {
        return true;
    }
    if matches!(pending.kind, PermissionKind::FsRead) {
        return false;
    }
    let title = pending.title.to_lowercase();
    let detail = pending.detail.to_lowercase();
    let blob = format!("{title} {detail}");
    // Shell / terminal never counts as an "edit".
    if title.contains("bash")
        || title.contains("shell")
        || title.contains("terminal")
        || title.contains("execute")
        || detail.contains("\"command\"")
    {
        return false;
    }
    const EDIT_KEYS: &[&str] = &[
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
    ];
    EDIT_KEYS.iter().any(|k| blob.contains(k))
}

/// Pick an allow option for **automatic** policy Allow decisions.
/// Prefer one-shot allow so we never silently grant session-wide always-allow.
fn pick_allow_option(options: &[PermissionOption]) -> String {
    // 1) explicit once
    if let Some(o) = options.iter().find(|o| {
        o.kind.contains("allow_once")
            || o.option_id == "allow-once"
            || (o.option_id.contains("allow") && o.option_id.contains("once"))
    }) {
        return o.option_id.clone();
    }
    // 2) any allow that is not "always"
    if let Some(o) = options.iter().find(|o| {
        let is_allow = o.kind.contains("allow") || o.option_id.contains("allow");
        let is_always = o.kind.contains("always") || o.option_id.contains("always");
        is_allow && !is_always
    }) {
        return o.option_id.clone();
    }
    // 3) last resort: whatever allow the agent offered (may be always)
    options
        .iter()
        .find(|o| o.kind.contains("allow") || o.option_id.contains("allow"))
        .map(|o| o.option_id.clone())
        .unwrap_or_else(|| "allow-once".into())
}

fn pick_reject_option(options: &[PermissionOption], chosen: &str) -> String {
    if options.iter().any(|o| o.option_id == chosen) {
        return chosen.to_string();
    }
    options
        .iter()
        .find(|o| o.kind.contains("reject") || o.option_id.contains("reject"))
        .map(|o| o.option_id.clone())
        .unwrap_or_else(|| "reject-once".into())
}

fn is_allow_option(option_id: &str, options: &[PermissionOption]) -> bool {
    if let Some(o) = options.iter().find(|o| o.option_id == option_id) {
        return o.kind.contains("allow") || option_id.contains("allow");
    }
    option_id.contains("allow")
}

fn risk_for_path(path: &str) -> String {
    let lower = path.to_lowercase();
    let sensitive = [
        ".env",
        "id_rsa",
        "id_ed25519",
        "credentials",
        "secret",
        ".pem",
        "keystore",
        "wallet",
    ];
    if sensitive.iter().any(|k| lower.contains(k)) {
        return "high".into();
    }
    if lower.contains("/tmp/")
        || lower.contains("\\tmp\\")
        || lower.contains("/temp/")
        || lower.contains("\\temp\\")
    {
        return "low".into();
    }
    "medium".into()
}

fn read_text_file(path: &str, line: Option<&Value>, limit: Option<&Value>) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let start = line.and_then(|v| v.as_u64()).unwrap_or(0);
    let lim = limit.and_then(|v| v.as_u64());
    if start == 0 && lim.is_none() {
        return Ok(raw);
    }
    let lines: Vec<&str> = raw.lines().collect();
    let from = if start == 0 {
        0
    } else {
        (start as usize).saturating_sub(1).min(lines.len())
    };
    let slice = if let Some(n) = lim {
        let end = from.saturating_add(n as usize).min(lines.len());
        &lines[from..end]
    } else {
        &lines[from..]
    };
    Ok(slice.join("\n"))
}

fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if let Some(parent) = PathBuf::from(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

/// Resolve an executable path, trying Windows extensions (`.exe`, …) when needed.
fn first_existing_executable(base: PathBuf) -> Option<String> {
    if base.is_file() {
        return Some(base.display().to_string());
    }
    #[cfg(windows)]
    {
        // `Path::is_file` does not apply PATHEXT — try common extensions explicitly.
        if base.extension().is_none() {
            for ext in ["exe", "cmd", "bat", "com"] {
                let candidate = base.with_extension(ext);
                if candidate.is_file() {
                    return Some(candidate.display().to_string());
                }
            }
        }
    }
    None
}

fn find_grok_bin() -> Option<String> {
    if let Ok(p) = std::env::var("GROK_BIN") {
        if let Some(found) = first_existing_executable(PathBuf::from(&p)) {
            return Some(found);
        }
    }

    // Prefer GROK_HOME/bin (custom installs; common on Windows).
    if let Ok(home) = std::env::var("GROK_HOME") {
        if let Some(found) =
            first_existing_executable(PathBuf::from(home).join("bin").join("grok"))
        {
            return Some(found);
        }
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(found) = first_existing_executable(dir.join("grok")) {
                return Some(found);
            }
        }
    }

    let home = dirs::home_dir()?;
    first_existing_executable(home.join(".grok").join("bin").join("grok"))
}

fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// UTC timestamp as RFC 3339 / ISO 8601 (`2024-07-20T12:00:00.123Z`).
fn now_iso() -> String {
    let ms = now_ms();
    let secs = ms / 1000;
    let millis = ms % 1000;
    let (y, mo, d, h, mi, s) = unix_secs_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Convert Unix seconds to (year, month, day, hour, min, sec) in UTC.
/// Uses Howard Hinnant's civil-from-days algorithm (no chrono dependency).
fn unix_secs_to_utc(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let ss = (secs % 60) as u32;
    let mins = secs / 60;
    let mi = (mins % 60) as u32;
    let hours = mins / 60;
    let h = (hours % 24) as u32;
    let days = (hours / 24) as i64;

    // civil_from_days: days since Unix epoch → Y-M-D
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (if mo <= 2 { y + 1 } else { y }) as i32;
    (y, mo, d, h, mi, ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(id: &str, kind: &str) -> PermissionOption {
        PermissionOption {
            option_id: id.into(),
            name: id.into(),
            kind: kind.into(),
        }
    }

    #[test]
    fn pick_allow_prefers_once_over_always() {
        let options = vec![
            opt("allow-always", "allow_always"),
            opt("allow-once", "allow_once"),
        ];
        assert_eq!(pick_allow_option(&options), "allow-once");
    }

    #[test]
    fn pick_allow_skips_always_when_other_allow_exists() {
        let options = vec![opt("allow-always", "allow_always"), opt("allow", "allow")];
        assert_eq!(pick_allow_option(&options), "allow");
    }

    #[test]
    fn pick_allow_falls_back_to_always_if_only_option() {
        let options = vec![opt("allow-always", "allow_always")];
        assert_eq!(pick_allow_option(&options), "allow-always");
    }

    #[test]
    fn pick_allow_default_when_empty() {
        assert_eq!(pick_allow_option(&[]), "allow-once");
    }

    #[test]
    fn is_allow_detects_kind() {
        let options = vec![opt("x", "allow_once"), opt("y", "reject_once")];
        assert!(is_allow_option("x", &options));
        assert!(!is_allow_option("y", &options));
    }

    fn pending(kind: PermissionKind, title: &str, detail: &str) -> PendingPermission {
        PendingPermission {
            request_key: "t".into(),
            handle_id: "h".into(),
            session_id: None,
            request_id: Value::Null,
            kind,
            method: "m".into(),
            title: title.into(),
            detail: detail.into(),
            risk: "medium".into(),
            options: vec![],
            raw_params: Value::Null,
            created_at_ms: 0,
        }
    }

    #[test]
    fn decide_gate_modes() {
        let write = pending(PermissionKind::FsWrite, "Write file", "/tmp/a.rs");
        let bash = pending(
            PermissionKind::ToolPermission,
            "Bash",
            r#"{"command":"rm -rf /"}"#,
        );
        let edit_tool = pending(
            PermissionKind::ToolPermission,
            "search_replace",
            "src/main.rs",
        );

        assert_eq!(
            decide_gate(PermissionMode::BypassPermissions, &bash),
            GateDecision::Allow
        );
        assert_eq!(
            decide_gate(PermissionMode::DontAsk, &write),
            GateDecision::Deny
        );
        assert_eq!(
            decide_gate(PermissionMode::Default, &write),
            GateDecision::Ask
        );
        assert_eq!(
            decide_gate(PermissionMode::AcceptEdits, &write),
            GateDecision::Allow
        );
        assert_eq!(
            decide_gate(PermissionMode::AcceptEdits, &edit_tool),
            GateDecision::Allow
        );
        assert_eq!(
            decide_gate(PermissionMode::AcceptEdits, &bash),
            GateDecision::Ask
        );
    }

    #[test]
    fn from_request_legacy_always_approve() {
        assert_eq!(
            PermissionMode::from_request(None, Some(true)),
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            PermissionMode::from_request(Some(PermissionMode::AcceptEdits), Some(true)),
            PermissionMode::AcceptEdits
        );
        assert_eq!(
            PermissionMode::from_request(None, None),
            PermissionMode::Default
        );
    }
}
