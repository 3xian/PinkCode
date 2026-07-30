//! Durable per-session token accounting from Grok's `updates.jsonl` logs.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
#[cfg(not(unix))]
use std::{
    hash::{Hash, Hasher},
    io::Read,
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SessionTokenUsage {
    pub total_tokens: u64,
    pub incomplete: bool,
    /// False when the log has no compatible completed-turn usage record.
    pub available: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct UsageCacheEntry {
    identity: FileIdentity,
    modified_nanos: Option<u64>,
    len: u64,
    scan_offset: u64,
    prompt_ids: HashSet<String>,
    usage: SessionTokenUsage,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    prefix_fingerprint: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct UsageCacheFile {
    version: u32,
    entries: HashMap<PathBuf, UsageCacheEntry>,
}

impl FileIdentity {
    fn is_reliable(&self) -> bool {
        #[cfg(unix)]
        {
            true
        }
        #[cfg(not(unix))]
        {
            self.prefix_fingerprint.is_some()
        }
    }
}

fn file_identity(_path: &Path, metadata: &fs::Metadata) -> FileIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        // Windows' portable std metadata lacks a stable file ID, and creation
        // timestamps can share a coarse resolution. Hashing the fixed prefix
        // distinguishes replacement logs without sacrificing append scans.
        let prefix_fingerprint = (|| {
            let mut file = fs::File::open(_path).ok()?;
            let mut bytes = vec![0; 4096];
            let read = file.read(&mut bytes).ok()?;
            bytes.truncate(read);
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            metadata.created().ok().hash(&mut hasher);
            bytes.hash(&mut hasher);
            Some(hasher.finish())
        })();
        FileIdentity { prefix_fingerprint }
    }
}

fn usage_cache() -> &'static Mutex<HashMap<PathBuf, UsageCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, UsageCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(load_persisted_usage_cache()))
}

/// Serialize durable-log scans so two Tauri blocking commands cannot commit
/// snapshots out of order. Cache-only reads remain independent and fast.
fn usage_scan_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(not(test))]
fn usage_persist_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(not(test))]
fn usage_cache_path() -> PathBuf {
    crate::config::pinkcode_home().join("session_usage.json")
}

#[cfg(not(test))]
fn load_persisted_usage_cache() -> HashMap<PathBuf, UsageCacheEntry> {
    let Ok(raw) = fs::read_to_string(usage_cache_path()) else {
        return HashMap::new();
    };
    let Ok(file) = serde_json::from_str::<UsageCacheFile>(&raw) else {
        return HashMap::new();
    };
    if file.version == 1 {
        file.entries
    } else {
        HashMap::new()
    }
}

#[cfg(test)]
fn load_persisted_usage_cache() -> HashMap<PathBuf, UsageCacheEntry> {
    HashMap::new()
}

fn modified_nanos(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
}

/// Persist the in-memory incremental ledger after a batch or detail scan.
#[cfg(not(test))]
pub fn persist_session_usage_cache() {
    let _persist_guard = usage_persist_lock().lock();
    let mut entries = usage_cache().lock().clone();
    entries.retain(|path, _| path.exists());
    let file = UsageCacheFile {
        version: 1,
        entries,
    };
    if let Err(error) = crate::fs_atomic::write_json_atomic(&usage_cache_path(), &file) {
        tracing::warn!(error = %error, "failed to persist session usage cache");
    }
}

#[cfg(test)]
pub fn persist_session_usage_cache() {}

pub struct CompletedTurnUsage<'a> {
    pub prompt_id: Option<&'a str>,
    pub total_tokens: u64,
    pub fresh_tokens: u64,
    /// Server billable cost in USD ticks (`1e10` ticks = $1). Absent when
    /// scrubbed/missing on the wire (see Grok Build `PromptUsage`).
    pub cost_usd_ticks: u64,
    pub incomplete: bool,
}

/// Extract one durable `turn_completed.usage` record from an ACP update.
pub fn completed_turn_usage(message: &Value) -> Option<CompletedTurnUsage<'_>> {
    let update = message
        .pointer("/params/update")
        .or_else(|| message.get("update"))?;
    if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("turn_completed") {
        return None;
    }
    let usage = update.get("usage")?;
    let input = u64_field(usage, &["inputTokens", "input_tokens"]);
    let output = u64_field(usage, &["outputTokens", "output_tokens"]);
    let cached = u64_field(usage, &["cachedReadTokens", "cached_read_tokens"]);
    let total = u64_field(usage, &["totalTokens", "total_tokens"]);
    // Prefer trusted cost only: incomplete / partial bills are scrubbed in
    // Grok Build wire surfaces (absence ≠ free).
    let incomplete = usage
        .get("usageIsIncomplete")
        .or_else(|| usage.get("usage_is_incomplete"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cost_is_partial = usage
        .get("costIsPartial")
        .or_else(|| usage.get("cost_is_partial"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let raw_cost = i64_field(usage, &["costUsdTicks", "cost_usd_ticks"]);
    let cost_usd_ticks = if incomplete || cost_is_partial || raw_cost <= 0 {
        0
    } else {
        raw_cost as u64
    };
    Some(CompletedTurnUsage {
        prompt_id: update
            .get("prompt_id")
            .or_else(|| update.get("promptId"))
            .and_then(Value::as_str),
        total_tokens: if total > 0 {
            total
        } else {
            input.saturating_add(output)
        },
        fresh_tokens: if input > 0 || output > 0 {
            input.saturating_sub(cached).saturating_add(output)
        } else {
            total
        },
        cost_usd_ticks,
        incomplete,
    })
}

/// Read a session's complete token ledger, incrementally when its append-only
/// update log grows. Rebuild from zero if the file is replaced or truncated.
pub fn session_token_usage(path: &Path) -> SessionTokenUsage {
    let _scan_guard = usage_scan_lock().lock();
    let Ok(metadata) = fs::metadata(path) else {
        return SessionTokenUsage::default();
    };
    let modified_nanos = modified_nanos(&metadata);
    let len = metadata.len();
    let identity = file_identity(path, &metadata);
    let cached = usage_cache().lock().get(path).cloned();
    if let Some(entry) = cached.as_ref() {
        if entry.modified_nanos == modified_nanos && entry.len == len && entry.scan_offset >= len {
            return entry.usage.clone();
        }
    }

    let append_only = cached.as_ref().is_some_and(|entry| {
        identity.is_reliable()
            && entry.identity == identity
            && len > entry.len
            && entry.scan_offset <= len
    });
    let mut entry = if append_only {
        cached.expect("append_only requires cache entry")
    } else {
        UsageCacheEntry {
            identity: identity.clone(),
            modified_nanos: None,
            len: 0,
            scan_offset: 0,
            prompt_ids: HashSet::new(),
            usage: SessionTokenUsage::default(),
        }
    };

    let Ok(file) = fs::File::open(path) else {
        return SessionTokenUsage::default();
    };
    let mut reader = BufReader::new(file);
    if reader.seek(SeekFrom::Start(entry.scan_offset)).is_err() {
        return SessionTokenUsage::default();
    }
    let mut line = String::new();
    loop {
        line.clear();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(_) => {
                entry.usage.incomplete = true;
                break;
            }
        };
        if read == 0 {
            break;
        }
        // A writer may be midway through the last JSON line. Retry it later.
        if !line.ends_with('\n') {
            break;
        }
        entry.scan_offset = entry.scan_offset.saturating_add(read as u64);
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            entry.usage.incomplete = true;
            continue;
        };
        let Some(turn) = completed_turn_usage(&message) else {
            continue;
        };
        if let Some(prompt_id) = turn.prompt_id {
            if !entry.prompt_ids.insert(prompt_id.to_owned()) {
                continue;
            }
        }
        entry.usage.available = true;
        entry.usage.total_tokens = entry.usage.total_tokens.saturating_add(turn.total_tokens);
        entry.usage.incomplete |= turn.incomplete;
    }
    entry.modified_nanos = modified_nanos;
    entry.len = len;
    entry.identity = identity;
    let usage = entry.usage.clone();
    usage_cache().lock().insert(path.to_path_buf(), entry);
    usage
}

/// Return the persisted/in-memory value without scanning the update log.
///
/// The boolean is true when the log has changed since the cached scan or no
/// compatible cache entry exists, allowing the UI to paint first and hydrate
/// usage in the background.
pub fn session_token_usage_snapshot(path: &Path) -> (SessionTokenUsage, bool) {
    let Ok(metadata) = fs::metadata(path) else {
        return (SessionTokenUsage::default(), false);
    };
    let len = metadata.len();
    let identity = file_identity(path, &metadata);
    let modified_nanos = modified_nanos(&metadata);
    let cached = usage_cache().lock().get(path).cloned();
    let Some(entry) = cached else {
        return (SessionTokenUsage::default(), true);
    };
    if !identity.is_reliable()
        || entry.identity != identity
        || len < entry.scan_offset
        || len < entry.len
    {
        return (SessionTokenUsage::default(), true);
    }
    let pending =
        entry.modified_nanos != modified_nanos || entry.len != len || entry.scan_offset < len;
    (entry.usage, pending)
}

fn u64_field(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn i64_field(value: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| {
            value.get(*key).and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_u64().and_then(|n| i64::try_from(n).ok()))
            })
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn parses_total_and_fresh_turn_tokens() {
        let message = json!({
            "params": { "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "prompt-1",
                "usage": {
                    "inputTokens": 100,
                    "cachedReadTokens": 40,
                    "outputTokens": 25,
                    "totalTokens": 125
                }
            }}
        });
        let usage = completed_turn_usage(&message).expect("turn usage");
        assert_eq!(usage.prompt_id, Some("prompt-1"));
        assert_eq!(usage.total_tokens, 125);
        assert_eq!(usage.fresh_tokens, 85);
        assert_eq!(usage.cost_usd_ticks, 0);
        assert!(!usage.incomplete);
    }

    #[test]
    fn parses_cost_usd_ticks_when_complete() {
        let message = json!({
            "params": { "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "prompt-2",
                "usage": {
                    "inputTokens": 100,
                    "outputTokens": 10,
                    "totalTokens": 110,
                    "costUsdTicks": 75_192_000
                }
            }}
        });
        let usage = completed_turn_usage(&message).expect("turn usage");
        assert_eq!(usage.cost_usd_ticks, 75_192_000);
    }

    #[test]
    fn scrubs_cost_when_usage_incomplete_or_partial() {
        let incomplete = json!({
            "params": { "update": {
                "sessionUpdate": "turn_completed",
                "usage": {
                    "totalTokens": 10,
                    "costUsdTicks": 99,
                    "usageIsIncomplete": true
                }
            }}
        });
        assert_eq!(
            completed_turn_usage(&incomplete)
                .expect("turn")
                .cost_usd_ticks,
            0
        );

        let partial = json!({
            "params": { "update": {
                "sessionUpdate": "turn_completed",
                "usage": {
                    "totalTokens": 10,
                    "costUsdTicks": 99,
                    "costIsPartial": true
                }
            }}
        });
        assert_eq!(
            completed_turn_usage(&partial).expect("turn").cost_usd_ticks,
            0
        );
    }

    #[test]
    fn accumulates_only_appended_unique_prompt_usage() {
        let path = std::env::temp_dir().join(format!(
            "pinkcode-session-usage-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let first = json!({
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "one",
                "usage": { "totalTokens": 10 }
            }
        });
        fs::write(&path, format!("{first}\n")).expect("write first update");
        assert_eq!(session_token_usage(&path).total_tokens, 10);

        let second = json!({
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "two",
                "usage": { "totalTokens": 20 }
            }
        });
        let duplicate = json!({
            "update": {
                "sessionUpdate": "turn_completed",
                "prompt_id": "one",
                "usage": { "totalTokens": 10 }
            }
        });
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open update log");
        writeln!(file, "{second}").expect("append second update");
        writeln!(file, "{duplicate}").expect("append duplicate update");

        let usage = session_token_usage(&path);
        assert!(usage.available);
        assert_eq!(usage.total_tokens, 30);
        fs::remove_file(path).expect("remove update log");
    }

    #[test]
    fn snapshot_is_non_scanning_and_marks_appends_pending() {
        let path = std::env::temp_dir().join(format!(
            "pinkcode-session-usage-snapshot-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let first = "{\"update\":{\"sessionUpdate\":\"turn_completed\",\"prompt_id\":\"one\",\"usage\":{\"totalTokens\":10}}}\n";
        fs::write(&path, first).expect("write first update");

        let (cold, pending) = session_token_usage_snapshot(&path);
        assert_eq!(cold.total_tokens, 0);
        assert!(pending);

        assert_eq!(session_token_usage(&path).total_tokens, 10);
        let (warm, pending) = session_token_usage_snapshot(&path);
        assert_eq!(warm.total_tokens, 10);
        assert!(!pending);

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open update log");
        writeln!(
            file,
            "{{\"update\":{{\"sessionUpdate\":\"turn_completed\",\"prompt_id\":\"two\",\"usage\":{{\"totalTokens\":20}}}}}}"
        )
        .expect("append second update");
        drop(file);

        let (stale, pending) = session_token_usage_snapshot(&path);
        // Small Windows files use their whole (<4 KiB) prefix as identity, so
        // an append intentionally invalidates the snapshot instead of showing
        // a possibly replaced file's stale total.
        #[cfg(windows)]
        assert_eq!(stale.total_tokens, 0);
        #[cfg(not(windows))]
        assert_eq!(stale.total_tokens, 10);
        assert!(pending);
        assert_eq!(session_token_usage(&path).total_tokens, 30);

        usage_cache().lock().remove(&path);
        fs::remove_file(path).expect("remove update log");
    }

    #[test]
    fn rebuilds_after_a_larger_replacement_log() {
        let path = std::env::temp_dir().join(format!(
            "pinkcode-session-usage-replacement-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::write(
            &path,
            "{\"update\":{\"sessionUpdate\":\"turn_completed\",\"prompt_id\":\"old\",\"usage\":{\"totalTokens\":10}}}\n",
        )
        .expect("write old log");
        assert_eq!(session_token_usage(&path).total_tokens, 10);

        let replacement = path.with_extension("replacement");
        fs::write(
            &replacement,
            "{\"update\":{\"sessionUpdate\":\"turn_completed\",\"prompt_id\":\"new\",\"usage\":{\"totalTokens\":200}}}\n",
        )
        .expect("write replacement log");
        fs::remove_file(&path).expect("remove old log");
        fs::rename(&replacement, &path).expect("replace log");

        assert_eq!(session_token_usage(&path).total_tokens, 200);
        fs::remove_file(path).expect("remove replacement log");
    }
}
