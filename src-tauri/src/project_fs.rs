//! Project workspace helpers: directory listing + git working-tree status.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// One entry in a directory listing (non-recursive).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// One path from `git status --porcelain`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Two-letter porcelain XY status (e.g. ` M`, `M `, `??`, `A `).
    pub status: String,
    /// Path relative to the git work tree root (or as git printed it).
    pub path: String,
    /// Human label: modified / added / deleted / untracked / renamed / …
    pub kind: String,
}

/// List immediate children of `path` under `root` (or `root` itself when `path` is empty).
///
/// Both paths are absolute after resolution. Entries starting with `.` are included
/// (except `.` / `..`). Results are sorted: directories first, then files, A→Z.
pub fn list_dir(root: &str, path: Option<&str>) -> Result<Vec<DirEntry>, String> {
    let root_path = resolve_root(root)?;
    let target = match path {
        Some(p) if !p.trim().is_empty() => {
            let joined = join_under_root(&root_path, p)?;
            if !joined.is_dir() {
                return Err(format!("Not a directory: {}", joined.display()));
            }
            joined
        }
        _ => root_path.clone(),
    };

    let mut entries = Vec::new();
    let read = fs::read_dir(&target).map_err(|e| format!("read_dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        let full = entry.path();
        let is_dir = full.is_dir();
        entries.push(DirEntry {
            name,
            path: full.display().to_string(),
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

/// Uncommitted changes via `git status --porcelain=v1 -uall` in `cwd`.
///
/// Returns an empty list when the directory is not a git work tree.
pub fn git_status(cwd: &str) -> Result<Vec<GitChange>, String> {
    let root = resolve_root(cwd)?;
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("git status failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Not a git repo → empty list (not an error for the UI).
        if stderr.contains("not a git repository")
            || stderr.contains("not a git repo")
            || output.status.code() == Some(128)
        {
            return Ok(vec![]);
        }
        return Err(format!(
            "git status exited {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut changes = Vec::new();
    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }
        let status = line[..2].to_string();
        let rest = line[2..].trim_start();
        // Renames: `R  old -> new`
        let path = if let Some((from, to)) = rest.split_once(" -> ") {
            // Prefer the destination path for display.
            let _ = from;
            to.to_string()
        } else {
            rest.to_string()
        };
        if path.is_empty() {
            continue;
        }
        let kind = classify_status(&status);
        changes.push(GitChange { status, path, kind });
    }
    Ok(changes)
}

fn classify_status(xy: &str) -> String {
    let bytes = xy.as_bytes();
    if bytes.len() < 2 {
        return "changed".into();
    }
    let x = bytes[0] as char;
    let y = bytes[1] as char;
    if x == '?' && y == '?' {
        return "untracked".into();
    }
    if x == '!' && y == '!' {
        return "ignored".into();
    }
    // Prefer index letter, then worktree.
    let letter = if x != ' ' { x } else { y };
    match letter {
        'M' => "modified".into(),
        'A' => "added".into(),
        'D' => "deleted".into(),
        'R' => "renamed".into(),
        'C' => "copied".into(),
        'U' => "unmerged".into(),
        _ => "changed".into(),
    }
}

fn resolve_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root.trim());
    if p.as_os_str().is_empty() {
        return Err("empty project path".into());
    }
    let canon = fs::canonicalize(&p).unwrap_or(p);
    if !canon.is_dir() {
        return Err(format!("Not a directory: {}", canon.display()));
    }
    Ok(canon)
}

/// Join `rel` under `root`, rejecting path escape (`..` outside root).
fn join_under_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = if Path::new(rel).is_absolute() {
        PathBuf::from(rel)
    } else {
        root.join(rel)
    };
    let canon = fs::canonicalize(&candidate).unwrap_or(candidate);
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if !canon.starts_with(&root_canon) {
        return Err("path escapes project root".into());
    }
    Ok(canon)
}

/// Open a project file (or directory) with the OS default application.
///
/// `path` may be absolute or relative to `root`. Must stay under `root`.
/// Uses the opener crate from Rust (no frontend path ACL scope required).
pub fn open_path(root: &str, path: &str) -> Result<(), String> {
    let root_path = resolve_root(root)?;
    let target = join_under_root(&root_path, path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }
    let s = target.display().to_string();
    tauri_plugin_opener::open_path(&s, None::<&str>).map_err(|e| e.to_string())
}
