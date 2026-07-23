//! Project workspace helpers: directory listing + git working-tree status.

use serde::Serialize;
use std::fs;
use std::io::Read;
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
                return Err(format!("Not a directory: {}", path_for_ui(&joined)));
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
            path: path_for_ui(&full),
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
    let mut command = Command::new("git");
    command
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&root);

    // A GUI application has no parent console on Windows. Without this flag,
    // every background Git refresh briefly creates a visible console window.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
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
        return Err(format!("Not a directory: {}", path_for_ui(&canon)));
    }
    Ok(canon)
}

/// Join `rel` under `root`, rejecting path escape (`..` outside root).
fn join_under_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Strip Windows extended-length prefix so absolute client paths still join/compare cleanly.
    let rel = strip_extended_prefix(rel.trim());
    let candidate = if Path::new(&rel).is_absolute() {
        PathBuf::from(&rel)
    } else {
        root.join(&rel)
    };
    let canon = fs::canonicalize(&candidate).unwrap_or(candidate);
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // Compare after stripping `\\?\` so mixed prefix styles still match.
    let canon_cmp = PathBuf::from(strip_extended_prefix(&canon.to_string_lossy()));
    let root_cmp = PathBuf::from(strip_extended_prefix(&root_canon.to_string_lossy()));
    if !canon_cmp.starts_with(&root_cmp) && !canon.starts_with(&root_canon) {
        return Err("path escapes project root".into());
    }
    Ok(canon)
}

/// Path string suitable for the frontend (no Windows `\\?\` extended prefix).
fn path_for_ui(path: &Path) -> String {
    strip_extended_prefix(&path.to_string_lossy())
}

fn strip_extended_prefix(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else if let Some(rest) = s.strip_prefix("//?/") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

/// Open a project file (or directory) with the OS default application.
///
/// `path` may be absolute or relative to `root`. Must stay under `root`.
/// Uses the opener crate from Rust (no frontend path ACL scope required).
pub fn open_path(root: &str, path: &str) -> Result<(), String> {
    let root_path = resolve_root(root)?;
    let target = join_under_root(&root_path, path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path_for_ui(&target)));
    }
    let s = path_for_ui(&target);
    tauri_plugin_opener::open_path(&s, None::<&str>).map_err(|e| e.to_string())
}

/// Soft cap for in-app text preview (bytes). Larger files are truncated.
const PREVIEW_MAX_BYTES: u64 = 512 * 1024;
/// Soft cap for image preview (bytes). Larger images open externally only.
const PREVIEW_MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

/// Text file contents for the workspace preview pane.
///
/// `path` may be absolute or relative to `root`. Must stay under `root`.
/// - `kind: "text"` — UTF-8 text in `content`
/// - `kind: "image"` — base64 payload in `content` + `mime_type`
/// - `kind: "binary"` — unsupported binary (empty `content`)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    /// `"text" | "image" | "binary"`
    pub kind: String,
    pub mime_type: Option<String>,
}

pub fn read_file(root: &str, path: &str) -> Result<FilePreview, String> {
    let root_path = resolve_root(root)?;
    let target = join_under_root(&root_path, path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path_for_ui(&target)));
    }
    if target.is_dir() {
        return Err(format!("Is a directory: {}", path_for_ui(&target)));
    }
    let meta = fs::metadata(&target).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    let display_path = path_for_ui(&target);

    if let Some(mime) = image_mime_for_path(&target) {
        return read_image_preview(&target, display_path, size, mime);
    }

    let read_cap = (size.min(PREVIEW_MAX_BYTES)) as usize;
    let mut buf = vec![0u8; read_cap];
    {
        let mut f = fs::File::open(&target).map_err(|e| format!("open: {e}"))?;
        let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
        buf.truncate(n);
    }
    if buf.contains(&0) {
        return Ok(binary_preview(display_path, size));
    }
    match String::from_utf8(buf) {
        Ok(content) => Ok(FilePreview {
            path: display_path,
            content,
            size,
            truncated: size > PREVIEW_MAX_BYTES,
            kind: "text".into(),
            mime_type: None,
        }),
        Err(_) => Ok(binary_preview(display_path, size)),
    }
}

fn binary_preview(path: String, size: u64) -> FilePreview {
    FilePreview {
        path,
        content: String::new(),
        size,
        truncated: false,
        kind: "binary".into(),
        mime_type: None,
    }
}

fn read_image_preview(
    target: &Path,
    display_path: String,
    size: u64,
    mime: &'static str,
) -> Result<FilePreview, String> {
    if size > PREVIEW_MAX_IMAGE_BYTES {
        return Ok(FilePreview {
            path: display_path,
            content: String::new(),
            size,
            truncated: true,
            kind: "image".into(),
            mime_type: Some(mime.into()),
        });
    }
    let bytes = fs::read(target).map_err(|e| format!("read: {e}"))?;
    use base64::Engine as _;
    let content = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(FilePreview {
        path: display_path,
        content,
        size,
        truncated: false,
        kind: "image".into(),
        mime_type: Some(mime.into()),
    })
}

/// MIME for common raster/vector image extensions (case-insensitive).
fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jfif" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "tif" | "tiff" => Some("image/tiff"),
        _ => None,
    }
}
