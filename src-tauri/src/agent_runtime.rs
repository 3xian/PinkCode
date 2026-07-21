use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn find_grok_bin() -> Option<String> {
    if let Ok(path) = std::env::var("GROK_BIN") {
        if let Some(found) = first_existing_executable(PathBuf::from(path)) {
            return Some(found);
        }
    }
    if let Ok(home) = std::env::var("GROK_HOME") {
        if let Some(found) = first_existing_executable(PathBuf::from(home).join("bin/grok")) {
            return Some(found);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for directory in std::env::split_paths(&path) {
            if let Some(found) = first_existing_executable(directory.join("grok")) {
                return Some(found);
            }
        }
    }
    first_existing_executable(dirs::home_dir()?.join(".grok/bin/grok"))
}

fn first_existing_executable(base: PathBuf) -> Option<String> {
    if base.is_file() {
        return Some(base.display().to_string());
    }
    #[cfg(windows)]
    if base.extension().is_none() {
        for extension in ["exe", "cmd", "bat", "com"] {
            let candidate = base.with_extension(extension);
            if candidate.is_file() {
                return Some(candidate.display().to_string());
            }
        }
    }
    None
}

pub fn truncate_text(value: &str, max: usize) -> String {
    let value = value.trim();
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut output: String = value.chars().take(max.saturating_sub(1)).collect();
    output.push('…');
    output
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn now_iso() -> String {
    let ms = now_ms();
    let (year, month, day, hour, minute, second) = unix_secs_to_utc(ms / 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        ms % 1000
    )
}

fn unix_secs_to_utc(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let second = (secs % 60) as u32;
    let minutes = secs / 60;
    let minute = (minutes % 60) as u32;
    let hours = minutes / 60;
    let hour = (hours % 24) as u32;
    let days = (hours / 24) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = (if month <= 2 { year + 1 } else { year }) as i32;
    (year, month, day, hour, minute, second)
}
