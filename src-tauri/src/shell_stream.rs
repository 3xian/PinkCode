//! Throttled publication of shell snapshots to the webview.

use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const EMIT_MIN_INTERVAL: Duration = Duration::from_millis(120);
const EMIT_MIN_BYTES: usize = 4_096;

pub type ShellEmit = Arc<dyn Fn(Value) + Send + Sync + 'static>;

struct EmitState {
    last_at: Instant,
    last_status: String,
    last_out_len: usize,
    last_exit: Option<i64>,
    pending_payload: Option<Value>,
    flush_scheduled: bool,
}

#[derive(Clone, Default)]
pub struct ShellStream {
    states: Arc<Mutex<HashMap<String, EmitState>>>,
}

impl ShellStream {
    pub fn publish(&self, payload: Value, emit: ShellEmit) {
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
                if !previous.flush_scheduled {
                    previous.flush_scheduled = true;
                    Self::schedule_flush(Arc::clone(&self.states), key, emit);
                }
                return;
            }
        }

        if terminal {
            states.remove(&key);
        } else {
            let flush_scheduled = states
                .get(&key)
                .map(|state| state.flush_scheduled)
                .unwrap_or(false);
            states.insert(
                key,
                EmitState {
                    last_at: Instant::now(),
                    last_status: status,
                    last_out_len: out_len,
                    last_exit: exit,
                    pending_payload: None,
                    flush_scheduled,
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

    fn schedule_flush(
        states: Arc<Mutex<HashMap<String, EmitState>>>,
        key: String,
        emit: ShellEmit,
    ) {
        thread::spawn(move || {
            thread::sleep(EMIT_MIN_INTERVAL);
            let payload = {
                let mut states = states.lock();
                let Some(state) = states.get_mut(&key) else {
                    return;
                };
                state.flush_scheduled = false;
                let Some(payload) = state.pending_payload.take() else {
                    return;
                };
                state.last_at = Instant::now();
                state.last_out_len = payload
                    .get("output")
                    .and_then(Value::as_str)
                    .map(str::len)
                    .unwrap_or(0);
                state.last_status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                state.last_exit = payload.get("exitCode").and_then(Value::as_i64);
                payload
            };
            emit(payload);
        });
    }
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
            assert!(state.flush_scheduled);
            assert_eq!(state.pending_payload.as_ref().unwrap()["output"], "abc");
        }

        thread::sleep(EMIT_MIN_INTERVAL + Duration::from_millis(30));
        let states = stream.states.lock();
        let state = states.get("handle:tool").expect("state");
        assert!(!state.flush_scheduled);
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
}
