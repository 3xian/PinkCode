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

/// Returns the first valid proxy URL found in environment variables, or `None`.
/// Skips values that don't look like a proxy URL (must start with `http://`,
/// `https://`, or `socks` and contain a host).
fn proxy_from_env() -> Option<String> {
    for key in PROXY_KEYS {
        if let Ok(val) = std::env::var(key) {
            let val = val.trim().to_string();
            if val.is_empty() {
                continue;
            }
            if looks_like_proxy_url(&val) {
                return Some(val);
            }
            eprintln!("[pinkcode] ignoring invalid {key}={val:?}");
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
        .get_or_init(|| proxy_from_env().or_else(detect_macos_system_proxy))
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

    #[test]
    fn proxy_from_env_returns_first_valid() {
        let keys = PROXY_KEYS;
        let saved: Vec<_> = keys.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for k in keys {
            std::env::remove_var(k);
        }
        assert!(proxy_from_env().is_none());

        std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
        assert_eq!(proxy_from_env().unwrap(), "http://127.0.0.1:9");

        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }

    #[test]
    fn proxy_from_env_skips_invalid() {
        let keys = PROXY_KEYS;
        let saved: Vec<_> = keys.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for k in keys {
            std::env::remove_var(k);
        }

        // Invalid URL (no scheme) — should be skipped.
        std::env::set_var("HTTPS_PROXY", "not-a-url");
        assert!(proxy_from_env().is_none());

        // Valid URL in a lower-priority key — should be found after skipping invalid.
        std::env::set_var("http_proxy", "http://10.0.0.1:8080");
        assert_eq!(proxy_from_env().unwrap(), "http://10.0.0.1:8080");

        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
    }

    #[test]
    fn proxy_from_env_skips_empty() {
        let keys = PROXY_KEYS;
        let saved: Vec<_> = keys.iter().map(|k| (*k, std::env::var(k).ok())).collect();
        for k in keys {
            std::env::remove_var(k);
        }

        std::env::set_var("HTTPS_PROXY", "  ");
        assert!(proxy_from_env().is_none());

        for (k, v) in saved {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
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
