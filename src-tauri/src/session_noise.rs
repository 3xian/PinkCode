//! Filter empty system-temp sessions that clutter the Tasks board
//! (ACP probes, unit tests, handshake junk).

use crate::models::SessionCard;

/// True when `cwd` is the OS temp root or a path under it.
///
/// Uses env `TEMP`/`TMP`/`TMPDIR`, `std::env::temp_dir()`, then well-known
/// platform layouts. Windows 8.3 short paths that miss long-form prefix match
/// are caught by a segment-aware `appdata\local\temp` check (path segment only,
/// not an arbitrary substring of a project name).
pub(crate) fn is_system_temp_cwd(cwd: &str) -> bool {
    let key = normalize_path_key(cwd);
    if key.is_empty() {
        return false;
    }

    for env_key in ["TEMP", "TMP", "TMPDIR"] {
        if let Ok(t) = std::env::var(env_key) {
            if path_is_under(&key, &normalize_path_key(&t)) {
                return true;
            }
        }
    }

    let runtime_temp = normalize_path_key(&std::env::temp_dir().display().to_string());
    if path_is_under(&key, &runtime_temp) {
        return true;
    }

    // Windows: long or 8.3 user temp as a path *segment* (not "my-temp-project").
    if has_path_segment(&key, r"appdata\local\temp") {
        return true;
    }

    // Unix / macOS
    if key == "/tmp"
        || key.starts_with("/tmp/")
        || key == r"\tmp"
        || key.starts_with(r"\tmp\")
        || key == "/var/tmp"
        || key.starts_with("/var/tmp/")
        || has_path_segment(&key, "private\\var\\folders")
        || key.contains("/private/var/folders/")
    {
        return true;
    }

    false
}

/// Ephemeral sessions that should not clutter the Tasks board.
///
/// Keep a temp-cwd session only when it has real work or is currently active
/// (so a live attach is never hidden).
pub(crate) fn is_noise_session(card: &SessionCard) -> bool {
    if !is_system_temp_cwd(&card.cwd) {
        return false;
    }
    if card.is_active {
        return false;
    }
    card.num_messages == 0
        && card.tool_call_count == 0
        && card.context_tokens_used == 0
        && card.turn_count == 0
        && card.agent_files_touched == 0
}

fn normalize_path_key(path: &str) -> String {
    path.trim()
        .replace('/', "\\")
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn path_is_under(key: &str, root: &str) -> bool {
    if root.is_empty() {
        return false;
    }
    key == root || key.starts_with(&(root.to_string() + "\\"))
}

/// True when `segment` appears as a full path segment sequence in `key`.
/// e.g. `appdata\local\temp` matches `c:\users\x\appdata\local\temp\foo`
/// but not `d:\code\my-temp-project`.
fn has_path_segment(key: &str, segment: &str) -> bool {
    if key == segment {
        return true;
    }
    let needle = format!("\\{segment}");
    if let Some(idx) = key.find(&needle) {
        let after = idx + needle.len();
        return after == key.len() || key.as_bytes().get(after) == Some(&b'\\');
    }
    // key starts with segment\...
    key.starts_with(&(segment.to_string() + "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SessionStatus;

    #[test]
    fn system_temp_cwd_is_detected() {
        let temp = std::env::temp_dir();
        assert!(is_system_temp_cwd(&temp.display().to_string()));
        assert!(is_system_temp_cwd(
            &temp.join("pinkcode-probe").display().to_string()
        ));
        // Windows short-path style temp (common under Grok session groups).
        assert!(is_system_temp_cwd(r"C:\Users\ADMINI~1\AppData\Local\Temp\"));
        assert!(is_system_temp_cwd(
            r"C:\Users\ADMINI~1\AppData\Local\Temp\probe"
        ));
        assert!(is_system_temp_cwd("/tmp"));
        assert!(is_system_temp_cwd("/tmp/foo"));
        assert!(!is_system_temp_cwd(r"D:\code\PinkCode"));
        assert!(!is_system_temp_cwd(r"D:\code\my-temp-project"));
        // Project folder merely named Temp is not system temp.
        assert!(!is_system_temp_cwd(r"D:\code\Temp"));
        // Must not match a project that merely embeds the letters "temp".
        assert!(!is_system_temp_cwd(r"D:\code\AppDataLocalTempish"));
    }

    #[test]
    fn empty_temp_session_is_noise_but_active_is_kept() {
        let temp = std::env::temp_dir().display().to_string();
        let idle = SessionCard {
            id: "a".into(),
            cwd: temp.clone(),
            title: "x".into(),
            model_id: None,
            agent_name: None,
            head_branch: None,
            created_at: None,
            updated_at: None,
            last_active_at: None,
            num_messages: 0,
            is_active: false,
            active_pid: None,
            status: SessionStatus::Idle,
            context_tokens_used: 0,
            context_window_tokens: 0,
            context_window_usage: 0,
            total_tokens: 0,
            token_usage_incomplete: false,
            token_usage_available: false,
            token_usage_pending: false,
            tool_call_count: 0,
            turn_count: 0,
            tools_used: vec![],
            agent_lines_added: 0,
            agent_lines_removed: 0,
            agent_files_touched: 0,
            session_duration_seconds: 0,
            error_count: 0,
        };
        assert!(is_noise_session(&idle));

        let mut active = idle.clone();
        active.is_active = true;
        assert!(!is_noise_session(&active));

        let mut worked = idle.clone();
        worked.num_messages = 2;
        assert!(!is_noise_session(&worked));

        let real = SessionCard {
            cwd: r"D:\code\PinkCode".into(),
            ..idle
        };
        assert!(!is_noise_session(&real));
    }
}
