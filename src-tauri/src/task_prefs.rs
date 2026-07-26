//! Per-task (Grok session) preferences persisted by PinkCode.
//!
//! Stored under `~/.pinkcode/task_prefs.json` so permission mode and Plan
//! arming survive restarts and re-attach, independent of Grok's own session files.

use crate::agent_types::PermissionMode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

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
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pinkcode")
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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create prefs dir: {error}"))?;
    }
    let raw =
        serde_json::to_string_pretty(data).map_err(|error| format!("serialize prefs: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), nonce));
    fs::write(&tmp, raw).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    if let Err(error) = replace_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
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

/// Mode used as the default in the New Task modal.
pub fn last_spawn_mode() -> PermissionMode {
    store()
        .data
        .lock()
        .last_spawn_mode
        .unwrap_or(PermissionMode::Default)
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
