//! Minimal ACP (Agent Client Protocol) JSON-RPC client over stdio.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use thiserror::Error;

/// How many trailing stderr lines to keep for transport-close diagnostics.
const STDERR_TAIL_LINES: usize = 12;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("rpc error {code}: {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
    #[error("timeout waiting for response to {0}")]
    Timeout(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AcpError>;

/// Callback for agent → client notifications / unsolicited messages.
pub type NotifyFn = Arc<dyn Fn(Value) + Send + Sync + 'static>;

pub struct AcpClient {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: Mutex<u64>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    pid: u32,
}

impl AcpClient {
    /// Spawn `grok [global_args…] agent [agent flags…] stdio`.
    ///
    /// `global_args` must come **before** `agent` (e.g. `--permission-mode auto`).
    /// `agent_args` come after `agent` and before `stdio` (e.g. `-m model`).
    pub fn spawn_with_notify(
        grok_bin: &str,
        always_approve: bool,
        global_args: &[String],
        agent_args: &[String],
        on_notify: NotifyFn,
    ) -> Result<Self> {
        let mut args: Vec<String> = Vec::new();
        args.extend(global_args.iter().cloned());
        args.push("agent".into());
        if always_approve {
            args.push("--always-approve".into());
        }
        args.extend(agent_args.iter().cloned());
        args.push("stdio".into());

        let mut cmd = Command::new(grok_bin);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Propagate proxy so grok can reach xAI APIs behind firewalls/proxies.
        // Uses shared detection: env vars first, then macOS system proxy fallback.
        if let Some(proxy_url) = crate::proxy::detect_proxy() {
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
                cmd.env(key, &proxy_url);
            }
        }

        // GUI host on Windows: hide the console window that `grok.exe` would open.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;

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

        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let stderr_tail: Arc<Mutex<VecDeque<String>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));

        if let Some(stderr) = stderr {
            let stderr_tail = Arc::clone(&stderr_tail);
            thread::spawn(move || {
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
            });
        }

        let pending_reader = Arc::clone(&pending);
        let stderr_for_close = Arc::clone(&stderr_tail);
        thread::spawn(move || {
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
                            if let Some(tx) = pending_reader.lock().remove(&id) {
                                let _ = tx.send(msg);
                                continue;
                            }
                        }
                    }
                }

                // Notifications + server→client requests
                on_notify(msg);
            }

            // Brief wait so the stderr thread can finish flushing after exit.
            thread::sleep(Duration::from_millis(50));
            let reason = transport_closed_message(&stderr_for_close);

            // EOF means this transport can no longer satisfy any in-flight RPC.
            // Notify the manager before waking request waiters so their error path
            // cannot briefly move an already-dead agent back to Ready.
            on_notify(json!({
                "method": "_pinkcode/transport_closed",
                "params": { "reason": reason }
            }));
            fail_pending_requests(&pending_reader, &reason);
        });

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            // High start id avoids collisions with agent-issued request ids (0,1,…)
            next_id: Mutex::new(10_000u64),
            pending,
            pid,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = {
            let mut n = self.next_id.lock();
            let id = *n;
            *n += 1;
            id
        };

        let (tx, rx): (Sender<Value>, Receiver<Value>) = mpsc::channel();
        self.pending.lock().insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        {
            let mut stdin = self.stdin.lock();
            writeln!(stdin, "{msg}")?;
            stdin.flush()?;
        }

        let resp = match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                // Drop the waiter so a late response cannot deliver to a dead channel
                // and cannot leave a permanent entry in the pending map.
                self.pending.lock().remove(&id);
                return Err(AcpError::Timeout(method.to_string()));
            }
        };

        if let Some(err) = resp.get("error") {
            let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            let data = err.get("data").cloned();
            return Err(AcpError::Rpc {
                code,
                message,
                data,
            });
        }

        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Respond to a server→client JSON-RPC request.
    pub fn respond_result(&self, id: &Value, result: Value) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let mut stdin = self.stdin.lock();
        writeln!(stdin, "{msg}")?;
        stdin.flush()?;
        Ok(())
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        });
        let mut stdin = self.stdin.lock();
        writeln!(stdin, "{msg}")?;
        stdin.flush()?;
        Ok(())
    }

    pub fn initialize(&self) -> Result<Value> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientInfo": {
                    "name": "pinkcode",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                // Advertise FS so Grok routes file ops through us — enables write gate.
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false,
                    // Meta capabilities aligned with Grok pager.
                    "meta": {
                        "x.ai/incrementalBashOutput": true,
                        "x.ai/bashOutputNoColor": true,
                        "x.ai/hunkTracker": { "mode": "agent_only" },
                    }
                },
                // Identify as Desktop client so shell prepends enable-always-approve
                // on permission prompts (Grok parity).
                // NOTE: This top-level "meta" is different from clientCapabilities.meta
                // above. Grok Build reads clientIdentifier from arguments.meta (top-level),
                // not from clientCapabilities.meta.
                "meta": {
                    "clientIdentifier": "grok-desktop"
                }
            }),
            Duration::from_secs(30),
        )
    }

    pub fn session_new(&self, cwd: &str) -> Result<Value> {
        self.request(
            "session/new",
            json!({
                "cwd": cwd,
                "mcpServers": []
            }),
            Duration::from_secs(60),
        )
    }

    pub fn session_load(&self, session_id: &str, cwd: &str) -> Result<Value> {
        self.request(
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": []
            }),
            Duration::from_secs(60),
        )
    }

    pub fn session_prompt(&self, session_id: &str, text: &str) -> Result<Value> {
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{ "type": "text", "text": text }]
            }),
            Duration::from_secs(60 * 30),
        )
    }

    /// ACP `session/set_mode` — switch agent operating mode (e.g. `plan`).
    ///
    /// Host Mode=Plan must call this; prefixing `/plan` in `session/prompt`
    /// alone is treated as plain user text and does not activate plan mode.
    pub fn session_set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value> {
        self.request(
            "session/set_mode",
            json!({
                "sessionId": session_id,
                "modeId": mode_id,
            }),
            Duration::from_secs(30),
        )
    }

    /// Send a JSON-RPC notification (no `id`, no response expected).
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut stdin = self.stdin.lock();
        writeln!(stdin, "{msg}")?;
        stdin.flush()?;
        Ok(())
    }

    /// ACP `session/cancel` — cancel in-flight turn gracefully.
    ///
    /// This is a notification (no response). The agent cancels the current turn,
    /// flushes hunks, and remains alive for future prompts.
    pub fn session_cancel(&self, session_id: &str, reason: &str) -> Result<()> {
        self.notify(
            "session/cancel",
            json!({
                "sessionId": session_id,
                "reason": reason,
            }),
        )
    }

    pub fn kill(&self) -> Result<()> {
        let mut child = self.child.lock();
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }
}

fn fail_pending_requests(pending: &Mutex<HashMap<u64, Sender<Value>>>, message: &str) {
    let waiters: Vec<(u64, Sender<Value>)> = pending.lock().drain().collect();
    for (id, tx) in waiters {
        let _ = tx.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32001, "message": message }
        }));
    }
}

/// Build a user-visible close reason, appending grok stderr when present.
fn transport_closed_message(stderr_tail: &Mutex<VecDeque<String>>) -> String {
    let lines: Vec<String> = stderr_tail.lock().iter().cloned().collect();
    if lines.is_empty() {
        return "ACP transport closed".into();
    }
    let detail = lines.join(" | ");
    format!("ACP transport closed: {detail}")
}

/// Build the argv passed to `grok` for ACP stdio (tests + spawn path).
#[cfg(test)]
pub fn build_spawn_argv(
    always_approve: bool,
    global_args: &[String],
    agent_args: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.extend(global_args.iter().cloned());
    args.push("agent".into());
    if always_approve {
        args.push("--always-approve".into());
    }
    args.extend(agent_args.iter().cloned());
    args.push("stdio".into());
    args
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn transport_close_wakes_all_pending_requests() {
        let pending = Mutex::new(HashMap::new());
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        pending.lock().insert(10, tx1);
        pending.lock().insert(11, tx2);

        fail_pending_requests(&pending, "closed");

        assert!(pending.lock().is_empty());
        assert_eq!(rx1.recv().expect("first waiter")["error"]["code"], -32001);
        assert_eq!(
            rx2.recv().expect("second waiter")["error"]["message"],
            "closed"
        );
    }

    #[test]
    fn transport_closed_message_includes_stderr_tail() {
        let empty = Mutex::new(VecDeque::new());
        assert_eq!(transport_closed_message(&empty), "ACP transport closed");

        let mut tail = VecDeque::new();
        tail.push_back("error: unexpected argument '--permission-mode' found".into());
        let with = Mutex::new(tail);
        let msg = transport_closed_message(&with);
        assert!(msg.starts_with("ACP transport closed: "));
        assert!(msg.contains("unexpected argument"));
    }

    #[test]
    fn spawn_argv_places_permission_mode_before_agent() {
        // Regression: Auto mode used `grok agent --permission-mode auto stdio`,
        // which clap rejects (flag is top-level only) → transport closed on Mac/Win.
        let global = vec!["--permission-mode".into(), "auto".into()];
        let agent = vec!["-m".into(), "grok-4".into()];
        assert_eq!(
            build_spawn_argv(false, &global, &agent),
            vec![
                "--permission-mode",
                "auto",
                "agent",
                "-m",
                "grok-4",
                "stdio",
            ]
        );
        assert_eq!(
            build_spawn_argv(true, &[], &[]),
            vec!["agent", "--always-approve", "stdio"]
        );
    }

    #[test]
    fn handshake_session_new_and_kill() {
        // Skip in CI — grok may be on PATH but ACP times out on remote runners.
        if std::env::var("CI").is_ok() {
            eprintln!("skip: CI environment detected");
            return;
        }
        // Resolve like production: GROK_BIN / GROK_HOME / PATH / ~/.grok/bin
        let grok = std::env::var("GROK_BIN")
            .ok()
            .filter(|p| std::path::Path::new(p).is_file())
            .or_else(|| {
                std::env::var("GROK_HOME").ok().and_then(|h| {
                    let base = std::path::PathBuf::from(h).join("bin").join("grok");
                    #[cfg(windows)]
                    {
                        let exe = base.with_extension("exe");
                        if exe.is_file() {
                            return Some(exe.display().to_string());
                        }
                    }
                    base.is_file().then(|| base.display().to_string())
                })
            })
            .or_else(|| {
                let home = dirs::home_dir()?;
                let base = home.join(".grok").join("bin").join("grok");
                #[cfg(windows)]
                {
                    let exe = base.with_extension("exe");
                    if exe.is_file() {
                        return Some(exe.display().to_string());
                    }
                }
                base.is_file().then(|| base.display().to_string())
            });
        let Some(grok) = grok else {
            eprintln!("skip: grok not installed");
            return;
        };
        let cwd = std::env::temp_dir();
        let notifs = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&notifs);
        let client = AcpClient::spawn_with_notify(
            &grok,
            true,
            &[],
            &[],
            Arc::new(move |_m| {
                c.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("spawn");
        client.initialize().expect("init");
        let res = client
            .session_new(&cwd.display().to_string())
            .expect("session/new");
        let sid = res.get("sessionId").and_then(|s| s.as_str()).unwrap();
        assert!(!sid.is_empty());
        client.kill().expect("kill");
        assert!(notifs.load(Ordering::SeqCst) > 0);
    }
}
