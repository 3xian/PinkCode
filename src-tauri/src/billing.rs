//! Fetch weekly / period usage from Grok's billing API (cli-chat-proxy).
//!
//! Mirrors the Grok TUI `/usage` source:
//! `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`
//!
//! Auth (read / OIDC refresh / persist) lives in [`crate::auth`].

use crate::agent_runtime::now_unix_secs;
use crate::auth;
use serde::{Deserialize, Serialize};
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

enum BillingCallError {
    /// HTTP status from the billing API (0 = transport / other).
    Http(u16, String),
}

fn remaining(used: f64) -> f64 {
    (100.0 - used).clamp(0.0, 100.0)
}

fn is_grok_build_product(product: &str) -> bool {
    let n = product.to_ascii_lowercase().replace('-', "_");
    n == "grokbuild"
        || n == "grok_build"
        || n == "product_grok_build"
        || n.contains("grok_build")
        || n.contains("grokbuild")
}

/// Fetch current period usage (weekly for SuperGrok / Grok Build accounts).
pub fn fetch_week_usage() -> WeekUsage {
    let fetched_at = now_unix_secs().to_string();
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

fn http_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(5));
    if let Some(url) = crate::proxy::detect_proxy() {
        match ureq::Proxy::new(&url) {
            Ok(p) => {
                builder = builder.proxy(p);
            }
            Err(e) => {
                tracing::warn!(url = %url, error = %e, "ignore invalid proxy");
            }
        }
    }
    builder.build()
}

fn call_billing(agent: &ureq::Agent, token: &str) -> Result<ureq::Response, BillingCallError> {
    match agent
        .get(BILLING_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .set("User-Agent", "pinkcode")
        .set("x-grok-client-mode", "billing")
        .call()
    {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(code, _resp)) => {
            Err(BillingCallError::Http(code, format!("Billing HTTP {code}")))
        }
        Err(e) => Err(BillingCallError::Http(
            0,
            format!("Billing request failed: {e}"),
        )),
    }
}

fn auth_failed_msg(code: u16) -> String {
    format!("Billing HTTP {code} (auth failed). Run `grok login` to re-authenticate.")
}

fn fetch_week_usage_inner() -> Result<WeekUsage, String> {
    let agent = http_agent();
    // Prefer a non-expired disk token; refresh proactively when expires_at says so.
    let mut token = auth::ensure_access_token(&agent)?;

    match call_billing(&agent, &token) {
        Ok(resp) => return parse_billing(resp),
        Err(BillingCallError::Http(401, _)) => {
            // Server rejected — force refresh once even if expires_at still looks fine.
            token = auth::refresh_access_token(&agent)?;
        }
        Err(BillingCallError::Http(code, _)) if code == 403 => {
            return Err(auth_failed_msg(code));
        }
        Err(BillingCallError::Http(_, msg)) => return Err(msg),
    }

    match call_billing(&agent, &token) {
        Ok(resp) => parse_billing(resp),
        Err(BillingCallError::Http(code, _)) if code == 401 || code == 403 => {
            Err(auth_failed_msg(code))
        }
        Err(BillingCallError::Http(_, msg)) => Err(msg),
    }
}

fn parse_billing(resp: ureq::Response) -> Result<WeekUsage, String> {
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

    // API product id is often `PRODUCT_GROK_BUILD`; older shapes use `GrokBuild`.
    let build_used = products
        .iter()
        .find(|p| is_grok_build_product(&p.product))
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

    #[test]
    fn grok_build_product_ids() {
        assert!(is_grok_build_product("GrokBuild"));
        assert!(is_grok_build_product("PRODUCT_GROK_BUILD"));
        assert!(is_grok_build_product("product_grok_build"));
        assert!(!is_grok_build_product("Grok"));
        assert!(!is_grok_build_product("Chat"));
    }

    /// Optional live check: `cargo test live_week_usage -- --ignored`
    #[test]
    #[ignore]
    fn live_week_usage_smoke() {
        let u = fetch_week_usage();
        assert!(
            u.error.is_none(),
            "expected billing success, got error: {:?}",
            u.error
        );
        assert!(u.remaining_percent <= 100.0);
        assert!(!u.period_type.is_empty());
    }
}
