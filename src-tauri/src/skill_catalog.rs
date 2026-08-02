//! Offline slash-skill discovery via Grok's own configuration inspector.
//!
//! PinkCode deliberately does not attach an ACP agent until the first prompt.
//! Autocomplete still needs the same project/user/plugin skill catalog, so use
//! `grok inspect --json` instead of maintaining a second discovery algorithm.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// Slash skill exposed to the frontend autocomplete catalog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommandInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectOutput {
    #[serde(default)]
    skills: Vec<InspectSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectSkill {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_true")]
    user_invocable: bool,
    #[serde(default)]
    disabled: bool,
}

fn default_true() -> bool {
    true
}

pub fn list_slash_skills(grok_bin: &str, cwd: &str) -> Result<Vec<AvailableCommandInfo>, String> {
    let cwd = Path::new(cwd);
    if !cwd.is_dir() {
        return Err(format!("Invalid working directory: {}", cwd.display()));
    }

    let mut command = Command::new(grok_bin);
    command.args(["inspect", "--json"]).current_dir(cwd);

    // Session selection refreshes this catalog. As a GUI process has no parent
    // console on Windows, spawning `grok` without this flag briefly flashes one.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|error| format!("failed to run grok inspect: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("grok inspect exited with {}", output.status)
        } else {
            format!("grok inspect failed: {stderr}")
        });
    }

    parse_inspect_output(&output.stdout)
}

fn parse_inspect_output(bytes: &[u8]) -> Result<Vec<AvailableCommandInfo>, String> {
    let inspected: InspectOutput = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid grok inspect JSON: {error}"))?;
    Ok(inspected
        .skills
        .into_iter()
        .filter(|skill| skill.user_invocable && !skill.disabled)
        .filter_map(|skill| {
            let name = skill.name.trim().trim_start_matches('/');
            if name.is_empty() {
                return None;
            }
            Some(AvailableCommandInfo {
                name: name.to_string(),
                description: skill.description.trim().to_string(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_user_invocable_skills() {
        let commands = parse_inspect_output(
            br#"{
                "skills": [
                    {
                        "name": "/code-review",
                        "description": " Strict review ",
                        "userInvocable": true
                    },
                    {
                        "name": "internal",
                        "description": "Hidden",
                        "userInvocable": false
                    },
                    {
                        "name": "disabled",
                        "description": "Disabled",
                        "userInvocable": true,
                        "disabled": true
                    }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "code-review");
        assert_eq!(commands[0].description, "Strict review");
    }
}
