<p align="center">
  <img
    src="https://cdn.jsdelivr.net/gh/3xian/MarsBuild@main/docs/logo.png"
    alt="MarsBuild"
    width="128"
  />
</p>

# MarsBuild

Desktop **control plane** for [Grok Build](https://x.ai): multi-task observability, white-box file changes, and risk-gated agent operations.

Built with **Tauri 2 + React + TypeScript + Rust**.

## Why

Local coding agents in the terminal struggle with:

- Parallel tasks spread across windows
- Progress / tokens / logs mixed into one noisy stream
- File edits as a black box
- Hard-to-audit history and high-risk ops

MarsBuild turns that into a single desktop surface: task board, metrics, timeline, change radar, live ACP control, and policy-gated permissions — driven by Grok’s on-disk sessions plus a live agent stream.

## Current status (0.1.0)

| Area | Status |
|------|--------|
| Scan `~/.grok/sessions` + `active_sessions.json` | ✅ |
| Task board (active / idle, filter, search) | ✅ |
| Token / tools / diff line metrics | ✅ |
| Session timeline (`updates.jsonl` / `events.jsonl`) | ✅ |
| File change radar (`hunk_records.jsonl`) | ✅ |
| Session index via FS watch (debounced) + ACP live stream | ✅ |
| Spawn `grok agent stdio` (ACP) | ✅ |
| Attach existing session (`session/load`) | ✅ |
| Live stream (thought / tool / message) | ✅ |
| Follow-up prompts + stop process | ✅ |
| Permission gate (approve / deny) | ✅ |
| Client FS write gate (`fs/write_text_file`) | ✅ |
| ACP `session/request_permission` | ✅ |
| Risk policy center (Research / Code / Balanced / Trusted) | ✅ |
| Per-project policy binding (`~/.marsbuild/policies.json`) | ✅ |
| Live shell output panel | ✅ |

## Stack

- **Shell**: Tauri 2
- **UI**: React 19 + Vite + TypeScript
- **Core**: Rust (session index, JSONL readers, ACP manager, policy engine, FS watcher)
- **Agent data**: Grok home (`GROK_HOME` or `~/.grok`)
- **Policy store**: `~/.marsbuild/policies.json`

## Develop

Prerequisites:

- Node 20+
- Rust stable (`rustup`)
- Xcode CLT (macOS)
- Grok Build installed (sessions under `~/.grok`)

```bash
npm install
npm run tauri:dev
```

Build release:

```bash
npm run tauri:build
```

Rust unit tests (policy, sessions, ACP handshake helpers):

```bash
cd src-tauri && cargo test
```

## Architecture

```
UI (React)
  ├─ invoke()  →  sessions / spawn / attach / prompt / stop / policy / permission
  └─ listen()  ←  agent-update | agent-status | agent-permission
                    | agent-shell | agent-prompt-complete | sessions-changed
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  AgentManager (Rust)     Session index (Rust)
  · N × AcpClient         · list / detail / hunks / stats
  · JSON-RPC over stdio   · FS watch (debounced)
  · permission queue      · ~/.grok/sessions/**
  · policy evaluate
        │
        ├─► grok agent [--always-approve] stdio
        ├─► session/update stream (live)
        └─► ~/.marsbuild/policies.json
```

Env overrides:

- `GROK_BIN` — Grok binary path (else `PATH` and `~/.grok/bin/grok`)
- `GROK_HOME` — Grok data root (default `~/.grok`)

## Product pillars

1. **Command center** — all tasks on one screen  
2. **White box** — tools, tokens, file hunks visible  
3. **Safety & history** — gated ops + traceable sessions  

## License

Private / TBD.
