//! Minimal ACP (Agent Client Protocol) JSON-RPC client over stdio.

use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use thiserror::Error;

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
    pub fn spawn_with_notify(
        grok_bin: &str,
        always_approve: bool,
        extra_args: &[String],
        on_notify: NotifyFn,
    ) -> Result<Self> {
        let mut args: Vec<String> = vec!["agent".into()];
        if always_approve {
            args.push("--always-approve".into());
        }
        args.extend(extra_args.iter().cloned());
        args.push("stdio".into());

        let mut cmd = Command::new(grok_bin);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

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

        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        if let Some(stderr) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(|l| l.ok()) {
                    if !line.trim().is_empty() {
                        eprintln!("[grok-agent stderr] {line}");
                    }
                }
            });
        }

        let pending_reader = Arc::clone(&pending);
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
                        eprintln!(
                            "[acp] bad json: {e}; line={}",
                            &line[..line.len().min(200)]
                        );
                        continue;
                    }
                };

                // Client-bound response to our request
                if let Some(id_val) = msg.get("id") {
                    if msg.get("result").is_some() || msg.get("error").is_some() {
                        if msg.get("method").is_none() {
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
                }

                // Notifications + server→client requests
                on_notify(msg);
            }
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
                    "name": "marsbuild",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                // Advertise FS so Grok routes file ops through us — enables write gate.
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "terminal": false,
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

    pub fn kill(&self) -> Result<()> {
        let mut child = self.child.lock();
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }
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
    fn handshake_session_new_and_kill() {
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
                    base.is_file()
                        .then(|| base.display().to_string())
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
