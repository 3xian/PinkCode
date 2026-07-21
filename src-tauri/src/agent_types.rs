use serde::{Deserialize, Serialize};
use serde_json::Value;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Default,
    AcceptEdits,
    BypassPermissions,
    DontAsk,
}

impl PermissionMode {
    pub fn spawns_always_approve(self) -> bool {
        matches!(self, Self::BypassPermissions)
    }

    pub fn from_request(mode: Option<Self>, always_approve: Option<bool>) -> Self {
        mode.unwrap_or_else(|| {
            if always_approve == Some(true) {
                Self::BypassPermissions
            } else {
                Self::Default
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAgentInfo {
    pub handle_id: String,
    pub session_id: Option<String>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: ManagedStatus,
    pub permission_mode: PermissionMode,
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
    pub always_approve: Option<bool>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachRequest {
    pub session_id: String,
    pub cwd: String,
    pub permission_mode: Option<PermissionMode>,
    pub always_approve: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    ToolPermission,
    FsWrite,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_always_approve_maps_to_bypass() {
        assert_eq!(
            PermissionMode::from_request(None, Some(true)),
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            PermissionMode::from_request(Some(PermissionMode::AcceptEdits), Some(true)),
            PermissionMode::AcceptEdits
        );
    }

    #[test]
    fn serialized_enums_match_shared_contract() {
        let contract: Value =
            serde_json::from_str(include_str!("../../contracts/agent-contract.json"))
                .expect("contract json");
        let statuses = [
            ManagedStatus::Starting,
            ManagedStatus::Ready,
            ManagedStatus::Running,
            ManagedStatus::AwaitingPermission,
            ManagedStatus::Error,
            ManagedStatus::Stopped,
        ];
        let modes = [
            PermissionMode::Default,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
            PermissionMode::DontAsk,
        ];
        let kinds = [
            PermissionKind::ToolPermission,
            PermissionKind::FsWrite,
            PermissionKind::FsRead,
            PermissionKind::Other,
        ];
        assert_eq!(json!(statuses), contract["managedStatuses"]);
        assert_eq!(json!(modes), contract["permissionModes"]);
        assert_eq!(json!(kinds), contract["permissionKinds"]);
    }
}
