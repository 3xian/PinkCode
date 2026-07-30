//! Project workspace helpers: directory listing + git working-tree status.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const GIT_OUTPUT_MAX_BYTES: usize = 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_CACHE_TTL: Duration = Duration::from_secs(1);

/// One entry in a directory listing (non-recursive).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// Branch and upstream tracking info.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Staged change count (index vs HEAD).
    pub staged_count: u32,
    /// Unstaged change count (worktree vs index).
    pub unstaged_count: u32,
    /// Untracked file count.
    pub untracked_count: u32,
}

/// One file diff (unified format).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    /// Unified diff content (or empty if no changes).
    pub diff: String,
    /// "staged" | "unstaged"
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

struct GitCacheEntry {
    at: Instant,
    changes: Vec<GitChange>,
}

fn git_cache() -> &'static Mutex<HashMap<String, GitCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, GitCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_git_requests() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ActiveGitRequest {
    key: String,
    cancelled: Arc<AtomicBool>,
}

impl Drop for ActiveGitRequest {
    fn drop(&mut self) {
        let mut active = active_git_requests().lock();
        if active
            .get(&self.key)
            .is_some_and(|token| Arc::ptr_eq(token, &self.cancelled))
        {
            active.remove(&self.key);
        }
    }
}

/// Uncommitted changes via bounded `git status --porcelain=v1 -z` in `cwd`.
///
/// Returns an empty list when the directory is not a git work tree.
pub fn git_status(cwd: &str) -> Result<Vec<GitChange>, String> {
    let root = resolve_root(cwd)?;
    let cache_key = path_for_ui(&root);
    if let Some(entry) = git_cache().lock().get(&cache_key) {
        if entry.at.elapsed() < GIT_CACHE_TTL {
            return Ok(entry.changes.clone());
        }
    }

    // A newer request for the same worktree supersedes the older subprocess.
    // The frontend already ignores stale responses; this also stops their CPU
    // and filesystem work instead of merely discarding the eventual result.
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(previous) = active_git_requests()
        .lock()
        .insert(cache_key.clone(), Arc::clone(&cancelled))
    {
        previous.store(true, Ordering::Release);
    }
    let _active_request = ActiveGitRequest {
        key: cache_key.clone(),
        cancelled: Arc::clone(&cancelled),
    };

    let mut command = Command::new("git");
    command
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A GUI application has no parent console on Windows. Without this flag,
    // every background Git refresh briefly creates a visible console window.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("git status failed to start: {e}"))?;
    let stdout = child.stdout.take().ok_or("git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("git stderr unavailable")?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, GIT_OUTPUT_MAX_BYTES));
    let stderr_reader = thread::spawn(move || read_limited(stderr, 64 * 1024));

    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("git status superseded by a newer refresh".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "git status timed out after {}s",
                    GIT_TIMEOUT.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("git status wait failed: {error}"));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| "git stdout reader panicked".to_string())??;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| "git stderr reader panicked".to_string())??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        // Not a git repo → empty list (not an error for the UI).
        if stderr.contains("not a git repository")
            || stderr.contains("not a git repo")
            || status.code() == Some(128)
        {
            return Ok(vec![]);
        }
        return Err(format!(
            "git status exited {}: {}",
            status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }
    if stdout_truncated {
        return Err(format!(
            "git status output exceeded {} MiB; narrow the workspace or ignore generated files",
            GIT_OUTPUT_MAX_BYTES / (1024 * 1024)
        ));
    }

    let changes = parse_porcelain_z(&stdout);
    git_cache().lock().insert(
        cache_key,
        GitCacheEntry {
            at: Instant::now(),
            changes: changes.clone(),
        },
    );
    Ok(changes)
}

fn read_limited<R: Read>(mut reader: R, limit: usize) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    reader
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read git output: {error}"))?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    // Keep draining when the cap is reached so Git cannot block on a full pipe.
    if truncated {
        std::io::copy(&mut reader, &mut std::io::sink())
            .map_err(|error| format!("drain git output: {error}"))?;
    }
    Ok((bytes, truncated))
}

fn parse_porcelain_z(stdout: &[u8]) -> Vec<GitChange> {
    let fields: Vec<&[u8]> = stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.len() < 3 {
            continue;
        }
        let status = String::from_utf8_lossy(&record[..2]).into_owned();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let rename_or_copy = status
            .as_bytes()
            .iter()
            .any(|letter| matches!(*letter, b'R' | b'C'));
        if rename_or_copy && index < fields.len() {
            // In -z mode Git emits destination first, then the source as a
            // separate NUL field. The UI intentionally opens the destination.
            index += 1;
        }
        if path.is_empty() {
            continue;
        }
        let kind = classify_status(&status);
        changes.push(GitChange { status, path, kind });
    }
    changes
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
    // Normalize `/` → OS separator so mixed `images/1.jpg` under `D:\proj` resolves.
    let rel_os = if Path::new(&rel).is_absolute() {
        rel.clone()
    } else {
        rel.replace('/', std::path::MAIN_SEPARATOR_STR)
    };
    let candidate = if Path::new(&rel_os).is_absolute() {
        PathBuf::from(&rel_os)
    } else {
        root.join(&rel_os)
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

/// If `path` is under `root`, return the relative remainder (`images/1.jpg`).
fn relative_under(root: &Path, path: &Path) -> Option<String> {
    let norm = |p: &Path| {
        strip_extended_prefix(&p.to_string_lossy())
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    // Case-fold on Windows so `D:\A` matches `d:\a\…`.
    #[cfg(windows)]
    let (root_s, path_s) = {
        (
            norm(root).to_ascii_lowercase(),
            norm(path).to_ascii_lowercase(),
        )
    };
    #[cfg(not(windows))]
    let (root_s, path_s) = (norm(root), norm(path));

    if path_s == root_s {
        return None;
    }
    let prefix = format!("{root_s}/");
    path_s
        .strip_prefix(&prefix)
        .filter(|rest| !rest.is_empty())
        .map(|rest| rest.to_string())
}

/// Try Grok session assets for several candidate path forms.
fn try_session(session_id: &str, candidates: &[&str]) -> Option<PathBuf> {
    for c in candidates {
        if c.is_empty() {
            continue;
        }
        if let Ok(p) = crate::sessions::resolve_in_session(session_id, c) {
            return Some(p);
        }
    }
    None
}

/// Resolve a readable path for preview/open.
///
/// Order:
/// 1. Under `project_root` (absolute or relative) when the path exists.
/// 2. Else under the Grok session dir (`~/.grok/sessions/…/{session_id}/`) when
///    `session_id` is set — covers agent-generated assets like `images/1.jpg`.
///    Frontend often absolute-joins relative paths under the project first; we
///    re-derive the relative suffix so session lookup still works.
/// 3. Absolute paths that escape the project but stay under the session dir.
fn resolve_for_read(
    project_root: &str,
    path: &str,
    session_id: Option<&str>,
) -> Result<PathBuf, String> {
    let root_path = resolve_root(project_root)?;
    let raw = strip_extended_prefix(path.trim());
    if raw.is_empty() {
        return Err("empty path".into());
    }

    match join_under_root(&root_path, &raw) {
        Ok(p) if p.exists() => Ok(p),
        Ok(project_miss) => {
            if let Some(sid) = session_id {
                let mut candidates = vec![raw.as_str()];
                // `openPreview` may have joined `images/1.jpg` → `D:\proj\images\1.jpg`.
                let rel_owned = relative_under(&root_path, &project_miss);
                if let Some(ref rel) = rel_owned {
                    candidates.push(rel.as_str());
                }
                // Original relative form if client still sent one.
                if !Path::new(&raw).is_absolute() {
                    candidates.push(raw.as_str());
                }
                if let Some(sp) = try_session(sid, &candidates) {
                    return Ok(sp);
                }
            }
            Err(format!(
                "Path does not exist: {}",
                path_for_ui(&project_miss)
            ))
        }
        Err(project_err) => {
            if let Some(sid) = session_id {
                if let Some(sp) = try_session(sid, &[raw.as_str()]) {
                    return Ok(sp);
                }
            }
            Err(project_err)
        }
    }
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

/// Open a project (or session-asset) file with the OS default application.
///
/// `path` may be absolute or relative to `root`. Project paths must stay under
/// `root`; optional `session_id` also allows Grok session assets
/// (`images/…` under `~/.grok/sessions/…`).
pub fn open_path(root: &str, path: &str, session_id: Option<&str>) -> Result<(), String> {
    let target = resolve_for_read(root, path, session_id)?;
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
/// `path` may be absolute or relative to `root` (project), or a Grok session
/// asset when `session_id` is provided (e.g. generated `images/1.jpg`).
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

pub fn read_file(root: &str, path: &str, session_id: Option<&str>) -> Result<FilePreview, String> {
    let target = resolve_for_read(root, path, session_id)?;
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

/// Run a git command under `cwd`, return stdout bytes (truncated at limit).
fn run_git_cmd(
    cwd: &Path,
    args: &[&str],
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    let stdout = child.stdout.take().ok_or("git stdout unavailable")?;
    let stdout_reader = thread::spawn(move || read_limited(stdout, max_bytes));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} timed out", args.join(" ")));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} wait failed: {e}", args.join(" ")));
            }
        }
    };
    let (stdout_bytes, _) = stdout_reader
        .join()
        .map_err(|_| "git stdout reader panicked".to_string())??;
    if !status.success() {
        return Ok(stdout_bytes); // return partial output; caller handles empty
    }
    Ok(stdout_bytes)
}

/// Get branch name, upstream, ahead/behind counts, and staged/unstaged counts.
pub fn git_branch_info(cwd: &str) -> Result<GitBranchInfo, String> {
    let root = resolve_root(cwd)?;

    let branch = String::from_utf8_lossy(&run_git_cmd(
        &root,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        GIT_TIMEOUT,
        4096,
    )?)
    .trim()
    .to_string();
    let branch = if branch.is_empty() || branch == "HEAD" {
        None
    } else {
        Some(branch)
    };

    let upstream_raw = run_git_cmd(
        &root,
        &["rev-parse", "--abbrev-ref", "@{u}"],
        GIT_TIMEOUT,
        4096,
    );
    let upstream = upstream_raw
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .filter(|s| !s.is_empty());

    let (ahead, behind) = if upstream.is_some() {
        let counts = run_git_cmd(
            &root,
            &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
            GIT_TIMEOUT,
            256,
        )
        .unwrap_or_default();
        let s = String::from_utf8_lossy(&counts);
        let parts: Vec<&str> = s.trim().split('\t').collect();
        let ahead = parts.first().and_then(|p| p.parse().ok()).unwrap_or(0);
        let behind = parts.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
        (ahead, behind)
    } else {
        (0, 0)
    };

    // Count staged / unstaged / untracked from porcelain
    let changes = git_status(cwd).unwrap_or_default();
    let mut staged_count = 0u32;
    let mut unstaged_count = 0u32;
    let mut untracked_count = 0u32;
    for c in &changes {
        let bytes = c.status.as_bytes();
        if bytes.len() >= 2 {
            let x = bytes[0] as char;
            let y = bytes[1] as char;
            if x == '?' && y == '?' {
                untracked_count += 1;
            } else {
                if x != ' ' && x != '?' {
                    staged_count += 1;
                }
                if y != ' ' && y != '?' {
                    unstaged_count += 1;
                }
            }
        }
    }

    Ok(GitBranchInfo {
        branch,
        upstream,
        ahead,
        behind,
        staged_count,
        unstaged_count,
        untracked_count,
    })
}

/// Get unified diff for a specific file (staged or unstaged).
pub fn git_diff_file(cwd: &str, path: &str, staged: bool) -> Result<GitFileDiff, String> {
    let root = resolve_root(cwd)?;
    let args: &[&str] = if staged {
        &["diff", "--cached", "--", path]
    } else {
        &["diff", "--", path]
    };
    let diff_bytes = run_git_cmd(&root, args, GIT_TIMEOUT, GIT_OUTPUT_MAX_BYTES)?;
    let diff = String::from_utf8_lossy(&diff_bytes).into_owned();
    Ok(GitFileDiff {
        path: path.to_string(),
        diff,
        kind: if staged { "staged" } else { "unstaged" }.to_string(),
    })
}

/// Stage a file (git add).
pub fn git_stage(cwd: &str, path: &str) -> Result<(), String> {
    let root = resolve_root(cwd)?;
    run_git_cmd(&root, &["add", "--", path], GIT_TIMEOUT, 0)?;
    // Bust the git status cache so the frontend sees the update immediately.
    git_cache().lock().remove(&path_for_ui(&root));
    Ok(())
}

/// Unstage a file (git reset HEAD).
pub fn git_unstage(cwd: &str, path: &str) -> Result<(), String> {
    let root = resolve_root(cwd)?;
    run_git_cmd(&root, &["reset", "HEAD", "--", path], GIT_TIMEOUT, 0)?;
    git_cache().lock().remove(&path_for_ui(&root));
    Ok(())
}

/// Stage all changes (git add -A).
pub fn git_stage_all(cwd: &str) -> Result<(), String> {
    let root = resolve_root(cwd)?;
    run_git_cmd(&root, &["add", "-A"], GIT_TIMEOUT, 0)?;
    git_cache().lock().remove(&path_for_ui(&root));
    Ok(())
}

/// Unstage all changes (git reset HEAD).
pub fn git_unstage_all(cwd: &str) -> Result<(), String> {
    let root = resolve_root(cwd)?;
    run_git_cmd(&root, &["reset", "HEAD"], GIT_TIMEOUT, 0)?;
    git_cache().lock().remove(&path_for_ui(&root));
    Ok(())
}

/// Commit staged changes.
pub fn git_commit(cwd: &str, message: &str) -> Result<String, String> {
    let root = resolve_root(cwd)?;
    let output = run_git_cmd(&root, &["commit", "-m", message], GIT_TIMEOUT, 65536)?;
    git_cache().lock().remove(&path_for_ui(&root));
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

/// Apply a unified-diff patch to the index (`git apply --cached`).
///
/// Used for interactive hunk stage/unstage. `reverse = true` unstages
/// the selected hunks (`git apply --cached --reverse`).
pub fn git_apply_patch(cwd: &str, patch: &str, reverse: bool) -> Result<(), String> {
    let root = resolve_root(cwd)?;
    if patch.trim().is_empty() {
        return Err("empty patch".into());
    }

    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if reverse {
        args.push("--reverse");
    }
    // Read patch from stdin.
    args.push("-");

    let mut cmd = Command::new("git");
    cmd.args(&args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git apply failed to start: {e}"))?;
    {
        use std::io::Write;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "git apply stdin unavailable".to_string())?;
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("git apply write stdin: {e}"))?;
        // Drop closes stdin so apply proceeds.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("git apply wait failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("git apply failed");
        return Err(msg.to_string());
    }

    git_cache().lock().remove(&path_for_ui(&root));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_z_preserves_special_names_and_rename_destination() {
        let bytes =
            b" M path -> literal.txt\0?? \xe4\xb8\xad\xe6\x96\x87 name.txt\0R  new\nname.txt\0old.txt\0";
        let changes = parse_porcelain_z(bytes);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "path -> literal.txt");
        assert_eq!(changes[1].path, "中文 name.txt");
        assert_eq!(changes[2].path, "new\nname.txt");
        assert_eq!(changes[2].kind, "renamed");
    }

    #[test]
    fn limited_reader_reports_truncation() {
        let (bytes, truncated) = read_limited(&b"abcdef"[..], 3).expect("read");
        assert_eq!(bytes, b"abc");
        assert!(truncated);
    }
}
