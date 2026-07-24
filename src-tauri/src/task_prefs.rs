//! Per-task (Grok session) preferences persisted by PinkCode.
//!
//! Stored under `~/.pinkcode/task_prefs.json` so permission mode and Plan
//! arming survive restarts and re-attach, independent of Grok's own session files.

use crate::agent_types::PermissionMode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPrefsFile {
    /// session_id → permission mode
    #[serde(default)]
    sessions: HashMap<String, PermissionMode>,
    /// session_id → Plan Pending (Grok Plan is orthogonal to permission).
    #[serde(default)]
    plan_armed: HashMap<String, bool>,
    /// Last mode chosen in the New Task modal (seed for the next create).
    #[serde(default)]
    last_spawn_mode: Option<PermissionMode>,
}

struct Store {
    path: PathBuf,
    data: Mutex<TaskPrefsFile>,
}

static STORE: OnceLock<Store> = OnceLock::new();

fn prefs_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pinkcode")
}

fn store() -> &'static Store {
    STORE.get_or_init(|| {
        let path = prefs_dir().join("task_prefs.json");
        let data = load_file(&path).unwrap_or_default();
        Store {
            path,
            data: Mutex::new(data),
        }
    })
}

fn load_file(path: &PathBuf) -> Option<TaskPrefsFile> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_locked(path: &PathBuf, data: &TaskPrefsFile) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(data) {
        let _ = fs::write(path, raw);
    }
}

/// Look up a persisted mode for a Grok session id.
pub fn get_permission_mode(session_id: &str) -> Option<PermissionMode> {
    let id = session_id.trim();
    if id.is_empty() {
        return None;
    }
    store().data.lock().sessions.get(id).copied()
}

/// Persist permission mode for a session (and optionally refresh last-spawn seed).
pub fn set_permission_mode(session_id: &str, mode: PermissionMode) {
    let id = session_id.trim();
    if id.is_empty() {
        return;
    }
    let s = store();
    let mut data = s.data.lock();
    data.sessions.insert(id.to_string(), mode);
    save_locked(&s.path, &data);
}

/// Mode used as the default in the New Task modal.
pub fn last_spawn_mode() -> PermissionMode {
    store()
        .data
        .lock()
        .last_spawn_mode
        .unwrap_or(PermissionMode::Default)
}

pub fn set_last_spawn_mode(mode: PermissionMode) {
    let s = store();
    let mut data = s.data.lock();
    data.last_spawn_mode = Some(mode);
    save_locked(&s.path, &data);
}

/// Snapshot of all session → mode mappings (for UI hydration).
pub fn all_permission_modes() -> HashMap<String, PermissionMode> {
    store().data.lock().sessions.clone()
}

/// Whether Plan mode is armed (Pending) for this session.
pub fn get_plan_armed(session_id: &str) -> bool {
    let id = session_id.trim();
    if id.is_empty() {
        return false;
    }
    store()
        .data
        .lock()
        .plan_armed
        .get(id)
        .copied()
        .unwrap_or(false)
}

/// Persist Plan arming (true = Pending until next free-text `/plan …`).
pub fn set_plan_armed(session_id: &str, armed: bool) {
    let id = session_id.trim();
    if id.is_empty() {
        return;
    }
    let s = store();
    let mut data = s.data.lock();
    if armed {
        data.plan_armed.insert(id.to_string(), true);
    } else {
        data.plan_armed.remove(id);
    }
    save_locked(&s.path, &data);
}

/// Snapshot of session → plan-armed flags (only `true` entries are stored).
pub fn all_plan_armed() -> HashMap<String, bool> {
    store().data.lock().plan_armed.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_store_path() -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pinkcode_prefs_test_{t}_{n}.json"))
    }

    #[test]
    fn roundtrip_session_mode() {
        let path = temp_store_path();
        let _ = fs::remove_file(&path);
        let mut data = TaskPrefsFile::default();
        data.sessions
            .insert("sess-1".into(), PermissionMode::AcceptEdits);
        data.plan_armed.insert("sess-1".into(), true);
        save_locked(&path, &data);
        let loaded = load_file(&path).expect("load");
        assert_eq!(
            loaded.sessions.get("sess-1").copied(),
            Some(PermissionMode::AcceptEdits)
        );
        assert_eq!(loaded.plan_armed.get("sess-1").copied(), Some(true));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn plan_armed_defaults_empty() {
        let path = temp_store_path();
        let _ = fs::remove_file(&path);
        let data = TaskPrefsFile::default();
        save_locked(&path, &data);
        let loaded = load_file(&path).expect("load");
        assert!(loaded.plan_armed.is_empty());
        let _ = fs::remove_file(&path);
    }
}
