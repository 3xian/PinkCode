//! Grok CLI session credentials (`~/.grok/auth.json`).
//!
//! MarsBuild is not a login UI — it reuses tokens written by `grok login` and
//! silently refreshes OIDC access tokens the same way the CLI does, so callers
//! (billing, …) do not fail after `key` expires until the user opens `grok`.

use crate::agent_runtime::{self, now_unix_secs, parse_rfc3339_z, unix_to_rfc3339_z};
use crate::sessions;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

/// Match Grok's default early-invalidation window (seconds before expiry).
const EARLY_INVALIDATION_SECS: u64 = 300;
const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_POLL: Duration = Duration::from_millis(40);
const DEFAULT_ACCESS_TTL_SECS: u64 = 6 * 3600;

#[derive(Debug, Clone)]
pub struct AuthEntry {
    /// Map key in `auth.json` (issuer::client_id or similar).
    pub provider_key: String,
    pub access_token: String,
    /// From `expires_at` when present (primary freshness signal).
    pub expires_at: Option<String>,
    /// Present only when silent OIDC refresh is possible.
    pub refresh: Option<OidcRefresh>,
}

#[derive(Debug, Clone)]
pub struct OidcRefresh {
    pub refresh_token: String,
    pub issuer: String,
    pub client_id: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn auth_json_path() -> PathBuf {
    sessions::grok_home().join("auth.json")
}

fn auth_lock_path() -> PathBuf {
    sessions::grok_home().join("auth.json.lock")
}

fn map_str<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
}

/// Fresh when `expires_at` is more than [`EARLY_INVALIDATION_SECS`] ahead.
/// Missing / unparsable `expires_at` → treat as usable until the API rejects it.
pub fn access_token_fresh(entry: &AuthEntry) -> bool {
    match entry
        .expires_at
        .as_deref()
        .and_then(parse_rfc3339_z)
    {
        Some(exp) => now_unix_secs() + EARLY_INVALIDATION_SECS < exp,
        None => true,
    }
}

pub fn read_auth_entry() -> Result<AuthEntry, String> {
    let path = auth_json_path();
    let raw = fs::read_to_string(&path).map_err(|e| {
        format!(
            "Cannot read {}: {e}. Run `grok login` to authenticate.",
            path.display()
        )
    })?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("Invalid auth.json: {e}"))?;
    let obj = v
        .as_object()
        .ok_or_else(|| "auth.json is not an object".to_string())?;

    for (provider_key, entry) in obj {
        let Some(map) = entry.as_object() else {
            continue;
        };
        let Some(key) = map_str(map, "key") else {
            continue;
        };

        let refresh = match (
            map_str(map, "refresh_token"),
            map_str(map, "oidc_issuer"),
            map_str(map, "oidc_client_id"),
        ) {
            (Some(rt), Some(issuer), Some(client_id)) => Some(OidcRefresh {
                refresh_token: rt.to_string(),
                issuer: issuer.to_string(),
                client_id: client_id.to_string(),
            }),
            _ => None,
        };

        return Ok(AuthEntry {
            provider_key: provider_key.clone(),
            access_token: key.to_string(),
            expires_at: map_str(map, "expires_at").map(str::to_string),
            refresh,
        });
    }
    Err("No session token in auth.json. Run `grok login`.".to_string())
}

/// Disk token if still fresh; otherwise OIDC refresh under lock.
pub fn ensure_access_token(agent: &ureq::Agent) -> Result<String, String> {
    let entry = read_auth_entry()?;
    if access_token_fresh(&entry) {
        return Ok(entry.access_token);
    }
    refresh_access_token(agent)
}

struct AuthLock {
    file: File,
}

impl Drop for AuthLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Exclusive lock on `auth.json.lock` (advisory, same file Grok uses).
fn acquire_auth_lock() -> Result<AuthLock, String> {
    let path = auth_lock_path();
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("Cannot open auth lock: {e}"))?;

    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => {
                let marker = format!("{}:{}\n", std::process::id(), now_unix_secs());
                let _ = file.set_len(0);
                let _ = file.write_all(marker.as_bytes());
                return Ok(AuthLock { file });
            }
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(
                        "auth.json.lock busy (another process may be refreshing). Retry shortly."
                            .into(),
                    );
                }
                thread::sleep(LOCK_POLL);
            }
            Err(TryLockError::Error(e)) => {
                return Err(format!("auth.json.lock failed: {e}"));
            }
        }
    }
}

fn token_endpoint(issuer: &str) -> String {
    format!("{}/oauth2/token", issuer.trim_end_matches('/'))
}

/// Force OIDC refresh, persist to `auth.json`, return the new access token.
///
/// Under lock: if a sibling already rotated credentials while we waited, adopt
/// that token and skip the network call. After the network call, adopt a
/// fresher sibling write if one appears (Grok may not share our lock).
pub fn refresh_access_token(agent: &ureq::Agent) -> Result<String, String> {
    let snapshot = read_auth_entry()?;
    if snapshot.refresh.is_none() {
        return Err(
            "Session token expired and cannot be refreshed. Run `grok login`.".into(),
        );
    }

    let _lock = acquire_auth_lock()?;

    let auth = read_auth_entry()?;
    // Sibling finished while we waited for the lock.
    if auth.access_token != snapshot.access_token && access_token_fresh(&auth) {
        return Ok(auth.access_token);
    }

    let refresh = auth
        .refresh
        .as_ref()
        .or(snapshot.refresh.as_ref())
        .ok_or_else(|| {
            "Session token expired and cannot be refreshed. Run `grok login`.".to_string()
        })?;

    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding::encode(&refresh.refresh_token),
        urlencoding::encode(&refresh.client_id)
    );

    let resp = match agent
        .post(&token_endpoint(&refresh.issuer))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .set("Accept", "application/json")
        .set("User-Agent", "marsbuild")
        .send_string(&body)
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r
                .into_json::<TokenResponse>()
                .ok()
                .and_then(|p| p.error_description.or(p.error))
                .unwrap_or_else(|| format!("HTTP {code}"));
            return Err(format!(
                "Token refresh failed: {detail}. Run `grok login` to re-authenticate."
            ));
        }
        Err(e) => return Err(format!("OIDC token refresh failed: {e}")),
    };

    let parsed: TokenResponse = resp
        .into_json()
        .map_err(|e| format!("OIDC token refresh parse failed: {e}"))?;

    if let Some(err) = parsed.error.as_ref() {
        let detail = parsed
            .error_description
            .clone()
            .unwrap_or_else(|| err.clone());
        return Err(format!(
            "Token refresh failed: {detail}. Run `grok login` to re-authenticate."
        ));
    }

    let access_token = parsed
        .access_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Token refresh response missing access_token".to_string())?;
    let new_refresh = parsed.refresh_token.filter(|s| !s.is_empty());

    let expires_at = unix_to_rfc3339_z(
        now_unix_secs()
            + parsed
                .expires_in
                .filter(|&s| s > 0)
                .unwrap_or(DEFAULT_ACCESS_TTL_SECS),
    );

    // Sibling wrote a different fresh token while we were on the wire.
    if let Ok(latest) = read_auth_entry() {
        if latest.provider_key == auth.provider_key
            && latest.access_token != auth.access_token
            && latest.access_token != access_token
            && access_token_fresh(&latest)
        {
            return Ok(latest.access_token);
        }
    }

    persist_tokens(
        &auth.provider_key,
        &access_token,
        new_refresh.as_deref(),
        &expires_at,
    )?;

    Ok(access_token)
}

fn persist_tokens(
    provider_key: &str,
    access_token: &str,
    new_refresh_token: Option<&str>,
    expires_at: &str,
) -> Result<(), String> {
    let path = auth_json_path();
    let raw = fs::read_to_string(&path).map_err(|e| format!("Cannot re-read auth.json: {e}"))?;
    let mut root: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid auth.json on write: {e}"))?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "auth.json is not an object".to_string())?;
    let entry = obj
        .get_mut(provider_key)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("auth.json missing provider entry {provider_key}"))?;

    // Only touch credential fields — leave profile / team metadata alone.
    entry.insert("key".into(), Value::String(access_token.to_string()));
    entry.insert("expires_at".into(), Value::String(expires_at.to_string()));
    if let Some(rt) = new_refresh_token {
        entry.insert("refresh_token".into(), Value::String(rt.to_string()));
    }

    // Compact JSON: pretty reordering fights concurrent grok writers.
    let mut out = serde_json::to_vec(&root).map_err(|e| format!("serialize auth.json: {e}"))?;
    out.push(b'\n');

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &out).map_err(|e| format!("Failed to write auth temp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to replace auth.json: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_with_exp(expires_at: Option<&str>) -> AuthEntry {
        AuthEntry {
            provider_key: "test".into(),
            access_token: "tok".into(),
            expires_at: expires_at.map(str::to_string),
            refresh: None,
        }
    }

    #[test]
    fn access_token_fresh_uses_expires_at_and_early_window() {
        let future = unix_to_rfc3339_z(now_unix_secs() + 3600);
        assert!(access_token_fresh(&entry_with_exp(Some(&future))));

        let soon = unix_to_rfc3339_z(now_unix_secs() + 30);
        assert!(!access_token_fresh(&entry_with_exp(Some(&soon))));

        // Missing expires_at → assume usable until API rejects.
        assert!(access_token_fresh(&entry_with_exp(None)));
    }

    #[test]
    fn agent_runtime_rfc3339_helpers_used() {
        // Smoke: auth depends on shared formatter (compile-time + value check).
        assert_eq!(
            agent_runtime::unix_to_rfc3339_z(0),
            "1970-01-01T00:00:00Z"
        );
    }
}
