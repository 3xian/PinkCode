use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub fn read_text_file(
    path: &str,
    line: Option<&Value>,
    limit: Option<&Value>,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let start = line.and_then(Value::as_u64).unwrap_or(0);
    let limit = limit.and_then(Value::as_u64);
    if start == 0 && limit.is_none() {
        return Ok(raw);
    }
    let lines: Vec<&str> = raw.lines().collect();
    let from = if start == 0 {
        0
    } else {
        (start as usize).saturating_sub(1).min(lines.len())
    };
    let end = limit
        .map(|count| from.saturating_add(count as usize).min(lines.len()))
        .unwrap_or(lines.len());
    Ok(lines[from..end].join("\n"))
}

pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if let Some(parent) = PathBuf::from(path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(path, content).map_err(|e| e.to_string())
}
