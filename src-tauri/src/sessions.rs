use crate::models::{
    ActiveSession, DashboardStats, HunkRecord, SessionCard, SessionDetail, SessionStatus,
    TokenDayPoint, TokenUsageSeries,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Cache expensive full-tree `updates.jsonl` scans (window drag / FS storms).
const TOKEN_SERIES_CACHE_TTL: Duration = Duration::from_secs(45);

struct TokenSeriesCache {
    at: Instant,
    window_days: u32,
    value: TokenUsageSeries,
}

fn token_series_cache() -> &'static Mutex<Option<TokenSeriesCache>> {
    static CACHE: OnceLock<Mutex<Option<TokenSeriesCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone)]
struct JsonFileCache {
    modified: Option<SystemTime>,
    len: u64,
    value: Value,
}

fn json_file_cache() -> &'static Mutex<HashMap<PathBuf, JsonFileCache>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, JsonFileCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

type SessionLocation = (PathBuf, String);

fn session_dir_cache() -> &'static Mutex<HashMap<String, SessionLocation>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SessionLocation>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

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
        json_file_cache().lock().remove(path);
        return Ok(None);
    }
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified().ok();
    if let Some(cached) = json_file_cache().lock().get(path) {
        if cached.len == metadata.len() && cached.modified == modified {
            return Ok(Some(cached.value.clone()));
        }
    }
    let raw = fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&raw)?;
    json_file_cache().lock().insert(
        path.to_path_buf(),
        JsonFileCache {
            modified,
            len: metadata.len(),
            value: value.clone(),
        },
    );
    Ok(Some(value))
}

/// Load the files needed for a session card without letting one corrupt session
/// make the entire dashboard unavailable. Summary is required; signals are optional.
fn load_session_metadata(dir: &Path) -> Option<(Value, Option<Value>)> {
    let summary_path = dir.join("summary.json");
    let summary = match load_json_value(&summary_path) {
        Ok(Some(value)) => value,
        Ok(None) => return None,
        Err(error) => {
            eprintln!(
                "[sessions] skipping invalid {}: {error}",
                summary_path.display()
            );
            return None;
        }
    };

    let signals_path = dir.join("signals.json");
    let signals = match load_json_value(&signals_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "[sessions] ignoring invalid {}: {error}",
                signals_path.display()
            );
            None
        }
    };
    Some((summary, signals))
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
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            // Suffix is more distinctive than UUID prefix (UUIDs share version/variant bits).
            let n = id.chars().count();
            let suffix: String = if n <= 6 {
                id.to_string()
            } else {
                id.chars().skip(n - 6).collect()
            };
            format!("Session: {suffix}")
        });

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
        tool_call_count: signals
            .map(|s| u64_field(s, &["toolCallCount"]))
            .unwrap_or(0),
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
    let cached = { session_dir_cache().lock().get(session_id).cloned() };
    if let Some(cached) = cached {
        if cached.0.is_dir() {
            return Ok(cached);
        }
        session_dir_cache().lock().remove(session_id);
    }

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
            let location = (session_path, cwd);
            session_dir_cache()
                .lock()
                .insert(session_id.to_string(), location.clone());
            return Ok(location);
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
            let Some((summary, signals)) = load_session_metadata(&entry.path()) else {
                continue;
            };
            let card = build_card(&id, &cwd, &summary, signals.as_ref(), active_map.get(&id));
            // Drop empty system-temp sessions (ACP tests, handshake probes, etc.).
            if crate::session_noise::is_noise_session(&card) {
                continue;
            }
            session_dir_cache()
                .lock()
                .insert(id.clone(), (entry.path(), cwd.clone()));
            cards.push(card);
        }
    }

    cards.sort_by(|a, b| {
        // Active first, then by last_active_at / updated_at desc
        b.is_active.cmp(&a.is_active).then_with(|| {
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
    if !path.exists() || max_lines == 0 {
        return Ok(Vec::new());
    }
    const BLOCK_SIZE: usize = 16 * 1024;
    let mut file = fs::File::open(path)?;
    let mut position = file.metadata()?.len();
    let mut buffer = Vec::new();

    loop {
        let read_len = position.min(BLOCK_SIZE as u64) as usize;
        position -= read_len as u64;
        file.seek(SeekFrom::Start(position))?;
        let mut chunk = vec![0; read_len];
        file.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&buffer);
        buffer = chunk;

        let text = String::from_utf8_lossy(&buffer);
        let complete_lines = if position > 0 {
            text.lines().skip(1).collect::<Vec<_>>()
        } else {
            text.lines().collect::<Vec<_>>()
        };
        let valid_count = complete_lines
            .iter()
            .filter(|line| serde_json::from_str::<Value>(line.trim()).is_ok())
            .count();
        if position == 0 || valid_count >= max_lines {
            break;
        }
    }

    let text = String::from_utf8_lossy(&buffer);
    let lines: Vec<_> = if position > 0 {
        text.lines().skip(1).collect()
    } else {
        text.lines().collect()
    };
    let mut values: Vec<Value> = lines
        .into_iter()
        .rev()
        .filter_map(|line| serde_json::from_str(line.trim()).ok())
        .take(max_lines)
        .collect();
    values.reverse();
    Ok(values)
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

    // Keep tails modest so first detail paint stays fast (huge sessions exist).
    let recent_events = read_jsonl_tail(&dir.join("events.jsonl"), 30)?;
    let recent_updates = read_jsonl_tail(&dir.join("updates.jsonl"), 120)?;
    let hunks = list_hunks(session_id, Some(50))?;

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

/// Aggregate turn-level token usage from session `updates.jsonl` for the last `window_days`.
///
/// Prefer **fresh input + output** (`input − cachedRead + output`) so re-sent context is not
/// counted as new spend. Falls back to `totalTokens` when breakdown fields are missing.
///
/// Results are cached briefly — a full tree scan is too heavy to run on every FS tick.
pub fn token_usage_series(window_days: u32) -> Result<TokenUsageSeries> {
    let days_u32 = window_days.clamp(1, 31);
    {
        let cache = token_series_cache().lock();
        if let Some(c) = cache.as_ref() {
            if c.window_days == days_u32 && c.at.elapsed() < TOKEN_SERIES_CACHE_TTL {
                return Ok(c.value.clone());
            }
        }
    }
    let value = token_usage_series_uncached(days_u32)?;
    *token_series_cache().lock() = Some(TokenSeriesCache {
        at: Instant::now(),
        window_days: days_u32,
        value: value.clone(),
    });
    Ok(value)
}

fn token_usage_series_uncached(window_days: u32) -> Result<TokenUsageSeries> {
    let days = window_days as usize;
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day_secs = 86_400u64;
    let today_index = now_secs / day_secs;
    // Inclusive window: today and previous (days-1) UTC days.
    let start_index = today_index.saturating_sub((days as u64).saturating_sub(1));
    let start_secs = start_index * day_secs;

    let mut by_day: HashMap<u64, (u64, u64)> = HashMap::new(); // day_index -> (tokens, turns)

    let root = sessions_root();
    if root.exists() {
        for group in fs::read_dir(&root)? {
            let group = group?;
            if !group.file_type()?.is_dir() {
                continue;
            }
            let group_name = group.file_name().to_string_lossy().to_string();
            if group_name.starts_with('.') {
                continue;
            }
            for entry in fs::read_dir(group.path())? {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                // Skip clearly stale sessions (summary last activity before window).
                let summary_path = entry.path().join("summary.json");
                if let Ok(Some(summary)) = load_json_value(&summary_path) {
                    if let Some(ts) = summary_activity_unix(&summary) {
                        if ts + day_secs < start_secs {
                            continue;
                        }
                    }
                }
                let updates = entry.path().join("updates.jsonl");
                if !updates.is_file() {
                    continue;
                }
                accumulate_turn_usage_from_jsonl(&updates, start_secs, &mut by_day)?;
            }
        }
    }

    let mut points = Vec::with_capacity(days);
    let mut total_tokens = 0u64;
    let mut total_turns = 0u64;
    for i in 0..days as u64 {
        let day_index = start_index + i;
        let (tokens, turns) = by_day.get(&day_index).copied().unwrap_or((0, 0));
        total_tokens = total_tokens.saturating_add(tokens);
        total_turns = total_turns.saturating_add(turns);
        points.push(TokenDayPoint {
            date: day_index_to_ymd(day_index),
            tokens,
            turns,
        });
    }

    Ok(TokenUsageSeries {
        days: points,
        total_tokens,
        total_turns,
        window_days: days as u32,
    })
}

fn day_index_to_ymd(day_index: u64) -> String {
    let secs = day_index.saturating_mul(86_400);
    let (y, mo, d, _, _, _) = unix_secs_to_utc(secs);
    format!("{y:04}-{mo:02}-{d:02}")
}

/// Howard Hinnant civil-from-days (UTC), shared with agent_manager timestamps.
fn unix_secs_to_utc(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let ss = (secs % 60) as u32;
    let mins = secs / 60;
    let mi = (mins % 60) as u32;
    let hours = mins / 60;
    let h = (hours % 24) as u32;
    let days = (hours / 24) as i64;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (if mo <= 2 { y + 1 } else { y }) as i32;
    (y, mo, d, h, mi, ss)
}

fn summary_activity_unix(summary: &Value) -> Option<u64> {
    for key in ["last_active_at", "updated_at", "created_at"] {
        if let Some(s) = summary.get(key).and_then(|v| v.as_str()) {
            if let Some(secs) = parse_iso_ish_to_unix(s) {
                return Some(secs);
            }
        }
    }
    None
}

/// Best-effort ISO-8601 → unix seconds (handles Z, numeric offsets, and fractions).
fn parse_iso_ish_to_unix(s: &str) -> Option<u64> {
    // Fast path: pure unix seconds / millis as string.
    if let Ok(n) = s.parse::<u64>() {
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    let s = s.trim();
    let (s, offset_seconds) = split_iso_offset(s)?;
    let (date, time) = if let Some((d, t)) = s.split_once('T') {
        (d, t)
    } else {
        return None;
    };
    let time = time.split('.').next().unwrap_or(time);
    let mut dp = date.split('-');
    let y: i32 = dp.next()?.parse().ok()?;
    let mo: u32 = dp.next()?.parse().ok()?;
    let d: u32 = dp.next()?.parse().ok()?;
    let mut tp = time.split(':');
    let h: u32 = tp.next()?.parse().ok()?;
    let mi: u32 = tp.next()?.parse().ok()?;
    let sec: u32 = tp.next().unwrap_or("0").parse().ok()?;
    let local_as_utc = utc_ymd_hms_to_unix(y, mo, d, h, mi, sec) as i64;
    Some(local_as_utc.saturating_sub(offset_seconds).max(0) as u64)
}

fn split_iso_offset(s: &str) -> Option<(&str, i64)> {
    if let Some(base) = s.strip_suffix('Z').or_else(|| s.strip_suffix('z')) {
        return Some((base, 0));
    }
    let tpos = s.find('T')?;
    let offset_index = s
        .char_indices()
        .rev()
        .find(|(index, ch)| *index > tpos && (*ch == '+' || *ch == '-'))
        .map(|(index, _)| index);
    let Some(index) = offset_index else {
        // Preserve the previous behavior for timestamps without an explicit zone.
        return Some((s, 0));
    };

    let offset = &s[index..];
    let sign = if offset.starts_with('-') { -1i64 } else { 1i64 };
    let digits = &offset[1..];
    let (hours, minutes) = if let Some((h, m)) = digits.split_once(':') {
        (h, m)
    } else if digits.len() == 4 {
        (&digits[..2], &digits[2..])
    } else {
        return None;
    };
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    Some((&s[..index], sign * (hours * 3600 + minutes * 60)))
}

fn utc_ymd_hms_to_unix(y: i32, mo: u32, d: u32, h: u32, mi: u32, sec: u32) -> u64 {
    // days_from_civil (Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146_097 + doe as i64 - 719_468;
    let secs = days * 86_400 + (h as i64) * 3600 + (mi as i64) * 60 + sec as i64;
    secs.max(0) as u64
}

/// Cap per-file scan: full-file reads of multi‑MB `updates.jsonl` freeze startup.
const TOKEN_JSONL_MAX_BYTES: u64 = 1_500_000;

fn accumulate_turn_usage_from_jsonl(
    path: &Path,
    start_secs: u64,
    by_day: &mut HashMap<u64, (u64, u64)>,
) -> Result<()> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    // Large session logs: only the tail matters for a short usage window.
    if len > TOKEN_JSONL_MAX_BYTES {
        let start = len - TOKEN_JSONL_MAX_BYTES;
        file.seek(SeekFrom::Start(start))?;
    }
    let mut reader = BufReader::new(file);
    // If we seeked mid-file, drop the first partial line.
    if len > TOKEN_JSONL_MAX_BYTES {
        let mut discard = String::new();
        let _ = reader.read_line(&mut discard);
    }
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Cheap filter before full JSON parse.
        if !line.contains("turn_completed") || !line.contains("usage") {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let update = msg
            .pointer("/params/update")
            .or_else(|| msg.get("update"))
            .cloned()
            .unwrap_or(Value::Null);
        let session_update = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if session_update != "turn_completed" {
            continue;
        }
        let usage = match update.get("usage") {
            Some(u) => u,
            None => continue,
        };
        let tokens = turn_consumed_tokens(usage);
        if tokens == 0 {
            continue;
        }
        let ts = extract_update_unix_secs(&msg).unwrap_or(0);
        if ts < start_secs {
            continue;
        }
        let day_index = ts / 86_400;
        let entry = by_day.entry(day_index).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(tokens);
        entry.1 = entry.1.saturating_add(1);
    }
    Ok(())
}

fn turn_consumed_tokens(usage: &Value) -> u64 {
    let input = u64_field(usage, &["inputTokens", "input_tokens"]);
    let output = u64_field(usage, &["outputTokens", "output_tokens"]);
    let cached = u64_field(usage, &["cachedReadTokens", "cached_read_tokens"]);
    if input > 0 || output > 0 {
        return input.saturating_sub(cached).saturating_add(output);
    }
    u64_field(usage, &["totalTokens", "total_tokens"])
}

fn extract_update_unix_secs(msg: &Value) -> Option<u64> {
    // Prefer agent wall-clock ms when present.
    if let Some(ms) = msg
        .pointer("/params/update/_meta/agentTimestampMs")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            msg.pointer("/params/_meta/agentTimestampMs")
                .and_then(|v| v.as_u64())
        })
    {
        return Some(if ms > 10_000_000_000 { ms / 1000 } else { ms });
    }
    if let Some(n) = msg.get("timestamp").and_then(|v| v.as_u64()) {
        return Some(if n > 10_000_000_000 { n / 1000 } else { n });
    }
    if let Some(s) = msg.get("timestamp").and_then(|v| v.as_str()) {
        return parse_iso_ish_to_unix(s);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_usage_series_returns_window() {
        let s = token_usage_series(7).expect("series");
        assert_eq!(s.days.len(), 7);
        assert_eq!(s.window_days, 7);
        // Dates should be contiguous YYYY-MM-DD
        for p in &s.days {
            assert_eq!(p.date.len(), 10);
            assert!(p.date.chars().nth(4) == Some('-'));
        }
    }

    #[test]
    fn turn_consumed_excludes_cache() {
        let usage = serde_json::json!({
            "inputTokens": 1000,
            "outputTokens": 50,
            "cachedReadTokens": 800,
            "totalTokens": 1050
        });
        assert_eq!(turn_consumed_tokens(&usage), 250);
    }

    #[test]
    fn iso_offsets_are_converted_to_utc() {
        assert_eq!(
            parse_iso_ish_to_unix("2026-07-21T00:30:00+08:00"),
            parse_iso_ish_to_unix("2026-07-20T16:30:00Z")
        );
        assert_eq!(
            parse_iso_ish_to_unix("2026-07-20T23:30:00-01:00"),
            parse_iso_ish_to_unix("2026-07-21T00:30:00Z")
        );
        assert_eq!(
            parse_iso_ish_to_unix("2026-07-21T00:30:00+0800"),
            parse_iso_ish_to_unix("2026-07-20T16:30:00Z")
        );
    }

    #[test]
    fn corrupt_session_metadata_is_isolated() {
        let dir = std::env::temp_dir().join(format!(
            "marsbuild-session-metadata-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("fixture dir");
        fs::write(dir.join("summary.json"), "{").expect("bad summary");
        assert!(load_session_metadata(&dir).is_none());

        fs::write(dir.join("summary.json"), r#"{"title":"valid"}"#).expect("summary");
        fs::write(dir.join("signals.json"), "{").expect("bad signals");
        let (summary, signals) = load_session_metadata(&dir).expect("valid summary remains usable");
        assert_eq!(summary["title"], "valid");
        assert!(signals.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn jsonl_tail_reads_last_valid_records_across_blocks() {
        let path = std::env::temp_dir().join(format!(
            "marsbuild-tail-{}-{}.jsonl",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let mut content = String::new();
        for index in 0..120 {
            content.push_str(
                &serde_json::json!({ "index": index, "padding": "x".repeat(300) }).to_string(),
            );
            content.push('\n');
        }
        fs::write(&path, content).expect("write fixture");

        let tail = read_jsonl_tail(&path, 3).expect("read tail");
        let _ = fs::remove_file(&path);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0]["index"], 117);
        assert_eq!(tail[2]["index"], 119);
    }

    #[test]
    fn lists_local_sessions_when_available() {
        let cards = list_sessions(Some(5)).expect("list sessions");
        let stats = dashboard_stats().expect("stats");
        assert!(stats.total_sessions >= cards.len());
        if let Some(first) = cards.first() {
            assert!(!first.id.is_empty());
        }
    }

    #[test]
    fn list_sessions_hides_empty_system_temp() {
        let cards = list_sessions(None).expect("list");
        for c in &cards {
            if crate::session_noise::is_system_temp_cwd(&c.cwd) {
                assert!(
                    c.is_active
                        || c.num_messages > 0
                        || c.tool_call_count > 0
                        || c.context_tokens_used > 0,
                    "empty temp session should be filtered: {} {}",
                    c.id,
                    c.cwd
                );
            }
        }
    }

    #[test]
    fn loads_detail_for_first_session_when_available() {
        let cards = list_sessions(Some(1)).expect("list");
        if let Some(card) = cards.first() {
            let detail = get_session_detail(&card.id).expect("detail");
            assert_eq!(detail.card.id, card.id);
        }
    }
}
