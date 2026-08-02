//! Session model catalog merge + models/update method matching.

use crate::acp::protocol::SessionModelsInfo;
use crate::agent_types::{AvailableModelInfo, ManagedAgentInfo, ReasoningEffortOption};
use serde_json::Value;

/// Grok may emit `x.ai/models/update` or a leading-underscore ext form.
pub(crate) fn is_models_update_method(method: &str) -> bool {
    matches!(method.trim_start_matches('_'), "x.ai/models/update")
}

/// Merge ACP model state into a managed agent snapshot.
///
/// Empty `availableModels` does **not** clear a non-empty catalog (non-blocking
/// startup may emit an empty list first, then a full `x.ai/models/update`).
pub(crate) fn apply_models_info(info: &mut ManagedAgentInfo, models: &SessionModelsInfo) {
    if let Some(id) = models
        .current_model_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        info.model_id = Some(id.to_string());
    }
    let next: Vec<AvailableModelInfo> = models
        .available_models
        .iter()
        .filter_map(|m| {
            let id = m.model_id.trim();
            if id.is_empty() {
                return None;
            }
            let name = m
                .name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let meta = m.meta.as_ref().and_then(Value::as_object);
            let supports_reasoning_effort = meta
                .and_then(|meta| meta.get("supportsReasoningEffort"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let reasoning_effort = meta
                .and_then(|meta| meta.get("reasoningEffort"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let reasoning_efforts = meta
                .and_then(|meta| meta.get("reasoningEfforts"))
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let value = option
                                .as_str()
                                .or_else(|| option.get("value").and_then(Value::as_str))?
                                .trim();
                            if value.is_empty() {
                                return None;
                            }
                            let label = option
                                .get("label")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|label| !label.is_empty())
                                .unwrap_or(value)
                                .to_string();
                            Some(ReasoningEffortOption {
                                value: value.to_string(),
                                label,
                                description: option
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|description| !description.is_empty())
                                    .map(str::to_string),
                                default: option
                                    .get("default")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AvailableModelInfo {
                model_id: id.to_string(),
                name,
                supports_reasoning_effort,
                reasoning_effort,
                reasoning_efforts,
            })
        })
        .collect();
    if !next.is_empty() {
        info.available_models = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::AcpModelInfo;
    use crate::agent_types::{ManagedStatus, PermissionMode};

    #[test]
    fn models_update_method_matches_prefixed_and_plain() {
        assert!(is_models_update_method("x.ai/models/update"));
        assert!(is_models_update_method("_x.ai/models/update"));
        assert!(!is_models_update_method("session/update"));
        assert!(!is_models_update_method("x.ai/queue/changed"));
        assert!(!is_models_update_method("foo/x.ai/models/update"));
    }

    #[test]
    fn apply_models_info_keeps_catalog_when_update_is_empty() {
        let mut info = ManagedAgentInfo {
            handle_id: "h1".into(),
            session_id: Some("s1".into()),
            cwd: "/tmp".into(),
            pid: None,
            status: ManagedStatus::Ready,
            permission_mode: PermissionMode::Default,
            always_approve: false,
            model_id: Some("grok-4".into()),
            available_models: vec![AvailableModelInfo {
                model_id: "grok-4".into(),
                name: Some("Grok 4".into()),
                supports_reasoning_effort: true,
                reasoning_effort: Some("high".into()),
                reasoning_efforts: vec![],
            }],
            last_error: None,
            title: None,
            created_at: "t".into(),
            pending_permission_count: 0,
        };
        apply_models_info(
            &mut info,
            &SessionModelsInfo {
                current_model_id: Some("grok-4.5".into()),
                available_models: vec![],
            },
        );
        assert_eq!(info.model_id.as_deref(), Some("grok-4.5"));
        assert_eq!(info.available_models.len(), 1);

        apply_models_info(
            &mut info,
            &SessionModelsInfo {
                current_model_id: Some("grok-4.5".into()),
                available_models: vec![AcpModelInfo {
                    model_id: "grok-4.5".into(),
                    name: Some("Grok 4.5".into()),
                    description: None,
                    meta: Some(serde_json::json!({
                        "supportsReasoningEffort": true,
                        "reasoningEffort": "medium",
                        "reasoningEfforts": [
                            {
                                "value": "medium",
                                "label": "Medium",
                                "description": "Balanced",
                                "default": true
                            },
                            { "value": "low", "label": "Low" },
                            "high"
                        ]
                    })),
                }],
            },
        );
        assert_eq!(info.available_models.len(), 1);
        assert_eq!(info.available_models[0].model_id, "grok-4.5");
        assert_eq!(
            info.available_models[0].reasoning_effort.as_deref(),
            Some("medium")
        );
        assert!(info.available_models[0].supports_reasoning_effort);
        assert_eq!(info.available_models[0].reasoning_efforts.len(), 3);
    }
}
