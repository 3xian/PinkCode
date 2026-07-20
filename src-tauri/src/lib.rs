mod acp;
mod agent_manager;
mod billing;
mod models;
mod policy;
mod sessions;
mod watcher;

use agent_manager::{
    AgentManager, AttachRequest, ManagedAgentInfo, PendingPermission, ResolvePermissionRequest,
    SpawnRequest,
};
use billing::WeekUsage;
use models::{
    ActiveSession, DashboardStats, HunkRecord, SessionCard, SessionDetail, TokenUsageSeries,
};
use policy::{PolicyConfig, PolicyPreset, PolicyStore, ProjectBinding, ResolvedPolicy};
use serde_json::Value;
use tauri::Manager;

#[tauri::command]
fn get_grok_home() -> String {
    sessions::grok_home().display().to_string()
}

#[tauri::command]
fn list_active_sessions() -> Result<Vec<ActiveSession>, String> {
    sessions::read_active_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_sessions(limit: Option<usize>) -> Result<Vec<SessionCard>, String> {
    sessions::list_sessions(limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_session_detail(session_id: String) -> Result<SessionDetail, String> {
    sessions::get_session_detail(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_session_hunks(
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<HunkRecord>, String> {
    sessions::list_hunks(&session_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_dashboard_stats() -> Result<DashboardStats, String> {
    sessions::dashboard_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_token_usage_series(days: Option<u32>) -> Result<TokenUsageSeries, String> {
    sessions::token_usage_series(days.unwrap_or(7)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_week_usage() -> WeekUsage {
    // Network I/O off the main thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(billing::fetch_week_usage)
        .await
        .unwrap_or_else(|e| billing::WeekUsage {
            used_percent: 0.0,
            remaining_percent: 100.0,
            build_used_percent: None,
            build_remaining_percent: None,
            period_type: "unknown".into(),
            period_start: None,
            period_end: None,
            product_usage: vec![],
            fetched_at: String::new(),
            error: Some(format!("Usage fetch task failed: {e}")),
        })
}

#[tauri::command]
fn resolve_grok_bin(manager: tauri::State<'_, AgentManager>) -> Result<String, String> {
    manager.resolve_grok_bin()
}

#[tauri::command]
fn list_managed_agents(manager: tauri::State<'_, AgentManager>) -> Vec<ManagedAgentInfo> {
    manager.list()
}

#[tauri::command]
fn spawn_agent(
    manager: tauri::State<'_, AgentManager>,
    request: SpawnRequest,
) -> Result<ManagedAgentInfo, String> {
    manager.spawn(request)
}

#[tauri::command]
fn attach_agent(
    manager: tauri::State<'_, AgentManager>,
    request: AttachRequest,
) -> Result<ManagedAgentInfo, String> {
    manager.attach(request)
}

#[tauri::command]
fn prompt_agent(
    manager: tauri::State<'_, AgentManager>,
    handle_id: String,
    text: String,
) -> Result<Value, String> {
    manager.prompt(&handle_id, &text)
}

#[tauri::command]
fn stop_agent(
    manager: tauri::State<'_, AgentManager>,
    handle_id: String,
) -> Result<ManagedAgentInfo, String> {
    manager.stop(&handle_id)
}

#[tauri::command]
fn get_managed_agent(
    manager: tauri::State<'_, AgentManager>,
    handle_id: String,
) -> Option<ManagedAgentInfo> {
    manager.get(&handle_id)
}

#[tauri::command]
fn find_managed_by_session(
    manager: tauri::State<'_, AgentManager>,
    session_id: String,
) -> Option<ManagedAgentInfo> {
    manager.find_by_session(&session_id)
}

#[tauri::command]
fn list_pending_permissions(
    manager: tauri::State<'_, AgentManager>,
    handle_id: Option<String>,
) -> Vec<PendingPermission> {
    manager.list_pending_permissions(handle_id)
}

#[tauri::command]
fn resolve_permission(
    manager: tauri::State<'_, AgentManager>,
    request: ResolvePermissionRequest,
) -> Result<PendingPermission, String> {
    manager.resolve_permission(request)
}

#[tauri::command]
fn get_policy(manager: tauri::State<'_, AgentManager>) -> PolicyConfig {
    manager.get_policy()
}

#[tauri::command]
fn get_policy_store(manager: tauri::State<'_, AgentManager>) -> PolicyStore {
    manager.get_policy_store()
}

#[tauri::command]
fn resolve_policy(
    manager: tauri::State<'_, AgentManager>,
    cwd: Option<String>,
) -> ResolvedPolicy {
    manager.resolve_policy(cwd)
}

#[tauri::command]
fn set_policy(
    manager: tauri::State<'_, AgentManager>,
    policy: PolicyConfig,
) -> Result<PolicyConfig, String> {
    manager.set_policy(policy)
}

#[tauri::command]
fn set_policy_preset(
    manager: tauri::State<'_, AgentManager>,
    preset: PolicyPreset,
) -> Result<PolicyConfig, String> {
    manager.set_policy_preset(preset)
}

#[tauri::command]
fn set_default_policy_preset(
    manager: tauri::State<'_, AgentManager>,
    preset: PolicyPreset,
) -> Result<ResolvedPolicy, String> {
    manager.set_default_preset(preset)
}

#[tauri::command]
fn bind_project_policy(
    manager: tauri::State<'_, AgentManager>,
    cwd: String,
    preset: PolicyPreset,
) -> Result<ResolvedPolicy, String> {
    manager.bind_project_policy(cwd, preset)
}

#[tauri::command]
fn unbind_project_policy(
    manager: tauri::State<'_, AgentManager>,
    cwd: String,
) -> Result<ResolvedPolicy, String> {
    manager.unbind_project_policy(cwd)
}

#[tauri::command]
fn list_project_bindings(manager: tauri::State<'_, AgentManager>) -> Vec<ProjectBinding> {
    manager.list_project_bindings()
}

#[tauri::command]
fn list_policy_presets(manager: tauri::State<'_, AgentManager>) -> Vec<PolicyConfig> {
    manager.list_policy_presets()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentManager::new())
        .setup(|app| {
            let manager = app.state::<AgentManager>();
            manager.set_app(app.handle().clone());
            // Disk-driven session index: FS events + debounce (no fixed 4s poll).
            watcher::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_grok_home,
            list_active_sessions,
            list_sessions,
            get_session_detail,
            list_session_hunks,
            get_dashboard_stats,
            get_token_usage_series,
            get_week_usage,
            resolve_grok_bin,
            list_managed_agents,
            spawn_agent,
            attach_agent,
            prompt_agent,
            stop_agent,
            get_managed_agent,
            find_managed_by_session,
            list_pending_permissions,
            resolve_permission,
            get_policy,
            get_policy_store,
            resolve_policy,
            set_policy,
            set_policy_preset,
            set_default_policy_preset,
            bind_project_policy,
            unbind_project_policy,
            list_project_bindings,
            list_policy_presets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
