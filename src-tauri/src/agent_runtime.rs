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

pub fn now_unix_secs() -> u64 {
    now_ms() / 1000
}

/// UTC timestamp with milliseconds: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn now_iso() -> String {
    let ms = now_ms();
    let (year, month, day, hour, minute, second) = unix_secs_to_utc(ms / 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        ms % 1000
    )
}

/// UTC second precision: `YYYY-MM-DDTHH:MM:SSZ` (auth.json `expires_at`, etc.).
pub fn unix_to_rfc3339_z(secs: u64) -> String {
    let (year, month, day, hour, minute, second) = unix_secs_to_utc(secs);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Parse `YYYY-MM-DDTHH:MM:SSZ` or `…SS.sssZ` (fraction ignored). Returns unix seconds.
pub fn parse_rfc3339_z(s: &str) -> Option<u64> {
    let s = s.trim();
    let s = s.strip_suffix('Z').or_else(|| s.strip_suffix('z'))?;
    let (date, time) = s.split_once('T').or_else(|| s.split_once('t'))?;
    let mut d = date.split('-');
    let y: i32 = d.next()?.parse().ok()?;
    let m: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let time = time.split(['.', '+']).next()?;
    let mut t = time.split(':');
    let hh: u32 = t.next()?.parse().ok()?;
    let mm: u32 = t.next()?.parse().ok()?;
    let ss: u32 = t.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let days = days_from_civil(y, m, day)?;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hh * 3600 + mm * 60 + ss))?;
    u64::try_from(secs).ok()
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

/// Howard Hinnant days_from_civil → days since Unix epoch (1970-01-01).
fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    let y = i64::from(y) - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = u64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + u64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_z_roundtrip_epoch() {
        assert_eq!(unix_to_rfc3339_z(0), "1970-01-01T00:00:00Z");
        assert_eq!(parse_rfc3339_z("1970-01-01T00:00:00Z"), Some(0));
        // 2026-07-22T20:42:11Z
        assert_eq!(unix_to_rfc3339_z(1_784_752_931), "2026-07-22T20:42:11Z");
        assert_eq!(parse_rfc3339_z("2026-07-22T20:42:11Z"), Some(1_784_752_931));
        assert_eq!(
            parse_rfc3339_z("2026-07-22T20:42:11.123Z"),
            Some(1_784_752_931)
        );
    }
}
