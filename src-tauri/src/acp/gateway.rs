//! Channel-based ACP I/O gateway.
//!
//! Owns child `stdin` writes and demultiplexes stdout responses onto per-call
//! oneshot channels. Callers apply `recv_timeout` for deadlines; the gateway
//! still completes oneshots on RPC result, RPC error, abandon, or transport close.

use super::{AcpError, NotifyFn, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const STDERR_TAIL_LINES: usize = 12;
const NOTIFICATION_QUEUE_CAPACITY: usize = 512;
/// Bound in-flight gateway commands so a wedged writer cannot grow without limit.
const CMD_QUEUE_CAPACITY: usize = 256;

/// Oneshot reply for a single JSON-RPC request (`Ok` = result payload).
type ReplyTx = Sender<std::result::Result<Value, AcpError>>;
/// Shared abandon flag: caller sets true on `recv_timeout` so a queued Call never hangs.
type CallToken = Arc<AtomicBool>;

enum GatewayCmd {
    /// Allocate an id, write a request, complete `reply` when the agent answers.
    Call {
        method: String,
        params: Value,
        reply: ReplyTx,
        token: CallToken,
    },
    /// Drop a pending entry after the caller's `recv_timeout` fired (no hang threads).
    Abandon { token: CallToken },
    /// Write a notification or response line (no id correlation).
    Write {
        line: String,
        reply: Sender<std::result::Result<(), AcpError>>,
    },
    Kill {
        reply: Sender<std::result::Result<(), AcpError>>,
    },
}

pub(super) struct PendingEntry {
    reply: ReplyTx,
    token: CallToken,
}

/// Handle to the gateway actor. Owns the command channel to the writer thread.
pub struct AcpGateway {
    cmd_tx: SyncSender<GatewayCmd>,
    pid: u32,
    /// Held so `Drop` / `kill` can reap the process if the gateway thread exits early.
    child: Arc<Mutex<Option<Child>>>,
}

impl AcpGateway {
    pub fn start(mut child: Child, on_notify: NotifyFn) -> Result<Self> {
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AcpError::Other("missing stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AcpError::Other("missing stdout".into()))?;
        let stderr = child.stderr.take();

        let child = Arc::new(Mutex::new(Some(child)));
        let pending: Arc<Mutex<HashMap<u64, PendingEntry>>> = Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail: Arc<Mutex<VecDeque<String>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));

        if let Some(stderr) = stderr {
            let stderr_tail = Arc::clone(&stderr_tail);
            thread::Builder::new()
                .name("acp-stderr".into())
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(|l| l.ok()) {
                        if line.trim().is_empty() {
                            continue;
                        }
                        eprintln!("[grok-agent stderr] {line}");
                        let mut tail = stderr_tail.lock();
                        if tail.len() >= STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                })
                .map_err(|e| AcpError::Other(format!("spawn stderr thread: {e}")))?;
        }

        // Notify dispatch off the reader so reverse-RPC / UI work cannot stall demux.
        let (notify_tx, notify_rx) = mpsc::sync_channel::<Value>(NOTIFICATION_QUEUE_CAPACITY);
        let notify_dispatch = Arc::clone(&on_notify);
        thread::Builder::new()
            .name("acp-notify-dispatch".into())
            .spawn(move || {
                for msg in notify_rx {
                    notify_dispatch(msg);
                }
            })
            .map_err(|e| AcpError::Other(format!("spawn notify thread: {e}")))?;

        let pending_reader = Arc::clone(&pending);
        let stderr_for_close = Arc::clone(&stderr_tail);
        let reverse_dispatch = Arc::clone(&on_notify);
        let close_notify = Arc::clone(&on_notify);
        thread::Builder::new()
            .name("acp-stdout".into())
            .spawn(move || {
                run_stdout_reader(
                    stdout,
                    pending_reader,
                    stderr_for_close,
                    notify_tx,
                    reverse_dispatch,
                    close_notify,
                );
            })
            .map_err(|e| AcpError::Other(format!("spawn stdout thread: {e}")))?;

        let (cmd_tx, cmd_rx) = mpsc::sync_channel::<GatewayCmd>(CMD_QUEUE_CAPACITY);
        let pending_writer = Arc::clone(&pending);
        let child_for_kill = Arc::clone(&child);
        thread::Builder::new()
            .name("acp-gateway".into())
            .spawn(move || {
                run_gateway(stdin, cmd_rx, pending_writer, child_for_kill);
            })
            .map_err(|e| AcpError::Other(format!("spawn gateway thread: {e}")))?;

        Ok(Self { cmd_tx, pid, child })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// JSON-RPC request. Caller applies `recv_timeout`; transport close still
    /// completes the oneshot via the gateway. No per-call sleep threads.
    pub fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let token: CallToken = Arc::new(AtomicBool::new(false));
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(GatewayCmd::Call {
                method: method.to_string(),
                params,
                reply: reply_tx,
                token: Arc::clone(&token),
            })
            .map_err(|_| AcpError::TransportClosed("ACP gateway command channel closed".into()))?;
        match reply_rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Timeout) => {
                // Mark first so a still-queued Call never inserts a waiter.
                // Abandon is best-effort: if the cmd queue is full, do not block
                // after timeout — token already prevents a hung reply waiter.
                token.store(true, Ordering::SeqCst);
                let _ = self.cmd_tx.try_send(GatewayCmd::Abandon { token });
                Err(AcpError::Timeout(method.to_string()))
            }
            Err(RecvTimeoutError::Disconnected) => Err(AcpError::TransportClosed(
                "ACP gateway dropped request reply".into(),
            )),
        }
    }

    pub fn write_line(&self, line: String) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(GatewayCmd::Write {
                line,
                reply: reply_tx,
            })
            .map_err(|_| AcpError::TransportClosed("ACP gateway command channel closed".into()))?;
        reply_rx
            .recv()
            .map_err(|_| AcpError::TransportClosed("ACP gateway dropped write reply".into()))?
    }

    pub fn kill(&self) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        // If the gateway is already gone, fall back to killing the child directly.
        if self
            .cmd_tx
            .send(GatewayCmd::Kill { reply: reply_tx })
            .is_err()
        {
            return kill_child(&self.child);
        }
        reply_rx.recv().unwrap_or_else(|_| kill_child(&self.child))
    }
}

impl Drop for AcpGateway {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

fn run_gateway(
    mut stdin: ChildStdin,
    cmd_rx: Receiver<GatewayCmd>,
    pending: Arc<Mutex<HashMap<u64, PendingEntry>>>,
    child: Arc<Mutex<Option<Child>>>,
) {
    let mut next_id: u64 = 10_000; // high start avoids agent-issued id collisions

    while let Ok(cmd) = cmd_rx.recv() {
        match cmd {
            GatewayCmd::Call {
                method,
                params,
                reply,
                token,
            } => {
                let id = next_id;
                next_id = next_id.wrapping_add(1);

                let msg = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": method,
                    "params": params,
                });
                let line = match serde_json::to_string(&msg) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = reply.send(Err(AcpError::Json(e)));
                        continue;
                    }
                };

                if let Err(e) = writeln!(stdin, "{line}").and_then(|_| stdin.flush()) {
                    // Caller may already have timed out — only surface Io if still waiting.
                    if !token.load(Ordering::SeqCst) {
                        let _ = reply.send(Err(AcpError::Io(e)));
                    }
                    // stdin is dead — fail everyone and exit
                    fail_all_pending(&pending, "ACP stdin write failed");
                    break;
                }

                // Timed out while this Call was still queued / writing: do not hang a waiter.
                if token.load(Ordering::SeqCst) {
                    continue;
                }

                pending.lock().insert(
                    id,
                    PendingEntry {
                        reply,
                        token: Arc::clone(&token),
                    },
                );
                // Re-check after insert: Abandon may have run between the load and insert.
                if token.load(Ordering::SeqCst) {
                    pending.lock().remove(&id);
                }
            }
            GatewayCmd::Abandon { token } => {
                // Drop matching waiter after caller-side recv_timeout; no reply needed.
                pending
                    .lock()
                    .retain(|_, entry| !Arc::ptr_eq(&entry.token, &token));
            }
            GatewayCmd::Write { line, reply } => {
                let result = writeln!(stdin, "{line}")
                    .and_then(|_| stdin.flush())
                    .map_err(AcpError::Io);
                if result.is_err() {
                    let _ = reply.send(result);
                    fail_all_pending(&pending, "ACP stdin write failed");
                    break;
                }
                let _ = reply.send(Ok(()));
            }
            GatewayCmd::Kill { reply } => {
                fail_all_pending(&pending, "ACP client killed");
                let _ = reply.send(kill_child(&child));
                break;
            }
        }
    }

    // Channel closed (all AcpGateway handles dropped) — reap process.
    fail_all_pending(&pending, "ACP gateway stopped");
    let _ = kill_child(&child);
}

fn run_stdout_reader(
    stdout: impl std::io::Read + Send + 'static,
    pending: Arc<Mutex<HashMap<u64, PendingEntry>>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    notify_tx: SyncSender<Value>,
    reverse_dispatch: NotifyFn,
    close_notify: NotifyFn,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[acp] bad json: {e}; line={}", &line[..line.len().min(200)]);
                continue;
            }
        };

        // Client-bound response to our request
        if let Some(id_val) = msg.get("id") {
            if (msg.get("result").is_some() || msg.get("error").is_some())
                && msg.get("method").is_none()
            {
                let id = match id_val {
                    Value::Number(n) => n.as_u64(),
                    Value::String(s) => s.parse().ok(),
                    _ => None,
                };
                if let Some(id) = id {
                    if let Some(entry) = pending.lock().remove(&id) {
                        let _ = entry.reply.send(decode_rpc_response(msg));
                        continue;
                    }
                }
            }
        }

        let is_request = msg.get("id").is_some()
            && msg.get("method").is_some()
            && msg.get("result").is_none()
            && msg.get("error").is_none();
        if is_request {
            // Reverse requests cannot be dropped: dispatch off the reader.
            let handler = Arc::clone(&reverse_dispatch);
            let _ = thread::Builder::new()
                .name("acp-reverse-rpc".into())
                .spawn(move || handler(msg));
        } else {
            // Notifications are advisory; bound the queue so a stalled WebView
            // cannot exhaust memory or block stdout draining.
            match notify_tx.try_send(msg) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => break,
            }
        }
    }

    // Brief wait so the stderr thread can finish flushing after exit.
    thread::sleep(Duration::from_millis(50));
    let reason = transport_closed_message(&stderr_tail);

    close_notify(json!({
        "method": "_pinkcode/transport_closed",
        "params": { "reason": reason }
    }));
    fail_all_pending(&pending, &reason);
}

fn decode_rpc_response(resp: Value) -> std::result::Result<Value, AcpError> {
    if let Some(err) = resp.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error")
            .to_string();
        let data = err.get("data").cloned();
        if code == -32001 {
            return Err(AcpError::TransportClosed(message));
        }
        return Err(AcpError::Rpc {
            code,
            message,
            data,
        });
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

fn fail_all_pending(pending: &Mutex<HashMap<u64, PendingEntry>>, message: &str) {
    let waiters: Vec<PendingEntry> = pending.lock().drain().map(|(_, e)| e).collect();
    for entry in waiters {
        let _ = entry
            .reply
            .send(Err(AcpError::TransportClosed(message.to_string())));
    }
}

fn kill_child(child: &Mutex<Option<Child>>) -> Result<()> {
    let mut guard = child.lock();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn transport_closed_message(stderr_tail: &Mutex<VecDeque<String>>) -> String {
    let lines: Vec<String> = stderr_tail.lock().iter().cloned().collect();
    if lines.is_empty() {
        return "ACP transport closed".into();
    }
    let detail = lines.join(" | ");
    format!("ACP transport closed: {detail}")
}

/// Test helper — same close-message formatting as the reader.
#[cfg(test)]
pub(super) fn transport_closed_message_for_test(stderr_tail: &Mutex<VecDeque<String>>) -> String {
    transport_closed_message(stderr_tail)
}

#[cfg(test)]
pub(super) fn fail_all_pending_for_test(
    pending: &Mutex<HashMap<u64, PendingEntry>>,
    message: &str,
) {
    fail_all_pending(pending, message);
}

#[cfg(test)]
pub(super) fn pending_with(reply: ReplyTx) -> PendingEntry {
    PendingEntry {
        reply,
        token: Arc::new(AtomicBool::new(false)),
    }
}
