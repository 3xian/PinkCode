//! Type-safe ACP / x.ai JSON-RPC request and response payloads.
//!
//! Wire encoding stays JSON; call sites construct these structs instead of
//! hand-built `serde_json::Value` maps.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Identity string Grok Build uses for Desktop-hosted clients.
pub const CLIENT_IDENTIFIER: &str = "grok-desktop";

// ── Shared fragments ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsCapabilities {
    pub read_text_file: bool,
    pub write_text_file: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkTrackerMeta {
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientCapabilitiesMeta {
    #[serde(rename = "x.ai/incrementalBashOutput")]
    pub incremental_bash_output: bool,
    #[serde(rename = "x.ai/bashOutputNoColor")]
    pub bash_output_no_color: bool,
    #[serde(rename = "x.ai/hunkTracker")]
    pub hunk_tracker: HunkTrackerMeta,
    #[serde(rename = "x.ai/fs_notify")]
    pub fs_notify: bool,
    #[serde(rename = "x.ai/gitHeadChanged")]
    pub git_head_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    pub fs: FsCapabilities,
    pub terminal: bool,
    pub meta: ClientCapabilitiesMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientIdentifierMeta {
    pub client_identifier: String,
}

// ── initialize ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client_info: ClientInfo,
    pub client_capabilities: ClientCapabilities,
    pub meta: ClientIdentifierMeta,
}

impl InitializeParams {
    pub fn pinkcode() -> Self {
        Self {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "pinkcode".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            client_capabilities: ClientCapabilities {
                fs: FsCapabilities {
                    read_text_file: true,
                    write_text_file: true,
                },
                terminal: false,
                meta: ClientCapabilitiesMeta {
                    incremental_bash_output: true,
                    bash_output_no_color: true,
                    hunk_tracker: HunkTrackerMeta {
                        mode: "agent_only".into(),
                    },
                    fs_notify: true,
                    git_head_changed: true,
                },
            },
            meta: ClientIdentifierMeta {
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResultMeta {
    #[serde(default)]
    pub default_auth_method_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    #[serde(default)]
    pub auth_methods: Vec<AuthMethodInfo>,
    #[serde(default, rename = "_meta")]
    pub meta_underscore: Option<InitializeResultMeta>,
    #[serde(default)]
    pub meta: Option<InitializeResultMeta>,
}

impl InitializeResult {
    pub fn default_auth_method_id(&self) -> Option<&str> {
        self.meta_underscore
            .as_ref()
            .or(self.meta.as_ref())
            .and_then(|m| m.default_auth_method_id.as_deref())
    }

    pub fn has_auth_method(&self, id: &str) -> bool {
        self.auth_methods.iter().any(|m| m.id == id)
    }
}

// ── authenticate ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateParams {
    pub method_id: String,
}

// ── session/new & session/load ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNewParams {
    pub cwd: String,
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadParams {
    pub session_id: String,
    pub cwd: String,
    pub mcp_servers: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelsInfo {
    #[serde(default)]
    pub current_model_id: Option<String>,
}

/// Shared shape for `session/new` and `session/load` results.
///
/// ACP `session/new` returns `sessionId`. `session/load` (Grok
/// `LoadSessionResponse`) often omits it — the client already knows the id —
/// so the field is optional and callers should fall back to the request id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBootstrapResult {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub models: Option<SessionModelsInfo>,
}

impl SessionBootstrapResult {
    pub fn current_model_id(&self) -> Option<&str> {
        self.models
            .as_ref()
            .and_then(|m| m.current_model_id.as_deref())
    }

    /// Prefer response `sessionId`; if missing/empty, use `fallback` (load path).
    pub fn resolve_session_id(&self, fallback: Option<&str>) -> Option<String> {
        self.session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                fallback
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
    }
}

// ── session/prompt ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTextBlock {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptMeta {
    pub prompt_id: String,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    pub session_id: String,
    pub prompt: Vec<PromptTextBlock>,
    #[serde(rename = "_meta")]
    pub meta: PromptMeta,
}

impl SessionPromptParams {
    pub fn text(
        session_id: impl Into<String>,
        prompt_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            prompt: vec![PromptTextBlock {
                kind: "text",
                text: text.into(),
            }],
            meta: PromptMeta {
                prompt_id: prompt_id.into(),
                client_identifier: CLIENT_IDENTIFIER.into(),
            },
        }
    }
}

// ── session/set_mode ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModeParams {
    pub session_id: String,
    pub mode_id: String,
}

// ── session/cancel ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelParams {
    pub session_id: String,
    pub reason: String,
}

// ── x.ai/interject ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterjectParams {
    pub session_id: String,
    pub text: String,
    pub interjection_id: String,
}

// ── queue notifications ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRemoveParams {
    pub session_id: String,
    pub id: String,
    pub expected_version: u64,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueReorderParams {
    pub session_id: String,
    pub ordered_ids: Vec<String>,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueClearParams {
    pub session_id: String,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEditParams {
    pub session_id: String,
    pub id: String,
    pub new_text: String,
    pub client_identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueInterjectParams {
    pub session_id: String,
    pub id: String,
    pub expected_version: u64,
    pub client_identifier: String,
}

// ── x.ai/yolo_mode_changed ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct YoloModeChangedParams {
    pub yolo_mode: bool,
    pub auto_mode: bool,
    pub permission_mode: &'static str,
}

// ── JSON-RPC envelopes (internal wire helpers) ──────────────────────────────

#[derive(Debug, Serialize)]
pub struct JsonRpcNotification<P: Serialize> {
    pub jsonrpc: &'static str,
    pub method: &'static str,
    pub params: P,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcResultResponse<R: Serialize> {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub result: R,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorBody {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub error: JsonRpcErrorBody,
}
