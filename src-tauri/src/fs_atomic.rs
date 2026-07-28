//! Atomic file replace helpers (write temp → rename/replace).
//!
//! Used by prefs and layered config so partial writes never leave a corrupt
//! on-disk document.

use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Serialize `value` as pretty JSON and atomically replace `path`.
pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(value).map_err(|error| format!("serialize: {error}"))?;
    write_bytes_atomic(path, raw.as_bytes())
}

/// Write `bytes` to `path` via a unique temp file in the same directory.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create dir: {error}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!(
        "tmp.{}.{}.{}",
        std::process::id(),
        nonce,
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat")
    ));
    fs::write(&tmp, bytes).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    if let Err(error) = replace_file(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn MoveFileExW(existing: *const u16, new_name: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_path(name: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "pinkcode_atomic_{name}_{}_{n}.json",
            std::process::id()
        ))
    }

    #[test]
    fn json_roundtrip_atomic() {
        let path = temp_path("roundtrip");
        let _ = fs::remove_file(&path);
        write_json_atomic(&path, &json!({"a": 1})).expect("write");
        let raw = fs::read_to_string(&path).expect("read");
        assert!(raw.contains("\"a\""));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn replace_existing() {
        let path = temp_path("replace");
        fs::write(&path, b"old").expect("seed");
        write_json_atomic(&path, &json!({"v": 2})).expect("replace");
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["v"], 2);
        let _ = fs::remove_file(&path);
    }
}
