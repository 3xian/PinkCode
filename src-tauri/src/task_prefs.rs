//! Per-task (Grok session) preferences persisted by PinkCode.
//!
//! Stored under `~/.pinkcode/task_prefs.json` so permission mode and Plan
//! arming survive restarts and re-attach, independent of Grok's own session files.
//! This is the **session** layer of the layered config stack (see `config`).

use crate::agent_types::PermissionMode;
use crate::fs_atomic;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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
    load_error: Mutex<Option<String>>,
}

static STORE: OnceLock<Store> = OnceLock::new();
const PREFS_PRUNE_THRESHOLD: usize = 2_048;

fn prefs_dir() -> PathBuf {
    crate::config::pinkcode_home()
}

fn store() -> &'static Store {
    STORE.get_or_init(|| {
        let path = prefs_dir().join("task_prefs.json");
        let (data, load_error) = match load_file(&path) {
            Ok(data) => (data, None),
            Err(error) => (TaskPrefsFile::default(), Some(error)),
        };
        Store {
            path,
            data: Mutex::new(data),
            load_error: Mutex::new(load_error),
        }
    })
}

fn load_file(path: &Path) -> Result<TaskPrefsFile, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TaskPrefsFile::default());
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn save_locked(path: &Path, data: &TaskPrefsFile) -> Result<(), String> {
    fs_atomic::write_json_atomic(path, data)
}

fn ensure_store_writable(store: &Store) -> Result<(), String> {
    match store.load_error.lock().as_ref() {
        Some(error) => Err(format!(
            "preferences were not loaded; refusing to overwrite them: {error}"
        )),
        None => Ok(()),
    }
}

fn prune_stale_sessions(data: &mut TaskPrefsFile, keep_id: &str) {
    if data.sessions.len().max(data.plan_armed.len()) <= PREFS_PRUNE_THRESHOLD {
        return;
    }
    let existing = crate::sessions::session_ids_on_disk();
    data.sessions
        .retain(|id, _| id == keep_id || existing.contains(id));
    data.plan_armed
        .retain(|id, _| id == keep_id || existing.contains(id));
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
pub fn set_permission_mode(session_id: &str, mode: PermissionMode) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session id is empty".into());
    }
    let s = store();
    ensure_store_writable(s)?;
    let mut data = s.data.lock();
    let previous = data.clone();
    data.sessions.insert(id.to_string(), mode);
    prune_stale_sessions(&mut data, id);
    if let Err(error) = save_locked(&s.path, &data) {
        *data = previous;
        return Err(error);
    }
    Ok(())
}

/// Raw last-spawn seed without layered fallback (None if never set).
pub fn last_spawn_mode_raw() -> Option<PermissionMode> {
    store().data.lock().last_spawn_mode
}

/// Canonical permission mode: session prefs → last-spawn seed → layered config.
///
/// - `session_id`: when set, use that session's stored mode if present.
/// - `project_cwd`: when set, project `.pinkcode/config.json` participates in
///   the layered default (see [`crate::config::resolve`]).
///
/// New Task seed: `effective_permission_mode(None, project_cwd)`.
/// Attach without request mode: `effective_permission_mode(Some(id), Some(cwd))`.
pub fn effective_permission_mode(
    session_id: Option<&str>,
    project_cwd: Option<&Path>,
) -> PermissionMode {
    if let Some(id) = session_id {
        if let Some(mode) = get_permission_mode(id) {
            return mode;
        }
    }
    last_spawn_mode_raw()
        .unwrap_or_else(|| crate::config::resolve(project_cwd).default_permission_mode)
}

pub fn set_last_spawn_mode(mode: PermissionMode) -> Result<(), String> {
    let s = store();
    ensure_store_writable(s)?;
    let mut data = s.data.lock();
    let previous = data.clone();
    data.last_spawn_mode = Some(mode);
    if let Err(error) = save_locked(&s.path, &data) {
        *data = previous;
        return Err(error);
    }
    Ok(())
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
pub fn set_plan_armed(session_id: &str, armed: bool) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("session id is empty".into());
    }
    let s = store();
    ensure_store_writable(s)?;
    let mut data = s.data.lock();
    let previous = data.clone();
    if armed {
        data.plan_armed.insert(id.to_string(), true);
    } else {
        data.plan_armed.remove(id);
    }
    prune_stale_sessions(&mut data, id);
    if let Err(error) = save_locked(&s.path, &data) {
        *data = previous;
        return Err(error);
    }
    Ok(())
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
        save_locked(&path, &data).expect("save");
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
        save_locked(&path, &data).expect("save");
        let loaded = load_file(&path).expect("load");
        assert!(loaded.plan_armed.is_empty());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn corrupt_preferences_are_reported_and_left_untouched() {
        let path = temp_store_path();
        fs::write(&path, "{broken").expect("fixture");
        let before = fs::read(&path).expect("before");
        assert!(load_file(&path).expect_err("parse error").contains("parse"));
        assert_eq!(fs::read(&path).expect("after"), before);
        let _ = fs::remove_file(path);
    }
}
