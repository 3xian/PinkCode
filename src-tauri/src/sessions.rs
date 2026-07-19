use crate::models::{
    ActiveSession, DashboardStats, HunkRecord, SessionCard, SessionDetail, SessionStatus,
};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, SessionError>;

pub fn grok_home() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok")
}

pub fn sessions_root() -> PathBuf {
    grok_home().join("sessions")
}

pub fn read_active_sessions() -> Result<Vec<ActiveSession>> {
    let path = grok_home().join("active_sessions.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<ActiveSession> = serde_json::from_str(&raw)?;
    Ok(list)
}

fn load_json_value(path: &Path) -> Result<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&raw)?))
}

fn u64_field(v: &Value, keys: &[&str]) -> u64 {
    for key in keys {
        if let Some(n) = v.get(*key).and_then(|x| x.as_u64()) {
            return n;
        }
        if let Some(n) = v.get(*key).and_then(|x| x.as_f64()) {
            return n as u64;
        }
    }
    0
}

fn str_field(v: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

fn tools_used(signals: &Value) -> Vec<String> {
    signals
        .get("toolsUsed")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn build_card(
    id: &str,
    cwd: &str,
    summary: &Value,
    signals: Option<&Value>,
    active: Option<&ActiveSession>,
) -> SessionCard {
    let title = str_field(summary, &["generated_title", "session_summary", "title"])
        .unwrap_or_else(|| id.chars().take(8).collect::<String>());

    let error_count = signals.map(|s| u64_field(s, &["errorCount"])).unwrap_or(0);
    let status = if active.is_some() {
        if error_count > 0 {
            SessionStatus::Error
        } else {
            SessionStatus::Active
        }
    } else if error_count > 0 {
        SessionStatus::Error
    } else {
        SessionStatus::Idle
    };

    SessionCard {
        id: id.to_string(),
        cwd: cwd.to_string(),
        title,
        model_id: str_field(summary, &["current_model_id"]),
        agent_name: str_field(summary, &["agent_name"]),
        head_branch: str_field(summary, &["head_branch"]),
        created_at: str_field(summary, &["created_at"]),
        updated_at: str_field(summary, &["updated_at"]),
        last_active_at: str_field(summary, &["last_active_at"]),
        num_messages: u64_field(summary, &["num_messages"]),
        is_active: active.is_some(),
        active_pid: active.map(|a| a.pid),
        status,
        context_tokens_used: signals
            .map(|s| u64_field(s, &["contextTokensUsed"]))
            .unwrap_or(0),
        context_window_tokens: signals
            .map(|s| u64_field(s, &["contextWindowTokens"]))
            .unwrap_or(0),
        context_window_usage: signals
            .map(|s| u64_field(s, &["contextWindowUsage"]))
            .unwrap_or(0),
        tool_call_count: signals.map(|s| u64_field(s, &["toolCallCount"])).unwrap_or(0),
        turn_count: signals.map(|s| u64_field(s, &["turnCount"])).unwrap_or(0),
        tools_used: signals.map(tools_used).unwrap_or_default(),
        agent_lines_added: signals
            .map(|s| u64_field(s, &["agentLinesAdded"]))
            .unwrap_or(0),
        agent_lines_removed: signals
            .map(|s| u64_field(s, &["agentLinesRemoved"]))
            .unwrap_or(0),
        agent_files_touched: signals
            .map(|s| u64_field(s, &["agentFilesTouched"]))
            .unwrap_or(0),
        session_duration_seconds: signals
            .map(|s| u64_field(s, &["sessionDurationSeconds"]))
            .unwrap_or(0),
        error_count,
    }
}

fn decode_cwd_dir_name(name: &str) -> String {
    urlencoding::decode(name)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| name.to_string())
}

fn find_session_dir(session_id: &str) -> Result<(PathBuf, String)> {
    let root = sessions_root();
    if !root.exists() {
        return Err(SessionError::NotFound(session_id.to_string()));
    }

    for group in fs::read_dir(&root)? {
        let group = group?;
        if !group.file_type()?.is_dir() {
            continue;
        }
        let group_name = group.file_name().to_string_lossy().to_string();
        if group_name == "session_search.sqlite" || group_name.starts_with('.') {
            continue;
        }
        let session_path = group.path().join(session_id);
        if session_path.is_dir() {
            let cwd = if group.path().join(".cwd").exists() {
                fs::read_to_string(group.path().join(".cwd"))
                    .unwrap_or_else(|_| decode_cwd_dir_name(&group_name))
                    .trim()
                    .to_string()
            } else {
                decode_cwd_dir_name(&group_name)
            };
            return Ok((session_path, cwd));
        }
    }

    Err(SessionError::NotFound(session_id.to_string()))
}

pub fn list_sessions(limit: Option<usize>) -> Result<Vec<SessionCard>> {
    let root = sessions_root();
    if !root.exists() {
        return Ok(Vec::new());
    }

    let active = read_active_sessions().unwrap_or_default();
    let active_map: HashMap<String, ActiveSession> = active
        .into_iter()
        .map(|a| (a.session_id.clone(), a))
        .collect();

    let mut cards = Vec::new();

    for group in fs::read_dir(&root)? {
        let group = group?;
        if !group.file_type()?.is_dir() {
            continue;
        }
        let group_name = group.file_name().to_string_lossy().to_string();
        if group_name.starts_with('.') {
            continue;
        }

        let cwd = if group.path().join(".cwd").exists() {
            fs::read_to_string(group.path().join(".cwd"))
                .unwrap_or_else(|_| decode_cwd_dir_name(&group_name))
                .trim()
                .to_string()
        } else {
            decode_cwd_dir_name(&group_name)
        };

        for entry in fs::read_dir(group.path())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let summary_path = entry.path().join("summary.json");
            let summary = match load_json_value(&summary_path)? {
                Some(v) => v,
                None => continue,
            };
            let signals = load_json_value(&entry.path().join("signals.json"))?;
            let card = build_card(
                &id,
                &cwd,
                &summary,
                signals.as_ref(),
                active_map.get(&id),
            );
            cards.push(card);
        }
    }

    cards.sort_by(|a, b| {
        // Active first, then by last_active_at / updated_at desc
        b.is_active
            .cmp(&a.is_active)
            .then_with(|| {
                let a_ts = a
                    .last_active_at
                    .as_ref()
                    .or(a.updated_at.as_ref())
                    .cloned()
                    .unwrap_or_default();
                let b_ts = b
                    .last_active_at
                    .as_ref()
                    .or(b.updated_at.as_ref())
                    .cloned()
                    .unwrap_or_default();
                b_ts.cmp(&a_ts)
            })
    });

    if let Some(n) = limit {
        cards.truncate(n);
    }

    Ok(cards)
}

fn read_jsonl_tail(path: &Path, max_lines: usize) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut ring: std::collections::VecDeque<Value> =
        std::collections::VecDeque::with_capacity(max_lines);

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
            if ring.len() == max_lines {
                ring.pop_front();
            }
            ring.push_back(v);
        }
    }

    Ok(ring.into_iter().collect())
}

fn parse_hunk(v: &Value) -> HunkRecord {
    HunkRecord {
        hunk_id: str_field(v, &["hunkId", "hunk_id"]),
        file_path: str_field(v, &["filePath", "file_path"]).unwrap_or_else(|| "unknown".into()),
        hunk_start: v
            .get("hunkStart")
            .or_else(|| v.get("hunk_start"))
            .and_then(|x| x.as_u64()),
        hunk_end: v
            .get("hunkEnd")
            .or_else(|| v.get("hunk_end"))
            .and_then(|x| x.as_u64()),
        lines_added: u64_field(v, &["linesAdded", "lines_added"]),
        lines_removed: u64_field(v, &["linesRemoved", "lines_removed"]),
        author_type: str_field(v, &["authorType", "author_type"]),
        session_id: str_field(v, &["sessionId", "session_id"]),
        timestamp: str_field(v, &["timestamp"]),
    }
}

pub fn list_hunks(session_id: &str, limit: Option<usize>) -> Result<Vec<HunkRecord>> {
    let (dir, _) = find_session_dir(session_id)?;
    let path = dir.join("hunk_records.jsonl");
    let max = limit.unwrap_or(200);
    let values = read_jsonl_tail(&path, max)?;
    let mut hunks: Vec<HunkRecord> = values.iter().map(parse_hunk).collect();
    hunks.reverse(); // newest first after tail
    // tail keeps last N in file order (oldest->newest in ring). reverse for newest first.
    Ok(hunks)
}

pub fn get_session_detail(session_id: &str) -> Result<SessionDetail> {
    let (dir, cwd) = find_session_dir(session_id)?;
    let summary = load_json_value(&dir.join("summary.json"))?
        .ok_or_else(|| SessionError::NotFound(session_id.to_string()))?;
    let signals = load_json_value(&dir.join("signals.json"))?;

    let active = read_active_sessions()
        .unwrap_or_default()
        .into_iter()
        .find(|a| a.session_id == session_id);

    let card = build_card(
        session_id,
        &cwd,
        &summary,
        signals.as_ref(),
        active.as_ref(),
    );

    let recent_events = read_jsonl_tail(&dir.join("events.jsonl"), 40)?;
    let recent_updates = read_jsonl_tail(&dir.join("updates.jsonl"), 60)?;
    let hunks = list_hunks(session_id, Some(100))?;

    Ok(SessionDetail {
        card,
        summary_raw: summary,
        signals_raw: signals,
        recent_events,
        recent_updates,
        hunks,
    })
}

pub fn dashboard_stats() -> Result<DashboardStats> {
    let cards = list_sessions(None)?;
    let active = cards.iter().filter(|c| c.is_active).count();
    Ok(DashboardStats {
        total_sessions: cards.len(),
        active_sessions: active,
        total_context_tokens: cards.iter().map(|c| c.context_tokens_used).sum(),
        total_tool_calls: cards.iter().map(|c| c.tool_call_count).sum(),
        total_files_touched: cards.iter().map(|c| c.agent_files_touched).sum(),
        total_lines_added: cards.iter().map(|c| c.agent_lines_added).sum(),
        total_lines_removed: cards.iter().map(|c| c.agent_lines_removed).sum(),
        grok_home: grok_home().display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_local_sessions() {
        let cards = list_sessions(Some(5)).expect("list sessions");
        assert!(!cards.is_empty(), "expected at least one local grok session");
        println!("first: {} — {}", cards[0].id, cards[0].title);
        let stats = dashboard_stats().expect("stats");
        assert!(stats.total_sessions >= cards.len());
    }

    #[test]
    fn loads_detail_for_first_session() {
        let cards = list_sessions(Some(1)).expect("list");
        let id = &cards[0].id;
        let detail = get_session_detail(id).expect("detail");
        assert_eq!(detail.card.id, *id);
    }
}
