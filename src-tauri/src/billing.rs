//! Fetch weekly / period usage from Grok's billing API (cli-chat-proxy).
//!
//! Mirrors the Grok TUI `/usage` source:
//! `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
//! with the session token stored in `~/.grok/auth.json`.

use crate::sessions;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::time::Duration;

const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductUsage {
    pub product: String,
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekUsage {
    /// Overall credit usage for the current period (0–100+).
    pub used_percent: f64,
    /// Remaining overall budget (clamped 0–100).
    pub remaining_percent: f64,
    /// Grok Build product usage when present.
    pub build_used_percent: Option<f64>,
    pub build_remaining_percent: Option<f64>,
    /// e.g. USAGE_PERIOD_TYPE_WEEKLY
    pub period_type: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub product_usage: Vec<ProductUsage>,
    pub fetched_at: String,
    /// Soft error when auth missing / network fail (UI can still render).
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BillingResponse {
    config: Option<BillingConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BillingConfig {
    current_period: Option<CurrentPeriod>,
    credit_usage_percent: Option<f64>,
    product_usage: Option<Vec<RawProductUsage>>,
    billing_period_start: Option<String>,
    billing_period_end: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CurrentPeriod {
    #[serde(rename = "type")]
    period_type: Option<String>,
    start: Option<String>,
    end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProductUsage {
    product: Option<String>,
    usage_percent: Option<f64>,
}

fn remaining(used: f64) -> f64 {
    (100.0 - used).clamp(0.0, 100.0)
}

fn read_session_token() -> Result<String, String> {
    let path = sessions::grok_home().join("auth.json");
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
    for (_k, entry) in obj {
        if let Some(key) = entry.get("key").and_then(|x| x.as_str()) {
            if !key.is_empty() {
                return Ok(key.to_string());
            }
        }
    }
    Err("No session token in auth.json. Run `grok login`.".to_string())
}

/// Fetch current period usage (weekly for SuperGrok / Grok Build accounts).
pub fn fetch_week_usage() -> WeekUsage {
    let fetched_at = chrono_now();
    match fetch_week_usage_inner() {
        Ok(mut u) => {
            u.fetched_at = fetched_at;
            u
        }
        Err(e) => WeekUsage {
            used_percent: 0.0,
            remaining_percent: 100.0,
            build_used_percent: None,
            build_remaining_percent: None,
            period_type: "unknown".into(),
            period_start: None,
            period_end: None,
            product_usage: vec![],
            fetched_at,
            error: Some(e),
        },
    }
}

fn fetch_week_usage_inner() -> Result<WeekUsage, String> {
    let token = read_session_token()?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(12))
        .build();

    let resp = agent
        .get(BILLING_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .set("User-Agent", "marsbuild")
        .set("x-grok-client-mode", "billing")
        .call()
        .map_err(|e| format!("Billing request failed: {e}"))?;

    if !(200..300).contains(&resp.status()) {
        return Err(format!("Billing HTTP {}", resp.status()));
    }

    let body: BillingResponse = resp
        .into_json()
        .map_err(|e| format!("Failed to parse billing response: {e}"))?;

    let config = body
        .config
        .ok_or_else(|| "Billing response missing config".to_string())?;

    let used = config.credit_usage_percent.unwrap_or(0.0);
    let products: Vec<ProductUsage> = config
        .product_usage
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| {
            Some(ProductUsage {
                product: p.product?,
                usage_percent: p.usage_percent.unwrap_or(0.0),
            })
        })
        .collect();

    let build_used = products
        .iter()
        .find(|p| p.product.eq_ignore_ascii_case("GrokBuild"))
        .map(|p| p.usage_percent);

    let period = config.current_period;
    let period_type = period
        .as_ref()
        .and_then(|p| p.period_type.clone())
        .unwrap_or_else(|| "USAGE_PERIOD_TYPE_WEEKLY".into());
    let period_start = period
        .as_ref()
        .and_then(|p| p.start.clone())
        .or(config.billing_period_start);
    let period_end = period
        .as_ref()
        .and_then(|p| p.end.clone())
        .or(config.billing_period_end);

    Ok(WeekUsage {
        used_percent: used,
        remaining_percent: remaining(used),
        build_used_percent: build_used,
        build_remaining_percent: build_used.map(remaining),
        period_type,
        period_start,
        period_end,
        product_usage: products,
        fetched_at: String::new(),
        error: None,
    })
}

fn chrono_now() -> String {
    // RFC3339-ish without extra deps: system time as unix millis string is fine,
    // but ISO is nicer for the UI. Use a tiny manual UTC formatter.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Keep simple ISO-ish timestamp via gmtime-ish math is heavy; use unix for now
    // and let the frontend Date.parse if needed. Prefer actual ISO via `time`? Skip deps.
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_clamps() {
        assert_eq!(remaining(0.0), 100.0);
        assert_eq!(remaining(85.0), 15.0);
        assert_eq!(remaining(120.0), 0.0);
        assert_eq!(remaining(-5.0), 100.0);
    }
}
