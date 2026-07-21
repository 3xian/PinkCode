//! Debounced filesystem watcher for Grok session on-disk state.
//!
//! Emits Tauri event `sessions-changed` when `~/.grok/sessions/**` or
//! `~/.grok/active_sessions.json` change. Live agent traffic still comes from ACP.

use crate::sessions;
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Longer debounce: session dir is chatty; 500ms still floods React during agent turns.
const DEBOUNCE: Duration = Duration::from_millis(900);
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
            eprintln!("[marsbuild] sessions watcher unavailable: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&sessions_dir, RecursiveMode::Recursive) {
        eprintln!("[marsbuild] watch {} failed: {e}", sessions_dir.display());
    }
    // Non-recursive on ~/.grok so active_sessions.json creates/writes are seen
    // without re-walking the whole sessions tree twice.
    if let Err(e) = watcher.watch(&home, RecursiveMode::NonRecursive) {
        eprintln!("[marsbuild] watch {} failed: {e}", home.display());
    }

    let mut last_event_at: Option<Instant> = None;
    let mut last_path: Option<String> = None;

    loop {
        let wait = if last_event_at.is_some() {
            Duration::from_millis(80)
        } else {
            // Idle: long wait until the next FS event wakes us.
            Duration::from_secs(3600)
        };

        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if !is_interesting(&event) {
                    continue;
                }
                if let Some(p) = event.paths.first() {
                    if is_noise_path(p) {
                        continue;
                    }
                    last_path = Some(p.display().to_string());
                }
                last_event_at = Some(Instant::now());
            }
            Ok(Err(e)) => {
                eprintln!("[marsbuild] watch error: {e}");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(t) = last_event_at {
                    if t.elapsed() >= DEBOUNCE {
                        let path = last_path.take();
                        last_event_at = None;
                        let _ = app.emit(
                            EVENT_NAME,
                            json!({
                                "reason": "fs",
                                "path": path,
                                "ts": now_ms(),
                            }),
                        );
                    }
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

fn is_noise_path(path: &Path) -> bool {
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
        return true;
    }
    // High-churn session streams: live UI uses ACP; re-scanning these on every
    // chunk tanks the main thread (especially window drag / resize on Windows).
    matches!(
        name.as_str(),
        "updates.jsonl"
            | "events.jsonl"
            | "hunk_records.jsonl"
            | "session_search.sqlite"
            | "session_search.sqlite-journal"
            | "session_search.sqlite-wal"
            | "session_search.sqlite-shm"
    )
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
