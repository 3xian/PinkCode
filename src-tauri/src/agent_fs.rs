use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;

const MAX_READ_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_REQUESTED_LINES: u64 = 100_000;

pub fn read_text_file(
    path: &str,
    line: Option<&Value>,
    limit: Option<&Value>,
) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    let start = line.and_then(Value::as_u64).unwrap_or(0);
    let limit = limit
        .and_then(Value::as_u64)
        .map(|count| count.min(MAX_REQUESTED_LINES));
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if start == 0 && limit.is_none() {
        let mut bytes = Vec::new();
        file.take((MAX_READ_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_READ_RESPONSE_BYTES {
            return Err(format!(
                "file exceeds ACP read limit of {} MiB; request a line range",
                MAX_READ_RESPONSE_BYTES / (1024 * 1024)
            ));
        }
        return String::from_utf8(bytes).map_err(|e| e.to_string());
    }

    let first_line = start.max(1);
    let last_line = limit.map(|count| first_line.saturating_add(count));
    let mut reader = BufReader::new(file);
    let mut current = 1u64;
    let mut line_buffer = Vec::new();
    let mut output = String::new();
    loop {
        line_buffer.clear();
        let read = (&mut reader)
            .take((MAX_READ_RESPONSE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line_buffer)
            .map_err(|e| e.to_string())?;
        if read == 0 || last_line.is_some_and(|last| current >= last) {
            break;
        }
        if line_buffer.len() > MAX_READ_RESPONSE_BYTES {
            return Err(format!(
                "line exceeds ACP read limit of {} MiB",
                MAX_READ_RESPONSE_BYTES / (1024 * 1024)
            ));
        }
        if current >= first_line {
            while line_buffer
                .last()
                .is_some_and(|byte| matches!(byte, b'\r' | b'\n'))
            {
                line_buffer.pop();
            }
            let line = std::str::from_utf8(&line_buffer).map_err(|e| e.to_string())?;
            let separator = usize::from(!output.is_empty());
            if output.len() + separator + line.len() > MAX_READ_RESPONSE_BYTES {
                return Err(format!(
                    "requested range exceeds ACP read limit of {} MiB",
                    MAX_READ_RESPONSE_BYTES / (1024 * 1024)
                ));
            }
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(line);
        }
        current = current.saturating_add(1);
    }
    Ok(output)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "pinkcode-agent-fs-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn line_range_is_streamed_with_one_based_start() {
        let path = fixture_path();
        fs::write(&path, "one\r\ntwo\nthree\n").expect("fixture");
        let line = Value::from(2);
        let limit = Value::from(2);
        let text =
            read_text_file(path.to_str().expect("path"), Some(&line), Some(&limit)).expect("read");
        let _ = fs::remove_file(path);
        assert_eq!(text, "two\nthree");
    }

    #[test]
    fn rejects_unbounded_oversized_response() {
        let path = fixture_path();
        fs::write(&path, vec![b'x'; MAX_READ_RESPONSE_BYTES + 1]).expect("fixture");
        let error = read_text_file(path.to_str().expect("path"), None, None).expect_err("limit");
        let _ = fs::remove_file(path);
        assert!(error.contains("exceeds ACP read limit"));
    }
}
