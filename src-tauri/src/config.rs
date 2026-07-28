//! Layered PinkCode host configuration (log level + default permission mode).
//!
//! Priority for [`resolve`] (later wins):
//! 1. Built-in defaults
//! 2. Environment (`PINKCODE_*`) — seed when files omit a field; files override env
//! 3. Global file `~/.pinkcode/config.json`
//! 4. Project file `<cwd>/.pinkcode/config.json` — only when `project_cwd` is `Some`
//!
//! Session-scoped permission / plan prefs live in [`crate::task_prefs`] and are
//! **not** merged here. Callers should use
//! [`crate::task_prefs::effective_permission_mode`] (session → last-spawn → this
//! resolve) rather than inventing their own fallback chain.
//!
//! Startup tracing uses `resolve(None)` (env + global only). Config files are
//! read-only from the host today (no settings UI); write path lives in tests
//! via [`crate::fs_atomic`].

use crate::agent_types::PermissionMode;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// On-disk / env-mergeable config document (all fields optional).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLayer {
    /// Tracing / log level directive fragment, e.g. `info`, `debug`, `pinkcode=trace`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// Default host permission mode for new tasks / seed when no last-spawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_permission_mode: Option<PermissionMode>,
}

impl ConfigLayer {
    fn merge_from(&mut self, other: &ConfigLayer) {
        if other.log_level.is_some() {
            self.log_level = other.log_level.clone();
        }
        if other.default_permission_mode.is_some() {
            self.default_permission_mode = other.default_permission_mode;
        }
    }
}

/// Fully resolved host settings after layer merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConfig {
    pub log_level: String,
    pub default_permission_mode: PermissionMode,
}

impl Default for ResolvedConfig {
    fn default() -> Self {
        Self {
            log_level: default_log_level().to_string(),
            default_permission_mode: PermissionMode::Default,
        }
    }
}

fn default_log_level() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "info"
    }
}

/// `~/.pinkcode`
pub fn pinkcode_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pinkcode")
}

pub fn global_config_path() -> PathBuf {
    pinkcode_home().join("config.json")
}

pub fn project_config_path(cwd: &Path) -> PathBuf {
    cwd.join(".pinkcode").join("config.json")
}

fn load_layer_file(path: &Path) -> Result<ConfigLayer, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConfigLayer::default());
        }
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    if raw.trim().is_empty() {
        return Ok(ConfigLayer::default());
    }
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

/// Environment layer (`PINKCODE_LOG_LEVEL`, `PINKCODE_DEFAULT_PERMISSION_MODE`).
pub fn layer_from_env() -> ConfigLayer {
    layer_from_env_reader(|key| std::env::var(key))
}

fn layer_from_env_reader(
    reader: impl Fn(&str) -> Result<String, std::env::VarError>,
) -> ConfigLayer {
    let mut layer = ConfigLayer::default();
    if let Ok(level) = reader("PINKCODE_LOG_LEVEL") {
        let level = level.trim();
        if !level.is_empty() {
            layer.log_level = Some(level.to_string());
        }
    }
    if let Ok(mode) = reader("PINKCODE_DEFAULT_PERMISSION_MODE") {
        if let Some(m) = parse_permission_mode_env(mode.trim()) {
            layer.default_permission_mode = Some(m);
        } else if !mode.trim().is_empty() {
            tracing::warn!(
                value = %mode.trim(),
                "PINKCODE_DEFAULT_PERMISSION_MODE is not a known mode; ignoring"
            );
        }
    }
    layer
}

fn parse_permission_mode_env(raw: &str) -> Option<PermissionMode> {
    match raw.to_ascii_lowercase().as_str() {
        "default" | "ask" | "normal" => Some(PermissionMode::Default),
        "acceptedits" | "accept_edits" | "accept-edits" => Some(PermissionMode::AcceptEdits),
        "auto" => Some(PermissionMode::Auto),
        "bypasspermissions" | "bypass_permissions" | "bypass-permissions" | "yolo"
        | "alwaysapprove" | "always-approve" => Some(PermissionMode::BypassPermissions),
        "dontask" | "dont_ask" | "dont-ask" => Some(PermissionMode::DontAsk),
        _ => None,
    }
}

fn defaults_layer() -> ConfigLayer {
    ConfigLayer {
        log_level: Some(default_log_level().to_string()),
        default_permission_mode: Some(PermissionMode::Default),
    }
}

/// Collapse a fully merged layer into concrete defaults.
fn finalize(merged: ConfigLayer) -> ResolvedConfig {
    ResolvedConfig {
        log_level: merged
            .log_level
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| default_log_level().to_string()),
        default_permission_mode: merged
            .default_permission_mode
            .unwrap_or(PermissionMode::Default),
    }
}

/// Merge defaults → env → global → optional project (later wins).
/// Session-level prefs live in `task_prefs` and are applied by callers.
pub fn resolve(project_cwd: Option<&Path>) -> ResolvedConfig {
    let mut merged = defaults_layer();
    merged.merge_from(&layer_from_env());
    match load_layer_file(&global_config_path()) {
        Ok(global) => merged.merge_from(&global),
        Err(error) => {
            tracing::warn!(error = %error, "failed to load global PinkCode config");
        }
    }
    if let Some(cwd) = project_cwd {
        match load_layer_file(&project_config_path(cwd)) {
            Ok(project) => merged.merge_from(&project),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    cwd = %cwd.display(),
                    "failed to load project PinkCode config"
                );
            }
        }
    }
    finalize(merged)
}

/// Initialize tracing from layered config. Safe to call once at startup.
///
/// `RUST_LOG` (if set) wins over config `log_level` for the EnvFilter.
pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let cfg = resolve(None);
    let filter = match EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(_) => {
            // Config may be a bare level ("info") or a full directive ("pinkcode=debug").
            let directive = cfg.log_level.trim();
            let filter_str = if directive.contains('=') || directive.contains(',') {
                directive.to_string()
            } else {
                format!("pinkcode={directive},info")
            };
            EnvFilter::try_new(&filter_str).unwrap_or_else(|_| EnvFilter::new("info"))
        }
    };

    let result = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .try_init();

    if let Err(error) = result {
        // Already initialized (tests / double run) — not fatal.
        eprintln!("[pinkcode] tracing init skipped: {error}");
    } else {
        tracing::info!(
            log_level = %cfg.log_level,
            default_permission = ?cfg.default_permission_mode,
            "PinkCode config resolved"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!("pinkcode_cfg_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Test-only atomic write (production has no settings UI yet).
    fn write_layer(path: &Path, layer: &ConfigLayer) -> Result<(), String> {
        crate::fs_atomic::write_json_atomic(path, layer)
    }

    #[test]
    fn merge_later_wins() {
        let mut base = ConfigLayer {
            log_level: Some("info".into()),
            default_permission_mode: Some(PermissionMode::Default),
        };
        base.merge_from(&ConfigLayer {
            log_level: Some("debug".into()),
            default_permission_mode: None,
        });
        assert_eq!(base.log_level.as_deref(), Some("debug"));
        assert_eq!(base.default_permission_mode, Some(PermissionMode::Default));
        base.merge_from(&ConfigLayer {
            log_level: None,
            default_permission_mode: Some(PermissionMode::Auto),
        });
        assert_eq!(base.default_permission_mode, Some(PermissionMode::Auto));
        assert_eq!(base.log_level.as_deref(), Some("debug"));
    }

    #[test]
    fn env_layer_parses_modes() {
        let layer = layer_from_env_reader(|key| match key {
            "PINKCODE_LOG_LEVEL" => Ok("trace".into()),
            "PINKCODE_DEFAULT_PERMISSION_MODE" => Ok("auto".into()),
            _ => Err(std::env::VarError::NotPresent),
        });
        assert_eq!(layer.log_level.as_deref(), Some("trace"));
        assert_eq!(layer.default_permission_mode, Some(PermissionMode::Auto));
    }

    #[test]
    fn project_file_roundtrip() {
        // Disk load only — does not call resolve() (avoids real home/env).
        let dir = temp_dir();
        let layer = ConfigLayer {
            log_level: Some("warn".into()),
            default_permission_mode: Some(PermissionMode::AcceptEdits),
        };
        let path = project_config_path(&dir);
        write_layer(&path, &layer).expect("write");
        assert!(path.is_file());
        let loaded = load_layer_file(&path).expect("load");
        assert_eq!(loaded, layer);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_then_finalize_project_wins() {
        // Isolated pure merge — no real ~/.pinkcode or process env.
        let mut merged = defaults_layer();
        merged.merge_from(&ConfigLayer {
            log_level: Some("trace".into()),
            default_permission_mode: Some(PermissionMode::Auto),
        });
        merged.merge_from(&ConfigLayer {
            log_level: Some("warn".into()),
            default_permission_mode: Some(PermissionMode::AcceptEdits),
        });
        let resolved = finalize(merged);
        assert_eq!(resolved.log_level, "warn");
        assert_eq!(
            resolved.default_permission_mode,
            PermissionMode::AcceptEdits
        );
    }

    #[test]
    fn missing_file_is_empty_layer() {
        let dir = temp_dir();
        let loaded = load_layer_file(&project_config_path(&dir)).expect("load");
        assert!(loaded.log_level.is_none());
        assert!(loaded.default_permission_mode.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
