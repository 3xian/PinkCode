//! Throttled publication of shell snapshots to the webview.

use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

const EMIT_MIN_INTERVAL: Duration = Duration::from_millis(120);
const EMIT_MIN_BYTES: usize = 4_096;
const OUTPUT_MAX_BYTES: usize = 200_000;
const SCHEDULER_TICK: Duration = Duration::from_millis(20);

pub type ShellEmit = Arc<dyn Fn(Value) + Send + Sync + 'static>;

struct EmitState {
    last_at: Instant,
    last_status: String,
    last_out_len: usize,
    last_output: String,
    last_exit: Option<i64>,
    pending_payload: Option<Value>,
    pending_emit: Option<ShellEmit>,
    due_at: Option<Instant>,
}

#[derive(Clone)]
pub struct ShellStream {
    states: Arc<Mutex<HashMap<String, EmitState>>>,
}

impl Default for ShellStream {
    fn default() -> Self {
        let states = Arc::new(Mutex::new(HashMap::new()));
        start_scheduler(Arc::downgrade(&states));
        Self { states }
    }
}

impl ShellStream {
    pub fn publish(&self, mut payload: Value, emit: ShellEmit) {
        cap_output(&mut payload);
        let handle_id = payload
            .get("handleId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let tool_call_id = payload
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = format!("{handle_id}:{tool_call_id}");
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let out_len = payload
            .get("output")
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0);
        let full_output = payload
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let exit = payload.get("exitCode").and_then(Value::as_i64);
        let terminal =
            matches!(status.as_str(), "completed" | "failed" | "cancelled") || exit.is_some();

        let mut states = self.states.lock();
        if let Some(previous) = states.get_mut(&key) {
            let status_changed = previous.last_status != status;
            let exit_changed = previous.last_exit != exit;
            let grew = out_len.saturating_sub(previous.last_out_len) >= EMIT_MIN_BYTES;
            let interval_ok = previous.last_at.elapsed() >= EMIT_MIN_INTERVAL;
            let same = !status_changed && !exit_changed && out_len == previous.last_out_len;
            if same {
                return;
            }
            if !terminal && !status_changed && !exit_changed && !grew && !interval_ok {
                previous.pending_payload = Some(payload);
                previous.pending_emit = Some(emit);
                previous.due_at = Some(previous.last_at + EMIT_MIN_INTERVAL);
                return;
            }
        }

        let previous_output = states
            .get(&key)
            .map(|state| state.last_output.clone())
            .unwrap_or_default();
        if !previous_output.is_empty() && full_output.starts_with(&previous_output) {
            if let Some(output) = payload.get_mut("output") {
                *output = Value::String(full_output[previous_output.len()..].to_string());
            }
            if let Some(object) = payload.as_object_mut() {
                object.insert("outputDelta".into(), Value::Bool(true));
            }
        }

        if terminal {
            states.remove(&key);
        } else {
            states.insert(
                key,
                EmitState {
                    last_at: Instant::now(),
                    last_status: status,
                    last_out_len: out_len,
                    last_output: full_output,
                    last_exit: exit,
                    pending_payload: None,
                    pending_emit: None,
                    due_at: None,
                },
            );
        }
        drop(states);
        emit(payload);
    }

    pub fn clear_handle(&self, handle_id: &str) {
        let prefix = format!("{handle_id}:");
        self.states
            .lock()
            .retain(|key, _| !key.starts_with(&prefix));
    }
}

fn start_scheduler(states: Weak<Mutex<HashMap<String, EmitState>>>) {
    thread::Builder::new()
        .name("shell-stream-scheduler".into())
        .spawn(move || loop {
            thread::sleep(SCHEDULER_TICK);
            let Some(states) = states.upgrade() else {
                break;
            };
            let due = {
                let now = Instant::now();
                let mut states = states.lock();
                let mut due = Vec::new();
                for state in states.values_mut() {
                    if state.due_at.is_none_or(|deadline| deadline > now) {
                        continue;
                    }
                    state.due_at = None;
                    let Some(payload) = state.pending_payload.take() else {
                        state.pending_emit = None;
                        continue;
                    };
                    let Some(emit) = state.pending_emit.take() else {
                        continue;
                    };
                    let full_output = payload
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let mut wire_payload = payload;
                    if !state.last_output.is_empty() && full_output.starts_with(&state.last_output)
                    {
                        if let Some(output) = wire_payload.get_mut("output") {
                            *output =
                                Value::String(full_output[state.last_output.len()..].to_string());
                        }
                        if let Some(object) = wire_payload.as_object_mut() {
                            object.insert("outputDelta".into(), Value::Bool(true));
                        }
                    }
                    state.last_at = now;
                    state.last_out_len = full_output.len();
                    state.last_output = full_output;
                    state.last_status = wire_payload
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    state.last_exit = wire_payload.get("exitCode").and_then(Value::as_i64);
                    due.push((emit, wire_payload));
                }
                due
            };
            for (emit, payload) in due {
                emit(payload);
            }
        })
        .expect("spawn shell stream scheduler");
}

fn cap_output(payload: &mut Value) {
    let Some(output) = payload.get_mut("output") else {
        return;
    };
    let Some(text) = output.as_str() else {
        return;
    };
    if text.len() <= OUTPUT_MAX_BYTES {
        return;
    }
    let mut start = text.len() - OUTPUT_MAX_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    *output = Value::String(format!("[earlier output truncated]\n{}", &text[start..]));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(output: &str, status: &str) -> Value {
        json!({
            "handleId": "handle",
            "toolCallId": "tool",
            "status": status,
            "output": output,
            "exitCode": null
        })
    }

    #[test]
    fn coalesces_suppressed_updates_into_one_pending_flush() {
        let stream = ShellStream::default();
        let emit: ShellEmit = Arc::new(|_| {});
        stream.publish(snapshot("a", "in_progress"), Arc::clone(&emit));
        stream.publish(snapshot("ab", "in_progress"), Arc::clone(&emit));
        stream.publish(snapshot("abc", "in_progress"), emit);

        {
            let states = stream.states.lock();
            let state = states.get("handle:tool").expect("state");
            assert!(state.due_at.is_some());
            assert_eq!(state.pending_payload.as_ref().unwrap()["output"], "abc");
        }

        thread::sleep(EMIT_MIN_INTERVAL + Duration::from_millis(30));
        let states = stream.states.lock();
        let state = states.get("handle:tool").expect("state");
        assert!(state.due_at.is_none());
        assert!(state.pending_payload.is_none());
        assert_eq!(state.last_out_len, 3);
    }

    #[test]
    fn terminal_update_clears_state() {
        let stream = ShellStream::default();
        let emit: ShellEmit = Arc::new(|_| {});
        stream.publish(snapshot("a", "in_progress"), Arc::clone(&emit));
        stream.publish(snapshot("done", "completed"), emit);
        assert!(!stream.states.lock().contains_key("handle:tool"));
    }

    #[test]
    fn output_is_bounded_on_utf8_boundary() {
        let stream = ShellStream::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&emitted);
        let emit: ShellEmit = Arc::new(move |payload| capture.lock().push(payload));
        stream.publish(snapshot(&"界".repeat(100_000), "in_progress"), emit);
        let values = emitted.lock();
        let output = values[0]["output"].as_str().expect("output");
        assert!(output.len() <= OUTPUT_MAX_BYTES + 64);
        assert!(output.starts_with("[earlier output truncated]"));
    }

    #[test]
    fn growing_snapshot_is_sent_as_delta() {
        let stream = ShellStream::default();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&emitted);
        let emit: ShellEmit = Arc::new(move |payload| capture.lock().push(payload));
        stream.publish(snapshot("a", "in_progress"), Arc::clone(&emit));
        stream.publish(
            snapshot(&format!("a{}", "b".repeat(EMIT_MIN_BYTES)), "in_progress"),
            emit,
        );
        let values = emitted.lock();
        assert_eq!(values.len(), 2);
        assert_eq!(values[1]["outputDelta"], true);
        assert_eq!(
            values[1]["output"].as_str().expect("delta").len(),
            EMIT_MIN_BYTES
        );
    }
}
