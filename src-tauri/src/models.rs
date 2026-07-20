use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSession {
    /// On-disk `active_sessions.json` uses snake_case; UI expects camelCase.
    #[serde(alias = "session_id")]
    pub session_id: String,
    pub pid: u32,
    pub cwd: String,
    #[serde(alias = "opened_at")]
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCard {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub model_id: Option<String>,
    pub agent_name: Option<String>,
    pub head_branch: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_active_at: Option<String>,
    pub num_messages: u64,
    pub is_active: bool,
    pub active_pid: Option<u32>,
    pub status: SessionStatus,
    pub context_tokens_used: u64,
    pub context_window_tokens: u64,
    pub context_window_usage: u64,
    pub tool_call_count: u64,
    pub turn_count: u64,
    pub tools_used: Vec<String>,
    pub agent_lines_added: u64,
    pub agent_lines_removed: u64,
    pub agent_files_touched: u64,
    pub session_duration_seconds: u64,
    pub error_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Active,
    Idle,
    Error,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub card: SessionCard,
    pub summary_raw: serde_json::Value,
    pub signals_raw: Option<serde_json::Value>,
    pub recent_events: Vec<serde_json::Value>,
    pub recent_updates: Vec<serde_json::Value>,
    pub hunks: Vec<HunkRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRecord {
    pub hunk_id: Option<String>,
    pub file_path: String,
    pub hunk_start: Option<u64>,
    pub hunk_end: Option<u64>,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub author_type: Option<String>,
    pub session_id: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub total_sessions: usize,
    pub active_sessions: usize,
    pub total_context_tokens: u64,
    pub total_tool_calls: u64,
    pub total_files_touched: u64,
    pub total_lines_added: u64,
    pub total_lines_removed: u64,
    pub grok_home: String,
}

/// One day in the trailing token-usage series (from session `updates.jsonl`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDayPoint {
    /// Calendar day `YYYY-MM-DD` (UTC).
    pub date: String,
    /// Approx. consumed tokens that day (fresh input + output; cache hits excluded).
    pub tokens: u64,
    /// Number of completed turns contributing to `tokens`.
    pub turns: u64,
}

/// Last N days of token usage aggregated from Grok session turn completions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSeries {
    pub days: Vec<TokenDayPoint>,
    pub total_tokens: u64,
    pub total_turns: u64,
    pub window_days: u32,
}
