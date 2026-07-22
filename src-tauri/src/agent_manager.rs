//! Multi-agent process manager: spawn / attach / prompt / stop / permissions via ACP.
//!
//! Permission modes mirror Grok Build's prompt policy:
//! - `default` — ask the user on gated ops (Normal / ask)
//! - `acceptEdits` — auto-allow file edits; ask for shell / other tools
//! - `auto` — allow safe tools; ask on high-risk shell (spawn `--permission-mode auto`)
//! - `bypassPermissions` — auto-allow (spawn with `grok --always-approve`)
//! - `dontAsk` — auto-deny anything that would have prompted
//!
//! Process flags apply on spawn/attach. Live Mode changes update only this
//! host's `decide_gate` (ACP permission responses). Do not inject `/auto` or
//! `/always-approve` as `session/prompt` — those are local TUI toggles in Grok
//! Build; forwarding them over ACP starts a turn and can run tools.

use crate::acp::{AcpClient, NotifyFn};
use crate::agent_fs::{read_text_file, write_text_file};
use crate::agent_runtime::{find_grok_bin, now_iso, now_ms, truncate_text};
use crate::agent_types::{
    AttachRequest, ManagedAgentInfo, ManagedStatus, PendingPermission, PermissionKind,
    PermissionMode, PermissionOption, ResolvePermissionRequest, SpawnRequest,
};
use crate::permission_policy::{
    build_tool_permission, decide_gate, is_allow_option, pick_allow_option, pick_reject_option,
    request_id_key, risk_for_path, GateDecision,
};
use crate::shell_stream::ShellStream;
use crate::task_prefs;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

struct LiveAgent {
    info: ManagedAgentInfo,
    client: Arc<AcpClient>,
}

struct Inner {
    app: Mutex<Option<AppHandle>>,
    agents: Mutex<HashMap<String, LiveAgent>>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    /// Server→client requests that arrived before the agent was registered.
    early_requests: Mutex<Vec<(String, Value)>>,
    grok_bin: Mutex<Option<String>>,
    shell_stream: ShellStream,
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
                shell_stream: ShellStream::default(),
            }),
        }
    }

    /// Change host-side permission mode for a live agent.
    ///
    /// Updates MarsBuild's ACP auto-response and reconciles pending requests
    /// that the new mode would no longer ask about. Does not prompt the agent
    /// (Grok Build Mode toggles are local; see frontend `handleSessionModeChange`).
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
            let is_response_shape = msg.get("result").is_some() || msg.get("error").is_some();

            if method == "_marsbuild/transport_closed" {
                let reason = msg
                    .pointer("/params/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("ACP transport closed");
                Self::handle_transport_closed(&inner, &handle_id, reason);
                return;
            }

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

    fn handle_transport_closed(inner: &Arc<Inner>, handle_id: &str, reason: &str) {
        inner.shell_stream.clear_handle(handle_id);
        let cancelled: Vec<PendingPermission> = {
            let mut pending = inner.pending.lock();
            let keys: Vec<String> = pending
                .iter()
                .filter(|(_, item)| item.handle_id == handle_id)
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| pending.remove(&key))
                .collect()
        };

        for item in cancelled {
            if let Ok(value) = serde_json::to_value(&item) {
                Self::emit(
                    inner,
                    "agent-permission-resolved",
                    json!({
                        "pending": value,
                        "optionId": "transport-closed",
                        "allowed": false,
                    }),
                );
            }
        }

        let updated = {
            let mut agents = inner.agents.lock();
            agents.get_mut(handle_id).and_then(|agent| {
                if matches!(
                    agent.info.status,
                    ManagedStatus::Stopped | ManagedStatus::Error
                ) {
                    return None;
                }
                agent.info.status = ManagedStatus::Error;
                agent.info.pid = None;
                agent.info.pending_permission_count = 0;
                agent.info.last_error = Some(reason.to_string());
                Some(agent.info.clone())
            })
        };
        if let Some(info) = updated {
            Self::emit_status(inner, &info);
        }
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
        let title = update.get("title").and_then(|t| t.as_str()).unwrap_or("");

        // Keep in sync with frontend `isShellToolUpdate` in format.ts.
        let is_shell = tool_meta_name == "run_terminal_command"
            || tool_kind == "execute"
            || title.contains("run_terminal")
            || title.to_lowercase().contains("execute `");

        if !is_shell && kind == "tool_call" {
            // still not shell
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

        let emit_inner = Arc::clone(inner);
        inner.shell_stream.publish(
            shell_payload,
            Arc::new(move |payload| Self::emit(&emit_inner, "agent-shell", payload)),
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
                let path = params.get("path").and_then(|p| p.as_str()).unwrap_or("");
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

    fn start_client(
        &self,
        mut info: ManagedAgentInfo,
        extra_args: &[String],
    ) -> Result<(ManagedAgentInfo, Arc<AcpClient>), String> {
        let handle_id = info.handle_id.clone();
        Self::emit_status(&self.inner, &info);
        let notify = Self::make_notify(&self.inner, &handle_id);
        let client = Arc::new(
            AcpClient::spawn_with_notify(
                &self.resolve_grok_bin()?,
                info.always_approve,
                extra_args,
                notify,
            )
            .map_err(|error| error.to_string())?,
        );
        info.pid = Some(client.pid());
        self.inner.agents.lock().insert(
            handle_id.clone(),
            LiveAgent {
                info: info.clone(),
                client: Arc::clone(&client),
            },
        );
        Self::drain_early_requests(&self.inner, &handle_id);
        if let Err(error) = client.initialize() {
            return Err(Self::fail_registered_agent(
                &self.inner,
                &handle_id,
                &mut info,
                error.to_string(),
            ));
        }
        Ok((info, client))
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

        let delivery = match pending.kind {
            PermissionKind::ToolPermission => {
                if allow {
                    client.respond_result(
                        &pending.request_id,
                        json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": req.option_id,
                            }
                        }),
                    )
                } else {
                    // Prefer reject option id from request; fall back
                    let reject_id = pick_reject_option(&pending.options, &req.option_id);
                    client.respond_result(
                        &pending.request_id,
                        json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": reject_id,
                            }
                        }),
                    )
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
                        Ok(()) => client.respond_result(&pending.request_id, Value::Null),
                        Err(e) => client.respond_error(&pending.request_id, -32000, &e),
                    }
                } else {
                    client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied file write in MarsBuild",
                    )
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
                        Ok(content) => client
                            .respond_result(&pending.request_id, json!({ "content": content })),
                        Err(e) => client.respond_error(&pending.request_id, -32000, &e),
                    }
                } else {
                    client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied file read in MarsBuild",
                    )
                }
            }
            PermissionKind::Other => {
                if allow {
                    client.respond_result(&pending.request_id, Value::Null)
                } else {
                    client.respond_error(
                        &pending.request_id,
                        -32000,
                        "User denied request in MarsBuild",
                    )
                }
            }
        };

        if let Err(error) = delivery {
            let agent_can_retry = self
                .inner
                .agents
                .lock()
                .get(&req.handle_id)
                .map(|agent| {
                    !matches!(
                        agent.info.status,
                        ManagedStatus::Stopped | ManagedStatus::Error
                    )
                })
                .unwrap_or(false);
            if agent_can_retry {
                self.inner
                    .pending
                    .lock()
                    .insert(req.request_key.clone(), pending);
            } else if let Ok(value) = serde_json::to_value(&pending) {
                // Transport shutdown may race this response after the request was
                // temporarily removed from the map, so explicitly clear the UI.
                Self::emit(
                    &self.inner,
                    "agent-permission-resolved",
                    json!({
                        "pending": value,
                        "optionId": "transport-closed",
                        "allowed": false,
                    }),
                );
            }
            return Err(format!("failed to deliver permission response: {error}"));
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
        if cwd.is_empty() || !Path::new(&cwd).is_dir() {
            return Err(format!("Invalid working directory: {cwd}"));
        }
        let permission_mode = PermissionMode::from_request(req.permission_mode, req.always_approve);
        let always_approve = permission_mode.spawns_always_approve();
        task_prefs::set_last_spawn_mode(permission_mode);
        let handle_id = Uuid::new_v4().to_string();

        let mut extra = permission_mode.spawn_extra_args();
        if let Some(model) = &req.model {
            if !model.is_empty() {
                extra.push("-m".into());
                extra.push(model.clone());
            }
        }

        let info = ManagedAgentInfo {
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
                .map(|p| truncate_text(p, 80))
                .or_else(|| Some("New agent".into())),
            created_at: now_iso(),
            pending_permission_count: 0,
        };
        let (mut info, client) = self.start_client(info, &extra)?;

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
        if cwd.is_empty() || !Path::new(&cwd).is_dir() {
            return Err(format!("Invalid working directory: {cwd}"));
        }

        {
            let agents = self.inner.agents.lock();
            if let Some(existing) = agents.values().find(|a| {
                a.info.session_id.as_deref() == Some(session_id.as_str())
                    && !matches!(a.info.status, ManagedStatus::Stopped | ManagedStatus::Error)
            }) {
                return Ok(existing.info.clone());
            }
        }

        // Explicit request wins; otherwise restore this task's saved mode.
        let permission_mode = match (req.permission_mode, req.always_approve) {
            (Some(m), _) => m,
            (None, Some(true)) => PermissionMode::BypassPermissions,
            (None, Some(false)) | (None, None) => {
                task_prefs::get_permission_mode(&session_id).unwrap_or(PermissionMode::Default)
            }
        };
        let always_approve = permission_mode.spawns_always_approve();
        task_prefs::set_permission_mode(&session_id, permission_mode);
        let handle_id = Uuid::new_v4().to_string();
        let extra = permission_mode.spawn_extra_args();

        let info = ManagedAgentInfo {
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
        let (mut info, client) = self.start_client(info, &extra)?;
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
                    a.info.title = Some(truncate_text(&text, 80));
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
                        if a.info.pending_permission_count == 0
                            && a.info.status != ManagedStatus::Error
                        {
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
        self.inner.shell_stream.clear_handle(handle_id);

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
