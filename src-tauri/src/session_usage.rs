//! Durable per-session token accounting from Grok's `updates.jsonl` logs.

use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;
#[cfg(not(unix))]
use std::{
    hash::{Hash, Hasher},
    io::Read,
};

#[derive(Clone, Default)]
pub struct SessionTokenUsage {
    pub total_tokens: u64,
    pub incomplete: bool,
    /// False when the log has no compatible completed-turn usage record.
    pub available: bool,
}

#[derive(Clone)]
struct UsageCacheEntry {
    identity: FileIdentity,
    modified: Option<SystemTime>,
    len: u64,
    scan_offset: u64,
    prompt_ids: HashSet<String>,
    usage: SessionTokenUsage,
}

#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(not(unix))]
    prefix_fingerprint: Option<u64>,
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
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct CompletedTurnUsage<'a> {
    pub prompt_id: Option<&'a str>,
    pub total_tokens: u64,
    pub fresh_tokens: u64,
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
        incomplete: usage
            .get("usageIsIncomplete")
            .or_else(|| usage.get("usage_is_incomplete"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Read a session's complete token ledger, incrementally when its append-only
/// update log grows. Rebuild from zero if the file is replaced or truncated.
pub fn session_token_usage(path: &Path) -> SessionTokenUsage {
    let Ok(metadata) = fs::metadata(path) else {
        return SessionTokenUsage::default();
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();
    let identity = file_identity(path, &metadata);
    let cached = usage_cache().lock().get(path).cloned();
    if let Some(entry) = cached.as_ref() {
        if entry.modified == modified && entry.len == len {
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
            modified: None,
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
    entry.modified = modified;
    entry.len = len;
    entry.identity = identity;
    let usage = entry.usage.clone();
    usage_cache().lock().insert(path.to_path_buf(), entry);
    usage
}

fn u64_field(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
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
        assert!(!usage.incomplete);
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
