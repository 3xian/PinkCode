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
  <a href="#installation">Installation</a>
  ·
  <a href="#development">Development</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="docs/TODO.md">Roadmap</a>
</p>

A desktop GUI for [Grok Build](https://x.ai/cli) — multi-session task board, live timeline, workspace browser, permission management, and usage dashboard. PinkCode attaches to `grok` over [ACP](https://spec.acp.dev) (Agent Client Protocol) via stdio; it does not run its own agent loop.

**Tauri 2 · React 19 · TypeScript · Rust**

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
| **Mode** | Grok-style cycle: **Normal → Plan → Auto → Always-approve**. Plan is orthogonal to permission mode — the next user message becomes `/plan …`. When the agent exits plan mode, a review panel appears (Approve / Request changes / Quit). |
| **Permissions** | Five-level gate: Default (ask), Accept edits, Auto (classified by Grok), Bypass permissions, and Don't ask. Per-task preferences persist in `~/.pinkcode/task_prefs.json`. Handles reverse RPCs for tool permissions, file writes, plan approval, and user questions. |
| **Usage** | Weekly credit usage (Grok billing API) with per-product breakdown, plus 7-day token usage series derived from session logs. |
| **Updates** | Auto-checks GitHub Releases on startup with optional one-click install. |

## Installation

### 1. Install Grok Build

PinkCode requires the [Grok Build CLI](https://x.ai/cli).

**Windows (PowerShell):**

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

**macOS / Linux / WSL:**

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

By default, Grok stores its data under `~/.grok` on macOS/Linux and
`%USERPROFILE%\.grok` on Windows. Set `GROK_HOME` to use another location.

### 2. Install PinkCode

Download a prebuilt installer from **[GitHub Releases](https://github.com/3xian/PinkCode/releases)**:

- Windows x64: NSIS installer
- macOS: Apple Silicon and Intel builds
- Linux: build from source; CI installers are not available yet

## Development

### Prerequisites

| | macOS | Windows 11 | Linux |
|---|---|---|---|
| Node | 24+ | 24+ | 24+ |
| Rust | stable | stable (`x86_64-pc-windows-msvc`) | stable |
| Platform | Xcode CLT | MSVC Build Tools + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) | webkit2gtk ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)) |
| Grok Build | installed | installed | installed |

Windows toolchain (once):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-setup.ps1
```

### Build and run

```bash
npm ci
npm run tauri:dev          # development
npm run tauri:build        # local installer under src-tauri/target/release/bundle/
npm run check              # frontend + Rust (fmt/clippy/test) — same as CI
```

**Env (optional)**

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Path to `grok` / `grok.exe` |
| `GROK_HOME` | Grok data root (default `~/.grok`) |

## Architecture

```
UI (React 19 + TypeScript)
  |-- invoke() --> Tauri commands
  |                 sessions, agent lifecycle, permissions,
  |                 billing, workspace FS, git status
  |-- listen() <-- Tauri events
                    agent-* | sessions-changed
        |
        |-- AgentManager — N x `grok agent stdio` (ACP) + host permission gate
        |-- Session index — FS watcher on ~/.grok/sessions (cards, hunks, stats)
        |-- Billing — HTTP calls to Grok billing API (OIDC auth via ~/.grok/auth.json)
```

PinkCode communicates with Grok Build over ACP (JSON-RPC over stdio). The host-side permission gate intercepts reverse RPCs (`session/request_permission`, `fs/write_text_file`, `x.ai/exit_plan_mode`, `x.ai/ask_user_question`) and applies the configured risk policy before allowing or denying agent actions.

## License

Copyright (c) 2026 3xian.

Licensed under the [Apache License 2.0](LICENSE).
