//! Shared proxy detection: reads env vars + macOS system proxy as fallback.
//!
//! Result is cached via [`detect_proxy`] — proxy hot-switching at runtime is
//! not supported (desktop apps typically resolve proxy once at startup).

use std::sync::OnceLock;

/// Standard proxy environment variable keys.
const PROXY_KEYS: &[&str] = &[
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// Returns the first valid proxy URL found via the given reader, or `None`.
/// Skips values that don't look like a proxy URL (must start with `http://`,
/// `https://`, or `socks` and contain a host).
fn proxy_from_env(reader: impl Fn(&str) -> Result<String, std::env::VarError>) -> Option<String> {
    for key in PROXY_KEYS {
        if let Ok(val) = reader(key) {
            let val = val.trim().to_string();
            if val.is_empty() {
                continue;
            }
            if looks_like_proxy_url(&val) {
                return Some(val);
            }
            tracing::warn!(key, value = %val, "ignoring invalid proxy env value");
        }
    }
    None
}

fn looks_like_proxy_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    // Must have a scheme and a non-empty host portion.
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("socks"))
        && lower.len() > "http://".len()
}

/// Returns a proxy URL, checking env vars first, then macOS system proxy.
/// Result is cached after first call.
pub fn detect_proxy() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED
        .get_or_init(|| proxy_from_env(|k| std::env::var(k)).or_else(detect_macos_system_proxy))
        .clone()
}

/// Detect macOS system HTTP/HTTPS proxy via `networksetup`.
#[cfg(target_os = "macos")]
fn detect_macos_system_proxy() -> Option<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().skip(1) {
        let service = line.trim();
        if !service.is_empty() {
            if let Some(url) = try_proxy_for_service(service) {
                return Some(url);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn try_proxy_for_service(service: &str) -> Option<String> {
    let output = std::process::Command::new("networksetup")
        .args(["-getwebproxy", service])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut enabled = false;
    let mut server = String::new();
    let mut port = String::new();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("Enabled: ") {
            enabled = val == "Yes";
        } else if let Some(val) = line.strip_prefix("Server: ") {
            server = val.to_string();
        } else if let Some(val) = line.strip_prefix("Port: ") {
            port = val.to_string();
        }
    }
    if enabled && !server.is_empty() && !port.is_empty() {
        Some(format!("http://{server}:{port}"))
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_macos_system_proxy() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn fake_reader(
        vars: &HashMap<String, String>,
    ) -> impl Fn(&str) -> Result<String, std::env::VarError> + '_ {
        move |key| vars.get(key).cloned().ok_or(std::env::VarError::NotPresent)
    }

    #[test]
    fn proxy_from_env_returns_first_valid() {
        assert!(proxy_from_env(fake_reader(&HashMap::new())).is_none());

        let mut vars = HashMap::new();
        vars.insert("HTTPS_PROXY".into(), "http://127.0.0.1:9".into());
        assert_eq!(
            proxy_from_env(fake_reader(&vars)).unwrap(),
            "http://127.0.0.1:9"
        );
    }

    #[test]
    fn proxy_from_env_skips_invalid() {
        let mut vars = HashMap::new();
        vars.insert("HTTPS_PROXY".into(), "not-a-url".into());
        assert!(proxy_from_env(fake_reader(&vars)).is_none());

        // Valid URL in a lower-priority key — found after skipping invalid.
        vars.insert("http_proxy".into(), "http://10.0.0.1:8080".into());
        assert_eq!(
            proxy_from_env(fake_reader(&vars)).unwrap(),
            "http://10.0.0.1:8080"
        );
    }

    #[test]
    fn proxy_from_env_skips_empty() {
        let mut vars = HashMap::new();
        vars.insert("HTTPS_PROXY".into(), "  ".into());
        assert!(proxy_from_env(fake_reader(&vars)).is_none());
    }

    #[test]
    fn looks_like_proxy_url_cases() {
        assert!(looks_like_proxy_url("http://127.0.0.1:7890"));
        assert!(looks_like_proxy_url("https://proxy.example.com:443"));
        assert!(looks_like_proxy_url("socks5://127.0.0.1:1080"));
        assert!(!looks_like_proxy_url("not-a-url"));
        assert!(!looks_like_proxy_url("://missing-scheme"));
        assert!(!looks_like_proxy_url("http://"));
        assert!(!looks_like_proxy_url(""));
    }

    #[test]
    fn detect_macos_system_proxy_smoke() {
        // On macOS this should return Some or None depending on system config.
        // On other platforms it always returns None.
        let _ = detect_macos_system_proxy();
    }
}
