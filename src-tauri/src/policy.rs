//! Risk policy engine for permission auto-decisions + per-project bindings.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PolicyPreset {
    /// Deny writes & high-risk tools; ask on everything else.
    Research,
    /// Allow project edits pattern; deny dangerous shell / force-push; ask otherwise.
    Code,
    /// Ask on medium+ risk; auto-allow low-risk.
    Balanced,
    /// Auto-allow everything (yolo).
    Trusted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PolicyDecision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalKind {
    ToolPermission,
    FsWrite,
    FsRead,
    Other,
}

#[derive(Debug, Clone)]
pub struct EvalInput<'a> {
    pub kind: EvalKind,
    pub title: &'a str,
    pub detail: &'a str,
    pub path: Option<&'a str>,
    pub command: Option<&'a str>,
    pub raw_blob: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyConfig {
    pub preset: PolicyPreset,
    /// Extra bash substrings that force Deny (case-insensitive).
    pub deny_bash_substrings: Vec<String>,
    /// Extra path substrings that force Ask/Deny for writes.
    pub sensitive_path_substrings: Vec<String>,
    /// Auto-allow fs writes under these prefixes (e.g. /tmp).
    pub auto_allow_write_prefixes: Vec<String>,
    pub description: String,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self::from_preset(PolicyPreset::Balanced)
    }
}

impl PolicyConfig {
    pub fn from_preset(preset: PolicyPreset) -> Self {
        let deny_bash = default_dangerous_bash();
        let sensitive = default_sensitive_paths();
        let (auto_tmp, description) = match preset {
            PolicyPreset::Research => (
                vec![],
                "Read-only research: deny file writes and high-risk shell; ask for the rest."
                    .into(),
            ),
            PolicyPreset::Code => (
                default_tmp_write_prefixes(),
                "Code work: review project edits; block force-push / destructive shell.".into(),
            ),
            PolicyPreset::Balanced => (
                default_tmp_write_prefixes(),
                "Balanced: auto-allow low-risk; ask on edits & shell; deny known dangerous ops."
                    .into(),
            ),
            PolicyPreset::Trusted => (
                // Unused: Trusted short-circuits to Allow before prefix checks.
                vec!["/".into()],
                "Trusted: auto-approve all client-gated operations (yolo).".into(),
            ),
        };
        Self {
            preset,
            deny_bash_substrings: deny_bash,
            sensitive_path_substrings: sensitive,
            auto_allow_write_prefixes: auto_tmp,
            description,
        }
    }

    pub fn always_approve_flag(&self) -> bool {
        matches!(self.preset, PolicyPreset::Trusted)
    }
}

pub fn list_presets() -> Vec<PolicyConfig> {
    [
        PolicyPreset::Research,
        PolicyPreset::Code,
        PolicyPreset::Balanced,
        PolicyPreset::Trusted,
    ]
    .into_iter()
    .map(PolicyConfig::from_preset)
    .collect()
}

// ─── Per-project policy store ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PolicySource {
    /// From global default preset.
    Default,
    /// Exact cwd binding.
    Project,
    /// Matched a parent directory binding (e.g. monorepo root).
    Inherited,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBinding {
    pub cwd: String,
    pub preset: PolicyPreset,
    pub project_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPolicy {
    pub config: PolicyConfig,
    pub source: PolicySource,
    /// Normalized cwd used for lookup (if any).
    pub cwd: Option<String>,
    /// Binding path that won (exact or parent).
    pub bound_path: Option<String>,
    pub default_preset: PolicyPreset,
    pub is_project_bound: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStore {
    pub default_preset: PolicyPreset,
    /// Normalized absolute cwd → preset.
    pub projects: BTreeMap<String, PolicyPreset>,
}

impl Default for PolicyStore {
    fn default() -> Self {
        Self {
            default_preset: PolicyPreset::Balanced,
            projects: BTreeMap::new(),
        }
    }
}

impl PolicyStore {
    pub fn load() -> Self {
        let path = store_path();
        if !path.exists() {
            return Self::default();
        }
        match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = store_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, raw).map_err(|e| e.to_string())
    }

    pub fn resolve(&self, cwd: Option<&str>) -> ResolvedPolicy {
        let default_cfg = PolicyConfig::from_preset(self.default_preset);
        let Some(cwd) = cwd.filter(|c| !c.trim().is_empty()) else {
            return ResolvedPolicy {
                config: default_cfg,
                source: PolicySource::Default,
                cwd: None,
                bound_path: None,
                default_preset: self.default_preset,
                is_project_bound: false,
            };
        };

        let key = normalize_cwd(cwd);
        // Exact match
        if let Some(preset) = self.projects.get(&key) {
            return ResolvedPolicy {
                config: PolicyConfig::from_preset(*preset),
                source: PolicySource::Project,
                cwd: Some(key.clone()),
                bound_path: Some(key),
                default_preset: self.default_preset,
                is_project_bound: true,
            };
        }

        // Longest parent prefix match (monorepo / subfolder)
        let mut best: Option<(String, PolicyPreset)> = None;
        for (bound, preset) in &self.projects {
            if path_is_equal_or_within(&key, bound) {
                let better = best
                    .as_ref()
                    .map(|(b, _)| bound.len() > b.len())
                    .unwrap_or(true);
                if better {
                    best = Some((bound.clone(), *preset));
                }
            }
        }
        if let Some((bound_path, preset)) = best {
            return ResolvedPolicy {
                config: PolicyConfig::from_preset(preset),
                source: if bound_path == key {
                    PolicySource::Project
                } else {
                    PolicySource::Inherited
                },
                cwd: Some(key),
                bound_path: Some(bound_path),
                default_preset: self.default_preset,
                is_project_bound: true,
            };
        }

        ResolvedPolicy {
            config: default_cfg,
            source: PolicySource::Default,
            cwd: Some(key),
            bound_path: None,
            default_preset: self.default_preset,
            is_project_bound: false,
        }
    }

    pub fn set_default(&mut self, preset: PolicyPreset) -> Result<ResolvedPolicy, String> {
        self.default_preset = preset;
        self.save()?;
        Ok(self.resolve(None))
    }

    pub fn bind_project(&mut self, cwd: &str, preset: PolicyPreset) -> Result<ResolvedPolicy, String> {
        let key = normalize_cwd(cwd);
        if key.is_empty() {
            return Err("cwd required".into());
        }
        self.projects.insert(key.clone(), preset);
        self.save()?;
        Ok(self.resolve(Some(&key)))
    }

    pub fn unbind_project(&mut self, cwd: &str) -> Result<ResolvedPolicy, String> {
        let key = normalize_cwd(cwd);
        self.projects.remove(&key);
        // Also remove if they passed a child path matching exact only
        self.save()?;
        Ok(self.resolve(Some(&key)))
    }

    pub fn list_bindings(&self) -> Vec<ProjectBinding> {
        self.projects
            .iter()
            .map(|(cwd, preset)| ProjectBinding {
                project_name: project_name(cwd),
                cwd: cwd.clone(),
                preset: *preset,
            })
            .collect()
    }
}

pub fn store_path() -> PathBuf {
    if let Ok(home) = std::env::var("MARSBUILD_HOME") {
        return PathBuf::from(home).join("policies.json");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".marsbuild")
        .join("policies.json")
}

/// Normalize path separators to `/` and strip Windows verbatim (`\\?\`) prefixes.
pub fn normalize_separators(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    // Windows extended-length path: //?/C:/... or //?/UNC/server/share
    if let Some(rest) = s.strip_prefix("//?/") {
        s = if let Some(unc) = rest.strip_prefix("UNC/") {
            format!("//{unc}")
        } else {
            rest.to_string()
        };
    }
    s
}

/// True when `child` is the same as `parent` or a subdirectory of it.
/// Both sides should already be `normalize_cwd` keys (forward slashes).
fn path_is_equal_or_within(child: &str, parent: &str) -> bool {
    if child == parent {
        return true;
    }
    if parent.is_empty() {
        return false;
    }
    let prefix = format!("{parent}/");
    child.starts_with(&prefix)
}

/// Normalize cwd for stable map keys (cross-platform).
///
/// - Uses `/` separators
/// - Strips trailing slashes (except Unix root `/`)
/// - Preserves Windows drive letters / UNC prefixes
/// - Lowercases on Windows for case-insensitive matching
pub fn normalize_cwd(cwd: &str) -> String {
    let raw = cwd.trim();
    if raw.is_empty() {
        return String::new();
    }

    let path = PathBuf::from(raw);
    let mut s = if let Ok(canon) = path.canonicalize() {
        normalize_separators(&canon.to_string_lossy())
    } else {
        // Logical clean for non-existent paths (tests / not-yet-created dirs).
        use std::path::Component;
        let mut out = PathBuf::new();
        for c in path.components() {
            match c {
                Component::Prefix(p) => out.push(p.as_os_str()),
                Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                Component::Normal(part) => out.push(part),
            }
        }
        normalize_separators(&out.to_string_lossy())
    };

    // Trim trailing slashes, keep Unix root and bare drive roots stable.
    while s.len() > 1 && s.ends_with('/') {
        // Keep "C:/" style drive roots as "C:" after trim below.
        s.pop();
    }
    // "C:" form is fine as a key; empty after bad input stays empty.
    if s == "/" {
        return "/".into();
    }

    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    s
}

fn project_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(cwd)
        .to_string()
}

pub fn evaluate(policy: &PolicyConfig, input: &EvalInput<'_>) -> PolicyDecision {
    if matches!(policy.preset, PolicyPreset::Trusted) {
        return PolicyDecision::Allow;
    }

    match input.kind {
        EvalKind::FsRead => evaluate_fs_read(policy, input),
        EvalKind::FsWrite => evaluate_fs_write(policy, input),
        EvalKind::ToolPermission => evaluate_tool(policy, input),
        EvalKind::Other => PolicyDecision::Ask,
    }
}

fn evaluate_fs_read(policy: &PolicyConfig, input: &EvalInput<'_>) -> PolicyDecision {
    let path = input.path.unwrap_or(input.detail);
    if path_looks_sensitive(path) || is_sensitive_path(policy, path) {
        // Sensitive reads: Research/Code deny; Balanced asks; Trusted already returned.
        return match policy.preset {
            PolicyPreset::Research | PolicyPreset::Code => PolicyDecision::Deny,
            PolicyPreset::Balanced => PolicyDecision::Ask,
            PolicyPreset::Trusted => PolicyDecision::Allow,
        };
    }
    PolicyDecision::Allow
}

fn evaluate_fs_write(policy: &PolicyConfig, input: &EvalInput<'_>) -> PolicyDecision {
    let path = input.path.unwrap_or(input.detail);

    if is_sensitive_path(policy, path) {
        return match policy.preset {
            PolicyPreset::Research => PolicyDecision::Deny,
            _ => PolicyDecision::Ask,
        };
    }

    if policy
        .auto_allow_write_prefixes
        .iter()
        .any(|p| path_has_prefix(path, p))
        || path_looks_temp(path)
    {
        return match policy.preset {
            PolicyPreset::Research => PolicyDecision::Deny,
            _ => PolicyDecision::Allow,
        };
    }

    match policy.preset {
        PolicyPreset::Research => PolicyDecision::Deny,
        PolicyPreset::Code | PolicyPreset::Balanced => PolicyDecision::Ask,
        PolicyPreset::Trusted => PolicyDecision::Allow,
    }
}

fn evaluate_tool(policy: &PolicyConfig, input: &EvalInput<'_>) -> PolicyDecision {
    let blob = format!(
        "{} {} {} {}",
        input.title,
        input.detail,
        input.command.unwrap_or(""),
        input.raw_blob
    )
    .to_lowercase();

    if policy
        .deny_bash_substrings
        .iter()
        .any(|s| blob.contains(&s.to_lowercase()))
    {
        return PolicyDecision::Deny;
    }

    let is_shell = blob.contains("bash")
        || blob.contains("terminal")
        || blob.contains("run_terminal")
        || blob.contains("run_command")
        || blob.contains("powershell")
        || blob.contains("pwsh")
        || blob.contains("cmd.exe")
        || input.title.to_lowercase().contains("shell")
        // Avoid bare "execute" matching unrelated words; require shell-ish context.
        || (blob.contains("execute")
            && (blob.contains("command")
                || blob.contains("shell")
                || blob.contains("bash")
                || blob.contains("powershell")));

    // Avoid `"edit"` matching `"readonly"` / `"read-only"`.
    let is_edit = blob.contains("write")
        || blob.contains("search_replace")
        || blob.contains("apply_patch")
        || blob.contains("str_replace")
        || blob.contains("edit_file")
        || (blob.contains("edit")
            && !blob.contains("readonly")
            && !blob.contains("read-only")
            && !blob.contains("read_only"));

    match policy.preset {
        PolicyPreset::Research => {
            if is_shell || is_edit {
                PolicyDecision::Deny
            } else {
                PolicyDecision::Ask
            }
        }
        PolicyPreset::Code | PolicyPreset::Balanced => {
            if is_shell || is_edit {
                PolicyDecision::Ask
            } else {
                PolicyDecision::Allow
            }
        }
        PolicyPreset::Trusted => PolicyDecision::Allow,
    }
}

fn is_sensitive_path(policy: &PolicyConfig, path: &str) -> bool {
    let p = normalize_separators(path).to_lowercase();
    policy
        .sensitive_path_substrings
        .iter()
        .any(|s| p.contains(&normalize_separators(s).to_lowercase()))
        || path_looks_sensitive(path)
}

/// Prefix match with normalized separators; case-insensitive on Windows.
fn path_has_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    let p = normalize_separators(path);
    let pre = normalize_separators(prefix);
    #[cfg(windows)]
    {
        p.to_lowercase().starts_with(&pre.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        p.starts_with(&pre)
    }
}

/// OS temp dir and common `/tmp` / `…/Temp/` locations (policy + risk scoring).
pub fn path_looks_temp(path: &str) -> bool {
    let p = normalize_separators(path).to_lowercase();
    if p.contains("/tmp/")
        || p.starts_with("/tmp")
        || p.contains("/private/tmp/")
        || p.contains("/temp/")
        || p.contains("/tmpdir/")
    {
        return true;
    }
    let tmp = normalize_separators(&std::env::temp_dir().to_string_lossy()).to_lowercase();
    let tmp = tmp.trim_end_matches('/').to_string();
    if tmp.is_empty() {
        return false;
    }
    p == tmp || p.starts_with(&format!("{tmp}/"))
}

/// Shared sensitive-path heuristics used by policy evaluation and risk scoring.
/// Kept in one place so `risk_for_path` and policy stay consistent.
pub fn path_looks_sensitive(path: &str) -> bool {
    // Normalize `\` → `/` so Windows paths match the same segment rules.
    let p = normalize_separators(path).to_lowercase();
    // Path-segment / well-known location checks (avoid bare-word false positives
    // like `docs/credentials-guide.md` for the word "credentials").
    const SUBSTRINGS: &[&str] = &[
        "/.ssh/",
        "/.gnupg/",
        "/.aws/",
        "/etc/shadow",
        "/etc/sudoers",
        "id_rsa",
        "id_ed25519",
        "private_key",
        "auth.json",
        "/credentials/",
        "/credentials.",
        "/.credentials",
    ];
    if SUBSTRINGS.iter().any(|s| p.contains(s)) {
        return true;
    }
    if p.ends_with("/credentials") {
        return true;
    }
    // `.env` / `.env.*` as path segment or filename
    if p.contains("/.env") || p.ends_with(".env") || p.contains(".env.") {
        return true;
    }
    // "secret" as path segment (not e.g. "secretary")
    if p.contains("/secret/")
        || p.contains("/secret.")
        || p.ends_with("/secret")
        || p.contains(".secret")
    {
        return true;
    }
    Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .map(|f| {
            let f = f.to_lowercase();
            f == ".env"
                || f.starts_with(".env.")
                || f == "id_rsa"
                || f == "id_ed25519"
                || f.ends_with(".pem")
                || f == "shadow"
                || f == "sudoers"
                || f == "credentials"
                || f.starts_with("credentials.")
                || f == "private_key"
                || f.starts_with("private_key.")
                || f == "auth.json"
                || f == "secret"
                || f.starts_with("secret.")
        })
        .unwrap_or(false)
}

/// Temp write prefixes for Code / Balanced presets (Unix + Windows `%TEMP%`).
fn default_tmp_write_prefixes() -> Vec<String> {
    let mut v = vec!["/tmp/".into(), "/private/tmp/".into()];
    let tmp = normalize_separators(&std::env::temp_dir().to_string_lossy());
    let mut tmp = tmp.trim_end_matches('/').to_string();
    if !tmp.is_empty() {
        tmp.push('/');
        if !v.iter().any(|x| x == &tmp) {
            v.push(tmp.clone());
        }
        #[cfg(windows)]
        {
            let lower = tmp.to_lowercase();
            if lower != tmp {
                v.push(lower);
            }
        }
    }
    v
}

fn default_dangerous_bash() -> Vec<String> {
    vec![
        "rm -rf /".into(),
        "rm -rf /*".into(),
        "git push --force".into(),
        "git push -f".into(),
        "git reset --hard".into(),
        "git clean -fd".into(),
        "mkfs".into(),
        "dd if=".into(),
        ":(){ :|:& };:".into(),
        "curl | sh".into(),
        "curl|sh".into(),
        "wget | sh".into(),
        "wget|sh".into(),
        "chmod -r 777 /".into(),
        "sudo rm".into(),
        "drop database".into(),
        "shutdown".into(),
        "reboot".into(),
        // Windows / PowerShell destructive patterns
        "rmdir /s".into(),
        "rd /s".into(),
        "del /f /s".into(),
        "del /s /q".into(),
        "format c:".into(),
        "format d:".into(),
        "remove-item -recurse".into(),
        "remove-item -force".into(),
        "ri -recurse".into(),
    ]
}

fn default_sensitive_paths() -> Vec<String> {
    // Prefer path-segment markers over bare words (avoids matching
    // `credentials-guide.md` via a `/credentials` prefix).
    // Stored with `/` — matching normalizes `\` first.
    vec![
        "/.ssh/".into(),
        "/.gnupg/".into(),
        "/.aws/".into(),
        "/etc/shadow".into(),
        "/etc/sudoers".into(),
        "id_rsa".into(),
        "id_ed25519".into(),
        "/.env".into(),
        "/credentials/".into(),
        "/credentials.".into(),
        "/secret/".into(),
        "/secret.".into(),
        "auth.json".into(),
        "private_key".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn research_denies_write() {
        let p = PolicyConfig::from_preset(PolicyPreset::Research);
        let input = EvalInput {
            kind: EvalKind::FsWrite,
            title: "Write",
            detail: "/Users/mac/code/x.rs",
            path: Some("/Users/mac/code/x.rs"),
            command: None,
            raw_blob: "",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Deny);
    }

    #[test]
    fn balanced_allows_tmp_write() {
        let p = PolicyConfig::from_preset(PolicyPreset::Balanced);
        let input = EvalInput {
            kind: EvalKind::FsWrite,
            title: "Write",
            detail: "/tmp/a.txt",
            path: Some("/tmp/a.txt"),
            command: None,
            raw_blob: "",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Allow);
    }

    #[test]
    fn denies_force_push() {
        let p = PolicyConfig::from_preset(PolicyPreset::Code);
        let input = EvalInput {
            kind: EvalKind::ToolPermission,
            title: "run_terminal_command",
            detail: "git push --force origin main",
            path: None,
            command: Some("git push --force origin main"),
            raw_blob: "git push --force",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Deny);
    }

    #[test]
    fn project_binding_overrides_default() {
        let mut store = PolicyStore::default();
        store.default_preset = PolicyPreset::Balanced;
        let key = normalize_cwd("/Users/mac/code/secret");
        store.projects.insert(key.clone(), PolicyPreset::Research);
        let r = store.resolve(Some("/Users/mac/code/secret/"));
        assert_eq!(r.config.preset, PolicyPreset::Research);
        assert_eq!(r.source, PolicySource::Project);
        assert!(r.is_project_bound);
        assert_eq!(r.bound_path.as_deref(), Some(key.as_str()));
    }

    #[test]
    fn inherits_parent_binding() {
        let mut store = PolicyStore::default();
        let parent = normalize_cwd("/Users/mac/code/mono");
        store.projects.insert(parent.clone(), PolicyPreset::Code);
        let r = store.resolve(Some("/Users/mac/code/mono/packages/app"));
        assert_eq!(r.config.preset, PolicyPreset::Code);
        assert_eq!(r.source, PolicySource::Inherited);
        assert_eq!(r.bound_path.as_deref(), Some(parent.as_str()));
    }

    #[test]
    fn falls_back_to_default() {
        let store = PolicyStore {
            default_preset: PolicyPreset::Trusted,
            projects: BTreeMap::new(),
        };
        let r = store.resolve(Some("/tmp/other"));
        assert_eq!(r.config.preset, PolicyPreset::Trusted);
        assert_eq!(r.source, PolicySource::Default);
        assert!(!r.is_project_bound);
    }

    #[test]
    fn sensitive_read_denied_on_code() {
        let p = PolicyConfig::from_preset(PolicyPreset::Code);
        let input = EvalInput {
            kind: EvalKind::FsRead,
            title: "Read file",
            detail: "/Users/mac/.ssh/id_rsa",
            path: Some("/Users/mac/.ssh/id_rsa"),
            command: None,
            raw_blob: "",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Deny);
    }

    #[test]
    fn normal_read_allowed() {
        let p = PolicyConfig::from_preset(PolicyPreset::Balanced);
        let input = EvalInput {
            kind: EvalKind::FsRead,
            title: "Read file",
            detail: "/Users/mac/code/app/src/main.rs",
            path: Some("/Users/mac/code/app/src/main.rs"),
            command: None,
            raw_blob: "",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Allow);
    }

    #[test]
    fn credentials_filename_is_sensitive_not_docs() {
        assert!(path_looks_sensitive("/Users/mac/.aws/credentials"));
        assert!(path_looks_sensitive("/app/secrets/credentials.json"));
        assert!(!path_looks_sensitive(
            "/Users/mac/code/docs/credentials-guide.md"
        ));
        assert!(!path_looks_sensitive("/Users/mac/code/app/src/secretary.ts"));
        // Windows-style separators
        assert!(path_looks_sensitive(r"C:\Users\mac\.aws\credentials"));
        assert!(path_looks_sensitive(r"D:\app\secrets\credentials.json"));
    }

    #[test]
    fn readonly_tool_not_treated_as_edit() {
        let p = PolicyConfig::from_preset(PolicyPreset::Research);
        let input = EvalInput {
            kind: EvalKind::ToolPermission,
            title: "readonly search",
            detail: "grep pattern in sources",
            path: None,
            command: None,
            raw_blob: "readonly file lookup",
        };
        // Research denies shell/edit; pure readonly should Ask, not Deny.
        assert_eq!(evaluate(&p, &input), PolicyDecision::Ask);
    }

    #[test]
    fn normalize_cwd_strips_trailing_slashes() {
        let a = normalize_cwd("/Users/mac/code/app/");
        let b = normalize_cwd("/Users/mac/code/app");
        assert_eq!(a, b);
        assert!(!a.ends_with('/') || a == "/");
    }

    #[test]
    fn normalize_cwd_accepts_backslash_paths() {
        let a = normalize_cwd(r"C:\Users\mac\code\app");
        let b = normalize_cwd("C:/Users/mac/code/app");
        // Same logical key (Windows lowercases; other OSes keep case).
        assert_eq!(
            normalize_separators(&a).to_lowercase(),
            normalize_separators(&b).to_lowercase()
        );
        assert!(!a.contains('\\'));
        assert!(!b.contains('\\'));
    }

    #[test]
    fn path_looks_temp_detects_tmp_and_os_temp() {
        assert!(path_looks_temp("/tmp/x.txt"));
        assert!(path_looks_temp("/private/tmp/y.txt"));
        let os_tmp = std::env::temp_dir().join("marsbuild-test.txt");
        assert!(path_looks_temp(&os_tmp.to_string_lossy()));
    }

    #[test]
    fn balanced_allows_os_temp_write() {
        let p = PolicyConfig::from_preset(PolicyPreset::Balanced);
        let path = std::env::temp_dir().join("marsbuild-policy.txt");
        let path_s = path.to_string_lossy().to_string();
        let input = EvalInput {
            kind: EvalKind::FsWrite,
            title: "Write",
            detail: &path_s,
            path: Some(&path_s),
            command: None,
            raw_blob: "",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Allow);
    }

    #[test]
    fn denies_windows_destructive_shell() {
        let p = PolicyConfig::from_preset(PolicyPreset::Code);
        let input = EvalInput {
            kind: EvalKind::ToolPermission,
            title: "run_terminal_command",
            detail: "Remove-Item -Recurse -Force C:\\proj",
            path: None,
            command: Some("Remove-Item -Recurse -Force C:\\proj"),
            raw_blob: "Remove-Item -Recurse",
        };
        assert_eq!(evaluate(&p, &input), PolicyDecision::Deny);
    }
}
