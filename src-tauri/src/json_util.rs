//! Small JSON helpers shared by reverse-RPC bridges.

use serde_json::Value;

/// First non-empty string field among `keys` (camelCase / snake_case aliases).
pub fn str_field(params: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = params.get(*key).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}
