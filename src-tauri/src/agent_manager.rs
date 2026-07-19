//! Multi-agent process manager: spawn / attach / prompt / stop / permissions via ACP.

use crate::acp::{AcpClient, NotifyFn};
use crate::policy::{
    self, EvalInput, EvalKind, PolicyConfig, PolicyDecision, PolicyPreset, PolicyStore,
    ProjectBinding, ResolvedPolicy,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentInfo {
    pub handle_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: ManagedStatus,
    pub always_approve: bool,
    pub model_id: Option<String>,
    pub last_error: Option<String>,
    pub title: Option<String>,
    pub created_at: String,
    pub pending_permission_count: u32,
    /// Effective policy preset for this agent (from project bind or default).
    pub policy_preset: Option<PolicyPreset>,
    /// `default` | `project` | `inherited`
    pub policy_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub cwd: String,
    pub prompt: Option<String>,
    pub always_approve: Option<bool>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachRequest {
    pub session_id: String,
    pub cwd: String,
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
    /// Effective policy for permission decisions (project-bound or default).
    policy: PolicyConfig,
}

struct Inner {
    app: Mutex<Option<AppHandle>>,
    agents: Mutex<HashMap<String, LiveAgent>>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    /// Server→client requests that arrived before the agent was registered.
    early_requests: Mutex<Vec<(String, Value)>>,
    grok_bin: Mutex<Option<String>>,
    store: Mutex<PolicyStore>,
}

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
                store: Mutex::new(PolicyStore::load()),
            }),
        }
    }

    pub fn get_policy(&self) -> PolicyConfig {
        let store = self.inner.store.lock();
        PolicyConfig::from_preset(store.default_preset)
    }

    pub fn get_policy_store(&self) -> PolicyStore {
        self.inner.store.lock().clone()
    }

    pub fn resolve_policy(&self, cwd: Option<String>) -> ResolvedPolicy {
        self.inner.store.lock().resolve(cwd.as_deref())
    }

    pub fn set_policy(&self, config: PolicyConfig) -> Result<PolicyConfig, String> {
        // Treat as setting global default from full config; surface disk errors.
        let resolved = self.set_default_preset(config.preset)?;
        Ok(resolved.config)
    }

    pub fn set_policy_preset(&self, preset: PolicyPreset) -> Result<PolicyConfig, String> {
        let resolved = self.set_default_preset(preset)?;
        Ok(resolved.config)
    }

    pub fn set_default_preset(&self, preset: PolicyPreset) -> Result<ResolvedPolicy, String> {
        let resolved = {
            let mut store = self.inner.store.lock();
            store.set_default(preset)?
        };
        // Agents on default (no project bind) pick up the new preset.
        self.apply_policy_to_agents_for_cwd(&resolved);
        self.emit_store_changed();
        if let Ok(v) = serde_json::to_value(&resolved) {
            Self::emit(&self.inner, "policy-changed", v);
        }
        Ok(resolved)
    }

    pub fn bind_project_policy(
        &self,
        cwd: String,
        preset: PolicyPreset,
    ) -> Result<ResolvedPolicy, String> {
        let resolved = {
            let mut store = self.inner.store.lock();
            store.bind_project(&cwd, preset)?
        };
        self.apply_policy_to_agents_for_cwd(&resolved);
        self.emit_store_changed();
        if let Ok(v) = serde_json::to_value(&resolved) {
            Self::emit(&self.inner, "policy-changed", v);
        }
        Ok(resolved)
    }

    pub fn unbind_project_policy(&self, cwd: String) -> Result<ResolvedPolicy, String> {
        let resolved = {
            let mut store = self.inner.store.lock();
            store.unbind_project(&cwd)?
        };
        self.apply_policy_to_agents_for_cwd(&resolved);
        self.emit_store_changed();
        if let Ok(v) = serde_json::to_value(&resolved) {
            Self::emit(&self.inner, "policy-changed", v);
        }
        Ok(resolved)
    }

    pub fn list_project_bindings(&self) -> Vec<ProjectBinding> {
        self.inner.store.lock().list_bindings()
    }

    fn emit_store_changed(&self) {
        let store = self.inner.store.lock().clone();
        if let Ok(v) = serde_json::to_value(&store) {
            Self::emit(&self.inner, "policy-store-changed", v);
        }
    }

    /// Re-resolve policy for every live agent (after bind/unbind/default change).
    ///
    /// Does **not** change `info.always_approve`: that flag is the process spawn
    /// flag (`grok --always-approve`) and stays true until the agent is restarted.
    /// Runtime FS/tool gates still use `agent.policy`.
    fn apply_policy_to_agents_for_cwd(&self, _resolved: &ResolvedPolicy) {
        let store = self.inner.store.lock().clone();
        let mut agents = self.inner.agents.lock();
        for agent in agents.values_mut() {
            let r = store.resolve(Some(&agent.info.cwd));
            agent.policy = r.config.clone();
            agent.info.policy_preset = Some(r.config.preset);
            agent.info.policy_source = Some(policy_source_str(&r.source).into());
            Self::emit_status(&self.inner, &agent.info);
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

    pub fn list_policy_presets(&self) -> Vec<PolicyConfig> {
        policy::list_presets()
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

            if method == "session/update" {
                Self::emit(&inner, "agent-update", payload.clone());
                Self::maybe_emit_shell(&inner, &handle_id, &session_id, &params);
            } else if !method.is_empty() {
                Self::emit(&inner, "agent-notification", payload);
            }
        })
    }

    fn maybe_emit_shell(
        inner: &Inner,
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

        Self::emit(
            inner,
            "agent-shell",
            json!({
                "handleId": handle_id,
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "command": command,
                "description": description,
                "status": status,
                "output": output,
                "exitCode": exit_code,
                "ts": now_ms(),
            }),
        );
    }

    fn handle_server_request(inner: &Arc<Inner>, handle_id: &str, msg: &Value) {
        let method = msg
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let request_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let (client, always_approve, session_hint, policy) = {
            let agents = inner.agents.lock();
            match agents.get(handle_id) {
                Some(a) => (
                    Arc::clone(&a.client),
                    a.info.always_approve,
                    a.info.session_id.clone(),
                    a.policy.clone(),
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
                let decision = if always_approve {
                    PolicyDecision::Allow
                } else {
                    evaluate_pending(&policy, &pending)
                };
                match decision {
                    PolicyDecision::Allow => {
                        let oid = pick_allow_option(&pending.options);
                        let _ = client.respond_result(
                            &request_id,
                            json!({ "outcome": { "outcome": "selected", "optionId": oid } }),
                        );
                        Self::emit_policy_action(inner, &pending, "allow", "policy");
                    }
                    PolicyDecision::Deny => {
                        let oid = pick_reject_option(&pending.options, "reject-once");
                        let _ = client.respond_result(
                            &request_id,
                            json!({ "outcome": { "outcome": "selected", "optionId": oid } }),
                        );
                        Self::emit_policy_action(inner, &pending, "deny", "policy");
                    }
                    PolicyDecision::Ask => {
                        Self::enqueue_permission(inner, handle_id, pending);
                    }
                }
            }
            "fs/read_text_file" => {
                let path = params
                    .get("path")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                let decision = if always_approve {
                    PolicyDecision::Allow
                } else {
                    policy::evaluate(
                        &policy,
                        &EvalInput {
                            kind: EvalKind::FsRead,
                            title: "Read file",
                            detail: path,
                            path: Some(path),
                            command: None,
                            raw_blob: path,
                        },
                    )
                };
                match decision {
                    PolicyDecision::Allow => {
                        match read_text_file(path, params.get("line"), params.get("limit")) {
                            Ok(content) => {
                                let _ =
                                    client.respond_result(&request_id, json!({ "content": content }));
                            }
                            Err(e) => {
                                let _ = client.respond_error(&request_id, -32000, &e);
                            }
                        }
                    }
                    PolicyDecision::Deny => {
                        let _ = client.respond_error(
                            &request_id,
                            -32000,
                            "MarsBuild policy denied reading this path",
                        );
                        let pending = PendingPermission {
                            request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
                            handle_id: handle_id.to_string(),
                            session_id: session_id.clone(),
                            request_id: request_id.clone(),
                            kind: PermissionKind::FsRead,
                            method: method.clone(),
                            title: "Read file".into(),
                            detail: path.to_string(),
                            risk: risk_for_path(path),
                            options: vec![],
                            raw_params: params.clone(),
                            created_at_ms: now_ms(),
                        };
                        Self::emit_policy_action(inner, &pending, "deny", "policy");
                    }
                    PolicyDecision::Ask => {
                        // Sensitive / gated reads go to the permission gate.
                        let pending = PendingPermission {
                            request_key: format!("{handle_id}:{}", request_id_key(&request_id)),
                            handle_id: handle_id.to_string(),
                            session_id: session_id.clone(),
                            request_id: request_id.clone(),
                            kind: PermissionKind::FsRead,
                            method: method.clone(),
                            title: "Read file".into(),
                            detail: path.to_string(),
                            risk: risk_for_path(path),
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
                        Self::enqueue_permission(inner, handle_id, pending);
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

                let decision = if always_approve {
                    PolicyDecision::Allow
                } else {
                    evaluate_pending(&policy, &pending)
                };

                match decision {
                    PolicyDecision::Allow => match write_text_file(&path, &content) {
                        Ok(()) => {
                            let _ = client.respond_result(&request_id, Value::Null);
                            Self::emit_policy_action(inner, &pending, "allow", "policy");
                        }
                        Err(e) => {
                            let _ = client.respond_error(&request_id, -32000, &e);
                        }
                    },
                    PolicyDecision::Deny => {
                        let _ = client.respond_error(
                            &request_id,
                            -32000,
                            "Denied by MarsBuild risk policy",
                        );
                        Self::emit_policy_action(inner, &pending, "deny", "policy");
                    }
                    PolicyDecision::Ask => {
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

    fn emit_policy_action(
        inner: &Inner,
        pending: &PendingPermission,
        action: &str,
        source: &str,
    ) {
        if let Ok(v) = serde_json::to_value(pending) {
            Self::emit(
                inner,
                "policy-action",
                json!({
                    "action": action,
                    "source": source,
                    "pending": v,
                    "ts": now_ms(),
                }),
            );
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
        let resolved = self.inner.store.lock().resolve(Some(&cwd));
        let agent_policy = resolved.config.clone();
        // Prefer explicit request flag; otherwise project/default policy (Trusted → yolo).
        let always_approve = req
            .always_approve
            .unwrap_or_else(|| agent_policy.always_approve_flag());
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
            policy_preset: Some(agent_policy.preset),
            policy_source: Some(policy_source_str(&resolved.source).into()),
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
                policy: agent_policy,
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

        let resolved = self.inner.store.lock().resolve(Some(&cwd));
        let agent_policy = resolved.config.clone();
        let always_approve = req
            .always_approve
            .unwrap_or_else(|| agent_policy.always_approve_flag());
        let handle_id = Uuid::new_v4().to_string();
        let grok_bin = self.resolve_grok_bin()?;

        let mut info = ManagedAgentInfo {
            handle_id: handle_id.clone(),
            session_id: Some(session_id.clone()),
            cwd: cwd.clone(),
            pid: None,
            status: ManagedStatus::Starting,
            always_approve,
            model_id: None,
            last_error: None,
            title: Some(format!(
                "Attached {}",
                &session_id[..session_id.len().min(8)]
            )),
            created_at: now_iso(),
            pending_permission_count: 0,
            policy_preset: Some(agent_policy.preset),
            policy_source: Some(policy_source_str(&resolved.source).into()),
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
                policy: agent_policy,
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

fn policy_source_str(source: &policy::PolicySource) -> &'static str {
    match source {
        policy::PolicySource::Default => "default",
        policy::PolicySource::Project => "project",
        policy::PolicySource::Inherited => "inherited",
    }
}

fn evaluate_pending(policy: &PolicyConfig, pending: &PendingPermission) -> PolicyDecision {
    let raw = pending.raw_params.to_string();
    let path = pending
        .raw_params
        .get("path")
        .and_then(|p| p.as_str())
        .or(Some(pending.detail.as_str()));
    let command = pending
        .raw_params
        .pointer("/toolCall/rawInput/command")
        .and_then(|c| c.as_str())
        .or_else(|| {
            pending
                .raw_params
                .pointer("/rawInput/command")
                .and_then(|c| c.as_str())
        });
    policy::evaluate(
        policy,
        &EvalInput {
            kind: match pending.kind {
                PermissionKind::ToolPermission => EvalKind::ToolPermission,
                PermissionKind::FsWrite => EvalKind::FsWrite,
                PermissionKind::FsRead => EvalKind::FsRead,
                PermissionKind::Other => EvalKind::Other,
            },
            title: &pending.title,
            detail: &pending.detail,
            path,
            command,
            raw_blob: &raw,
        },
    )
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
    // Keep in sync with policy::path_looks_sensitive keywords.
    if policy::path_looks_sensitive(path) {
        "high".into()
    } else {
        let p = path.to_lowercase();
        if p.contains("/tmp/") || p.starts_with("/tmp") {
            "low".into()
        } else {
            "medium".into()
        }
    }
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

fn find_grok_bin() -> Option<String> {
    if let Ok(p) = std::env::var("GROK_BIN") {
        if PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("grok");
            if candidate.is_file() {
                return Some(candidate.display().to_string());
            }
        }
    }
    let home = dirs::home_dir()?;
    let candidate = home.join(".grok/bin/grok");
    if candidate.is_file() {
        return Some(candidate.display().to_string());
    }
    None
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
}
