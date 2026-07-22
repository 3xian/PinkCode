//! Grok CLI session credentials (`~/.grok/auth.json`).
//!
//! MarsBuild is not a login UI — it reuses tokens written by `grok login` and
//! silently refreshes OIDC access tokens the same way the CLI does, so callers
//! (billing, …) do not fail after `key` expires until the user opens `grok`.

use crate::sessions;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Match Grok's default early-invalidation window (seconds before `exp`).
const EARLY_INVALIDATION_SECS: u64 = 300;
const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_POLL: Duration = Duration::from_millis(40);

#[derive(Debug, Clone)]
pub struct AuthEntry {
    /// Map key in `auth.json` (issuer::client_id or similar).
    pub provider_key: String,
    pub access_token: String,
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

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Best-effort: JWT `exp` from a compact JWS (no signature verify).
fn jwt_exp(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64url_decode(payload)?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("exp")?.as_u64()
}

fn access_token_fresh(token: &str) -> bool {
    match jwt_exp(token) {
        Some(exp) => now_unix() + EARLY_INVALIDATION_SECS < exp,
        // No exp claim — treat as usable until the API says otherwise.
        None => true,
    }
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut s = input.replace('-', "+").replace('_', "/");
    while s.len() % 4 != 0 {
        s.push('=');
    }
    // Minimal base64 decoder (std has no public one; keep dep-free).
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut i = 0;
    while i + 3 < bytes.len() {
        let (a, b, c, d) = (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
        i += 4;
        if a == b'=' {
            break;
        }
        let av = val(a)?;
        let bv = val(b)?;
        out.push((av << 2) | (bv >> 4));
        if c == b'=' {
            break;
        }
        let cv = val(c)?;
        out.push(((bv & 0xf) << 4) | (cv >> 2));
        if d == b'=' {
            break;
        }
        let dv = val(d)?;
        out.push(((cv & 0x3) << 6) | dv);
    }
    Some(out)
}

/// Format unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (write path only).
fn unix_to_rfc3339_z(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Howard Hinnant civil_from_days (write path for `expires_at` only).
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn map_str<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
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
            refresh,
        });
    }
    Err("No session token in auth.json. Run `grok login`.".to_string())
}

/// Access token from disk (no network).
pub fn read_access_token() -> Result<String, String> {
    Ok(read_auth_entry()?.access_token)
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
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("Cannot open auth lock: {e}"))?;
        match file.try_lock() {
            Ok(()) => {
                // Best-effort marker for humans / older tools (pid:unix).
                let marker = format!("{}:{}\n", std::process::id(), now_unix());
                let _ = file.set_len(0);
                let _ = (&file).write_all(marker.as_bytes());
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

/// Refresh OIDC access token, persist to `auth.json`, return the new access token.
///
/// Under lock: re-read so a concurrent `grok` refresh is adopted when possible;
/// never clobber a fresher sibling token after our network call returns.
pub fn refresh_access_token(agent: &ureq::Agent) -> Result<String, String> {
    let before = read_auth_entry()?;
    let Some(refresh) = before.refresh.clone() else {
        return Err(
            "Session token expired and cannot be refreshed. Run `grok login`.".into(),
        );
    };

    // Fast path: sibling already rotated credentials.
    if let Ok(latest) = read_auth_entry() {
        if latest.provider_key == before.provider_key
            && latest.access_token != before.access_token
            && access_token_fresh(&latest.access_token)
        {
            return Ok(latest.access_token);
        }
    }

    let _lock = acquire_auth_lock()?;

    // Re-read under lock — adopt if sibling finished while we waited.
    let auth = read_auth_entry()?;
    if auth.provider_key == before.provider_key
        && auth.access_token != before.access_token
        && access_token_fresh(&auth.access_token)
    {
        return Ok(auth.access_token);
    }

    let refresh = auth.refresh.as_ref().unwrap_or(&refresh);
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

    let expires_at = parsed
        .expires_in
        .map(|secs| unix_to_rfc3339_z(now_unix().saturating_add(secs)))
        .or_else(|| jwt_exp(&access_token).map(unix_to_rfc3339_z))
        .unwrap_or_else(|| unix_to_rfc3339_z(now_unix().saturating_add(6 * 3600)));

    // Adopt sibling if they wrote a fresher token while we were on the wire.
    if let Ok(latest) = read_auth_entry() {
        if latest.provider_key == auth.provider_key
            && latest.access_token != auth.access_token
            && latest.access_token != access_token
            && access_token_fresh(&latest.access_token)
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

    // Compact JSON preserves a stable single-line-ish write; pretty reordering
    // fights with concurrent grok writers. Use compact + trailing newline.
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

    #[test]
    fn base64url_jwt_payload_roundtrip_shape() {
        // {"exp":1784752931} base64url
        let payload = "eyJleHAiOjE3ODQ3NTI5MzF9";
        let bytes = base64url_decode(payload).expect("decode");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["exp"].as_u64(), Some(1_784_752_931));
    }

    #[test]
    fn jwt_exp_reads_claim() {
        // header.payload.sig — header/sig ignored
        let token = "eyJhbGciOiJub25lIn0.eyJleHAiOjE3ODQ3NTI5MzF9.sig";
        assert_eq!(jwt_exp(token), Some(1_784_752_931));
        assert_eq!(jwt_exp("not-a-jwt"), None);
    }

    #[test]
    fn unix_to_rfc3339_epoch() {
        assert_eq!(unix_to_rfc3339_z(0), "1970-01-01T00:00:00Z");
        // 2026-07-22T20:42:11Z
        assert_eq!(unix_to_rfc3339_z(1_784_752_931), "2026-07-22T20:42:11Z");
    }

    #[test]
    fn access_token_fresh_uses_early_window() {
        let future_exp = now_unix() + 3600;
        let payload = format!(r#"{{"exp":{future_exp}}}"#);
        let b64 = base64url_encode_for_test(payload.as_bytes());
        let token = format!("h.{b64}.s");
        assert!(access_token_fresh(&token));

        let soon = now_unix() + 30;
        let payload = format!(r#"{{"exp":{soon}}}"#);
        let b64 = base64url_encode_for_test(payload.as_bytes());
        let token = format!("h.{b64}.s");
        assert!(!access_token_fresh(&token));
    }

    fn base64url_encode_for_test(input: &[u8]) -> String {
        const T: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        let mut i = 0;
        while i < input.len() {
            let b0 = input[i];
            let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
            let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
            out.push(T[(b0 >> 2) as usize] as char);
            out.push(T[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
            if i + 1 < input.len() {
                out.push(T[(((b1 & 0xf) << 2) | (b2 >> 6)) as usize] as char);
            }
            if i + 2 < input.len() {
                out.push(T[(b2 & 0x3f) as usize] as char);
            }
            i += 3;
        }
        out.replace('+', "-").replace('/', "_")
    }
}
