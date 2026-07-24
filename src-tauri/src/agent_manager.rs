use crate::acp::{AcpClient, NotifyFn};
use crate::agent_fs::write_text_file;
use crate::agent_runtime::{find_grok_bin, now_iso, truncate_text};
use crate::agent_types::{
    AttachRequest, ManagedAgentInfo, ManagedStatus, PendingPermission, PermissionKind,
    PermissionMode, ResolvePermissionRequest, SpawnRequest,
};
use crate::permission_policy::{
    decide_gate, is_allow_option, pick_allow_option, pick_reject_option, GateDecision,
};
use crate::rpc_handler::{self, HandleResult, ResponseAction};
use crate::shell_emitter;
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

pub(crate) struct Inner {
    pub(crate) app: Mutex<Option<AppHandle>>,
    pub(crate) shell_stream: ShellStream,
    agents: Mutex<HashMap<String, LiveAgent>>,
    pending: Mutex<HashMap<String, PendingPermission>>,
    early_requests: Mutex<Vec<(String, Value)>>,
    grok_bin: Mutex<Option<String>>,
    handlers: Vec<Box<dyn rpc_handler::RpcHandler>>,
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
                handlers: rpc_handler::default_handlers(),
            }),
        }
    }

    pub fn set_session_mode(&self, handle_id: &str, mode_id: &str) -> Result<(), String> {
        let mode_id = mode_id.trim();
        if mode_id.is_empty() {
            return Err("mode_id is empty".into());
        }
        let (session_id, client) = {
            let agents = self.inner.agents.lock();
            let agent = agents
                .get(handle_id)
                .ok_or_else(|| format!("unknown handle {handle_id}"))?;
            let sid = agent
                .info
                .session_id
                .clone()
                .ok_or_else(|| "agent has no session_id".to_string())?;
            (sid, Arc::clone(&agent.client))
        };
        client
            .session_set_mode(&session_id, mode_id)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

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

    fn reconcile_pending_for_mode(&self, handle_id: &str, mode: PermissionMode) {
        let items: Vec<(String, String)> = {
            let pending = self.inner.pending.lock();
            pending
                .values()
                .filter(|p| p.handle_id == handle_id)
                .filter_map(|p| {
                    let decision = decide_gate(mode, p);
                    match decision {
                        GateDecision::Ask => None,
                        GateDecision::Allow => {
                            Some((p.request_key.clone(), pick_allow_option(&p.options)))
                        }
                        GateDecision::Deny => Some((
                            p.request_key.clone(),
                            pick_reject_option(&p.options, "reject-once"),
                        )),
                    }
                })
                .collect()
        };
        for (key, option_id) in items {
            let _ = self.resolve_permission(ResolvePermissionRequest {
                handle_id: handle_id.to_string(),
                request_key: key,
                option_id,
                comments: None,
                payload: None,
            });
        }
    }

    fn fail_registered_agent(
        inner: &Arc<Inner>,
        handle_id: &str,
        info: &mut ManagedAgentInfo,
        err: String,
    ) -> String {
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

    pub(crate) fn emit(inner: &Inner, event: &str, payload: Value) {
        if let Some(app) = inner.app.lock().as_ref() {
            let _ = app.emit(event, payload);
        }
    }

    pub(crate) fn emit_status(inner: &Inner, info: &ManagedAgentInfo) {
        if let Ok(v) = serde_json::to_value(info) {
            Self::emit(inner, "agent-status", v);
        }
    }

    fn send_action(client: &AcpClient, id: &Value, action: ResponseAction) -> Result<(), String> {
        match action {
            ResponseAction::Send(value) => {
                client.respond_result(id, value).map_err(|e| e.to_string())
            }
            ResponseAction::SendError(code, msg) => client
                .respond_error(id, code, &msg)
                .map_err(|e| e.to_string()),
            ResponseAction::WriteFile { path, content } => {
                write_text_file(&path, &content).map_err(|e| e.to_string())?;
                client
                    .respond_result(id, Value::Null)
                    .map_err(|e| e.to_string())
            }
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

            if method == "_pinkcode/transport_closed" {
                let reason = msg
                    .pointer("/params/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("ACP transport closed");
                Self::handle_transport_closed(&inner, &handle_id, reason);
                return;
            }

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

            if method == "session/update" || method.ends_with("/session/update") {
                Self::emit(&inner, "agent-update", payload.clone());
                shell_emitter::maybe_emit_shell(
                    &inner.shell_stream,
                    &inner,
                    &handle_id,
                    &session_id,
                    &params,
                );
            } else if !method.is_empty() {
                Self::emit(&inner, "agent-notification", payload);
            }
        })
    }

    fn dispatch_handle_request(
        inner: &Arc<Inner>,
        handle_id: &str,
        request_id: Value,
        method: &str,
        params: Value,
    ) {
        let (client, permission_mode, session_hint) = {
            let agents = inner.agents.lock();
            match agents.get(handle_id) {
                Some(a) => (
                    Arc::clone(&a.client),
                    a.info.permission_mode,
                    a.info.session_id.clone(),
                ),
                None => {
                    inner.early_requests.lock().push((
                        handle_id.to_string(),
                        json!({
                            "id": request_id,
                            "method": method,
                            "params": params,
                        }),
                    ));
                    return;
                }
            }
        };

        let session_id = params
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
            .or(session_hint);

        let handler = rpc_handler::find_handler(&inner.handlers, method);
        match handler {
            Some(h) => match h.handle_request(handle_id, session_id, request_id.clone(), &params) {
                HandleResult::Respond(value) => {
                    let _ = client.respond_result(&request_id, value);
                }
                HandleResult::Gate(pending) => match decide_gate(permission_mode, &pending) {
                    GateDecision::Allow => {
                        let action = rpc_handler::build_allow_response(h, &pending);
                        match action {
                            Ok(a) => {
                                let _ = Self::send_action(&client, &pending.request_id, a);
                            }
                            Err(e) => {
                                let _ = client.respond_error(&request_id, -32000, &e);
                            }
                        }
                    }
                    GateDecision::Deny => {
                        let action = rpc_handler::build_deny_response(h, &pending);
                        match action {
                            Ok(a) => {
                                let _ = Self::send_action(&client, &pending.request_id, a);
                            }
                            Err(e) => {
                                let _ = client.respond_error(&request_id, -32000, &e);
                            }
                        }
                    }
                    GateDecision::Ask => {
                        Self::enqueue_permission(inner, handle_id, *pending);
                    }
                },
                HandleResult::Error(code, msg) => {
                    let _ = client.respond_error(&request_id, code, &msg);
                }
            },
            None => {
                let _ = client.respond_error(
                    &request_id,
                    -32601,
                    &format!("PinkCode does not implement {method}"),
                );
            }
        }
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

    fn handle_server_request(inner: &Arc<Inner>, handle_id: &str, msg: &Value) {
        let method = msg
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let request_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        Self::dispatch_handle_request(inner, handle_id, request_id, &method, params);
    }

    fn enqueue_permission(inner: &Arc<Inner>, handle_id: &str, pending: PendingPermission) {
        let key = pending.request_key.clone();
        if let Ok(v) = serde_json::to_value(&pending) {
            Self::emit(inner, "agent-permission", v);
        }
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
                    self.inner
                        .pending
                        .lock()
                        .insert(req.request_key.clone(), pending);
                    return Err("agent gone".into());
                }
            }
        };

        let allow = match rpc_handler::find_handler_by_kind(&self.inner.handlers, pending.kind) {
            Some(handler) => handler.is_allow_option(&req.option_id),
            None => is_allow_option(&req.option_id, &pending.options),
        };

        let delivery = match rpc_handler::find_handler_by_kind(&self.inner.handlers, pending.kind) {
            Some(handler) => {
                match handler.build_response(
                    &pending,
                    &req.option_id,
                    allow,
                    req.comments.as_deref(),
                    req.payload.as_ref(),
                ) {
                    Ok(action) => Self::send_action(&client, &pending.request_id, action),
                    Err(msg) => client
                        .respond_error(&pending.request_id, -32000, &msg)
                        .map_err(|e| e.to_string()),
                }
            }
            None => {
                if allow {
                    client
                        .respond_result(&pending.request_id, Value::Null)
                        .map_err(|e| e.to_string())
                } else {
                    client
                        .respond_error(
                            &pending.request_id,
                            -32000,
                            "User denied request in PinkCode",
                        )
                        .map_err(|e| e.to_string())
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

        if let Some(mode_id) = req
            .session_mode_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Err(e) = client.session_set_mode(&session_id, mode_id) {
                eprintln!("[pinkcode] session/set_mode({mode_id}) after spawn failed: {e}");
            }
        }

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

        let session_id = {
            let agents = self.inner.agents.lock();
            agents
                .get(handle_id)
                .and_then(|a| a.info.session_id.clone())
        };

        if let Some(ref sid) = session_id {
            let agents = self.inner.agents.lock();
            if let Some(agent) = agents.get(handle_id) {
                let _ = agent.client.session_cancel(sid, "user");
            }
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
