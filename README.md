<!-- Relative path so GitHub does not rewrite via camo (often broken in CN). -->
<p align="center">
  <img src="docs/logo.png" alt="PinkCode" width="128" />
</p>

<h1 align="center">PinkCode</h1>

<p align="center">
  <strong>Desktop control plane for Grok Build.</strong>
</p>

<p align="center">
  <a href="#screenshot">Screenshot</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="docs/TODO.md">Roadmap</a>
</p>

A desktop GUI for [Grok Build](https://x.ai/cli) — multi-session task board, live timeline, workspace browser, permission management, and usage dashboard. Attaches to `grok` over [ACP](https://spec.acp.dev) (Agent Client Protocol) via stdio; it does not run its own agent loop.

**Tauri 2 · React 19 · TypeScript · Rust** · current version **0.2.6**

## Screenshot

<p align="center">
  <img src="docs/screenshot.png" alt="PinkCode — tasks, Timeline, workspace" width="100%" />
</p>

## Features

| Area | Behavior |
|------|----------|
| **Tasks** | Multi-session board: sessions under `~/.grok` (`%USERPROFILE%\.grok` on Windows). Create, select, prompt, and stop tasks. First send auto-connects via ACP. |
| **Timeline** | Unified stream of user messages, agent responses, thoughts, tool calls, shell output, plans, and events. Live ACP when connected; disk-hydrated from `updates.jsonl` otherwise. Filter chips + auto-scroll. |
| **File changes** | Agent file-hunk display from `hunk_records.jsonl`. |
| **Workspace** | Project file tree and Git porcelain status in a side panel. Supports file preview (text, images, binary detection). |
| **Mode** | Grok parity ring: **Normal → Plan → Auto → Always-approve**. Plan is orthogonal to permission mode — the next user message becomes `/plan …`. When the agent calls `exit_plan_mode`, a review panel appears (Approve / Request changes / Quit). Mode changes only affect the host ACP gate. |
| **Permissions** | Five-level gate: Default (ask), Accept edits, Auto (risk-classified), Bypass permissions, Don't ask. Per-task preferences persisted in `~/.pinkcode/task_prefs.json`. Handles reverse RPCs: tool permission, file write, plan approval, and user questions. |
| **Usage** | Weekly credit usage (Grok billing API) with per-product breakdown, plus 7-day token usage series derived from session logs. |
| **Updates** | Auto-checks GitHub Releases on startup with optional one-click install. |

Prebuilt installers: **[Releases](https://github.com/3xian/PinkCode/releases)** (Windows x64 NSIS, macOS Apple Silicon & Intel). Linux: build from source (no CI installer yet).

## Quick start

### 1. Install Grok Build first

PinkCode attaches to [Grok Build](https://grok.com/build) over ACP — install the CLI before running PinkCode.

**Windows (PowerShell):**

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

**macOS / Linux / WSL:**

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

After install, the `grok` binary and data live under `~/.grok` (or `%USERPROFILE%\.grok` / `GROK_HOME` on Windows).

### 2. Dev prerequisites

| | macOS | Windows 11 | Linux |
|---|---|---|---|
| Node | 24+ | 24+ | 24+ |
| Rust | stable | stable (`x86_64-pc-windows-msvc`) | stable |
| Platform | Xcode CLT | MSVC Build Tools + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) | webkit2gtk (see Tauri docs) |
| Grok Build | installed (step 1) | installed (step 1) | installed (step 1) |

Windows toolchain (once):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-setup.ps1
```

### 3. Build and run PinkCode

```bash
npm install
npm run tauri:dev          # development
npm run tauri:build        # local installer under src-tauri/target/release/bundle/
npm run check              # frontend + Rust (fmt/clippy/test) — same as CI
```

**Env (optional)**

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Path to `grok` / `grok.exe` |
| `GROK_HOME` | Grok data root (default `~/.grok`) |
| `PINKCODE_HOME` | PinkCode prefs root (default `~/.pinkcode`) |

## Architecture

```
UI (React 19 + TypeScript)
  |-- invoke() --> Tauri IPC (30 commands)
  |                 sessions, agent lifecycle, permissions,
  |                 billing, workspace FS, git status
  |-- listen() <-- Tauri events (7 channels)
                    agent-update | agent-status | agent-permission
                  | agent-shell | agent-prompt-complete | sessions-changed
        |
        |-- AgentManager — N x `grok agent stdio` (ACP) + host permission gate
        |-- Session index — FS watcher on ~/.grok/sessions (cards, hunks, stats)
        |-- Billing — HTTP calls to Grok billing API (OIDC auth via ~/.grok/auth.json)
```

PinkCode communicates with Grok Build over ACP (JSON-RPC over stdio). The host-side permission gate intercepts reverse RPCs (`session/request_permission`, `fs/write_text_file`, `x.ai/exit_plan_mode`, `x.ai/ask_user_question`) and applies the configured risk policy before allowing or denying agent actions.

## License

Copyright (c) 2026 3xian. All rights reserved. Published without an open-source license.
