//! Debounced filesystem watcher for Grok session on-disk state.
//!
//! Emits Tauri event `sessions-changed` when `~/.grok/sessions/**` or
//! `~/.grok/active_sessions.json` change. Live agent traffic still comes from ACP.

use crate::sessions;
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Debounce FS storms; keep short enough that Live can mirror Grok Build promptly.
const DEBOUNCE: Duration = Duration::from_millis(450);
const EVENT_NAME: &str = "sessions-changed";

/// Start a background thread that watches Grok home for session index changes.
pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("sessions-watcher".into())
        .spawn(move || run_loop(app))
        .expect("spawn sessions-watcher");
}

fn run_loop(app: AppHandle) {
    let home = sessions::grok_home();
    let sessions_dir = sessions::sessions_root();
    let _ = std::fs::create_dir_all(&sessions_dir);

    let (tx, rx) = mpsc::channel();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[pinkcode] sessions watcher unavailable: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&sessions_dir, RecursiveMode::Recursive) {
        eprintln!("[pinkcode] watch {} failed: {e}", sessions_dir.display());
    }
    // Non-recursive on ~/.grok so active_sessions.json creates/writes are seen
    // without re-walking the whole sessions tree twice.
    if let Err(e) = watcher.watch(&home, RecursiveMode::NonRecursive) {
        eprintln!("[pinkcode] watch {} failed: {e}", home.display());
    }

    let mut pending: HashMap<(String, Option<String>), (Instant, String)> = HashMap::new();

    loop {
        let wait = if pending.is_empty() {
            Duration::from_secs(3600)
        } else {
            Duration::from_millis(80)
        };

        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if !is_interesting(&event) {
                    continue;
                }
                for path in event.paths {
                    if let Some((category, session_id)) = classify_path(&path, &home, &sessions_dir)
                    {
                        pending.insert(
                            (category.to_string(), session_id),
                            (Instant::now(), path.display().to_string()),
                        );
                    }
                }
            }
            Ok(Err(e)) => {
                eprintln!("[pinkcode] watch error: {e}");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let ready: Vec<_> = pending
                    .iter()
                    .filter(|(_, (at, _))| at.elapsed() >= DEBOUNCE)
                    .map(|(key, (_, path))| (key.clone(), path.clone()))
                    .collect();
                for ((category, session_id), path) in ready {
                    pending.remove(&(category.clone(), session_id.clone()));
                    let _ = app.emit(
                        EVENT_NAME,
                        json!({
                            "reason": "fs",
                            "category": category,
                            "sessionId": session_id,
                            "path": path,
                            "ts": now_ms(),
                        }),
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Keep watcher alive for the thread lifetime (drop would stop watching).
    drop(watcher);
}

fn is_interesting(event: &notify::Event) -> bool {
    match event.kind {
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any => true,
        EventKind::Modify(kind) => !matches!(
            kind,
            ModifyKind::Metadata(_) // chmod/atime — ignore
        ),
        EventKind::Access(_) | EventKind::Other => false,
    }
}

fn classify_path(
    path: &Path,
    home: &Path,
    sessions_root: &Path,
) -> Option<(&'static str, Option<String>)> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    // Editor / OS temporaries (macOS + Windows)
    if name.ends_with('~')
        || name.ends_with(".tmp")
        || name.ends_with(".swp")
        || name.ends_with(".lock")
        || name.starts_with('.')
        || name == ".ds_store"
        || name == "thumbs.db"
        || name == "desktop.ini"
    {
        return None;
    }
    if path.parent() == Some(home) && name == "active_sessions.json" {
        return Some(("index", None));
    }
    if !path.starts_with(sessions_root) {
        return None;
    }
    if name.starts_with("session_search.sqlite") {
        return None;
    }
    let session_id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        .map(str::to_string);
    match name.as_str() {
        "summary.json" | "signals.json" => Some(("index", session_id)),
        "updates.jsonl" | "events.jsonl" => Some(("timeline", session_id)),
        "hunk_records.jsonl" => Some(("hunks", session_id)),
        "plan.md" => Some(("plan", session_id)),
        _ => None,
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Paths we care about (for tests / docs).
#[allow(dead_code)]
pub fn watched_roots() -> (PathBuf, PathBuf) {
    (sessions::grok_home(), sessions::sessions_root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_session_streams_and_index() {
        let home = Path::new(r"C:\Users\test\.grok");
        let root = home.join("sessions");
        let session = root.join("workspace").join("session-1");
        assert_eq!(
            classify_path(&session.join("updates.jsonl"), home, &root),
            Some(("timeline", Some("session-1".into())))
        );
        assert_eq!(
            classify_path(&session.join("hunk_records.jsonl"), home, &root),
            Some(("hunks", Some("session-1".into())))
        );
        assert_eq!(
            classify_path(&home.join("active_sessions.json"), home, &root),
            Some(("index", None))
        );
        assert_eq!(
            classify_path(&session.join("session_search.sqlite-wal"), home, &root),
            None
        );
    }
}
