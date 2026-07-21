<!-- Relative path (same-repo) so GitHub does NOT rewrite via camo.githubusercontent.com,
     which often fails in CN even when the original CDN URL opens fine. -->
<p align="center">
  <img src="docs/logo.png" alt="MarsBuild" width="128" />
</p>

<h1 align="center">MarsBuild</h1>

<p align="center">
  <strong>Desktop mission control for Grok agents.</strong><br/>
  Stop babysitting terminals. Start commanding agents.
</p>

<p align="center">
  <a href="#screenshot">Screenshot</a>
  ·
  <a href="#why">Why</a>
  ·
  <a href="#what-you-get">What you get</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#status">Status</a>
  ·
  <a href="docs/TODO.md">Roadmap</a>
</p>

<br/>

**Grok thinks. MarsBuild keeps you in command.**

A desktop console for [Grok Build](https://x.ai) — multi-task attach, live ACP streams, workspace radar, and usage in one place. Not another agent. Not another chat window. The control tower for the agents you already run.

Built with **Tauri 2 · React · TypeScript · Rust**.

## Screenshot

<p align="center">
  <img src="docs/screenshot.png" alt="MarsBuild desktop UI — task board, Live stream, workspace files and Git" width="100%" />
</p>

<p align="center">
  <em>Task board · Live ACP stream · context metrics · workspace tree &amp; Git — one window for every Grok agent.</em>
</p>

---

## Why

You do not need a smarter agent.

You need to see **every Grok session at once** — without juggling a stack of terminals, grepping logs for file edits, or hunting the right window to approve a tool call.

| Without MarsBuild | With MarsBuild |
|---|---|
| One terminal per task | One board for every task |
| Black-box progress | Thought · tool · shell · message, live |
| “What did it change?” | Files, Git, and agent hunks in view |
| Blind on quota | Week usage + context metrics in the chrome |

**Engine is Grok. MarsBuild is the hand on the wheel.**

---

## What you get

### 1. One board for every task

Spawn, attach, prompt, stop. A switch on each card takes over or detaches a live agent. Active, waiting on permission, idle, error — at a glance.

### 2. White box, not black box

Live stream of thought, agent text, tools, shell, plan, and session events — terminal-style, filterable, stick-to-bottom. Follow-up prompts and Grok slash commands (`/compact`, `/plan`, …) in the same surface. History and raw ACP when you need the record.

### 3. Changes on the ground

Project file tree and Git status on the side; Diff tab for agent hunks. Right-click to copy paths or open in the system. Usage bar so you know how much fuel is left — control is seeing, not guessing.

### 4. Brakes that match Grok

Permission modes aligned with Grok Build (ask · accept edits · always approve · don’t ask), per-task persistence, and an in-app gate when the agent needs a decision. MarsBuild is an ACP host — it does not invent a second safety religion.

**What we deliberately are not**

- A reimplementation of the Grok (or any) agent loop  
- A multi-provider coding agent platform  
- A replacement for the Grok TUI  

We stay a **control plane**: attach what Grok already is, make multi-task ops sane.

---

## Quick start

**Prerequisites**

| | macOS | Windows 11 | Linux |
|---|---|---|---|
| Node | 24+ | 24+ | 24+ |
| Rust | stable | stable (`x86_64-pc-windows-msvc`) | stable |
| Platform tools | Xcode CLT | **MSVC Build Tools** + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled on Win11) | webkit2gtk / similar (see Tauri docs) |
| Grok Build | `~/.grok` | `%USERPROFILE%\.grok` or `GROK_HOME` (binary: `grok.exe`) | `~/.grok` |

Windows 11 — install the C++ toolchain once (required for `cargo` / Tauri link):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Optional: put Build Tools on another drive with `--installPath D:\path\to\BuildTools` in the override string.

Then open a **new** terminal (so the MSVC tools are discoverable), or use *x64 Native Tools Command Prompt for VS 2022*.

Quick environment check:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows-setup.ps1
```

```bash
npm install
npm run tauri:dev
```

Release build:

```bash
npm run tauri:build
```

On Windows this produces NSIS/MSI installers under `src-tauri/target/release/bundle/`.

### GitHub Releases

Pushing a version tag builds and publishes Windows x64 MSI/NSIS installers and
macOS DMGs for Apple Silicon and Intel:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag must match the version in `package.json`. Before creating a new release,
keep the versions in `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` in sync.

Rust tests:

```bash
cd src-tauri && cargo test
```

Frontend tests and production type/build check:

```bash
npm run check
```

**Env (optional):**

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Full path to `grok` / `grok.exe` (else `PATH`, `GROK_HOME/bin`, or `~/.grok/bin`) |
| `GROK_HOME` | Grok data root (default `~/.grok` / `%USERPROFILE%\.grok`) |
| `MARSBUILD_HOME` | MarsBuild data root (default `~/.marsbuild`; e.g. task permission prefs) |

---

## Architecture

```
UI (React)
  ├─ invoke()  →  sessions / spawn / attach / prompt / stop / permission / week usage / FS / git
  └─ listen()  ←  agent-update | agent-status | agent-permission
                    | agent-shell | agent-prompt-complete | sessions-changed
        │
        ├─► AgentManager (Rust) — N × ACP lifecycle + request coordination
        │     ├─ agent_types / permission_policy / agent_fs
        │     └─ shell_stream / agent_runtime
        └─► Session index (Rust) — FS watch, mtime cache, stats, hunks
```

Grok-native by design: reads `~/.grok/sessions`, speaks ACP over `grok agent stdio`, keeps light prefs under `~/.marsbuild`.

---

## Status

Early **0.1.0** — usable for daily Grok multi-task ops; APIs and UI still moving.

Product roadmap and backlog: **[docs/TODO.md](docs/TODO.md)**.

<details>
<summary><strong>Feature checklist</strong></summary>

| Area | Status |
|------|--------|
| Scan `~/.grok/sessions` + `active_sessions.json` | ✅ |
| Task board + attach / detach switch | ✅ |
| Spawn / attach (`grok agent stdio`, `session/load`) | ✅ |
| Live stream (thought / agent / tool / shell / plan / events) | ✅ |
| Slash-command autocomplete in prompt | ✅ |
| Follow-up prompt + stop | ✅ |
| Permission gate + Grok-aligned permission modes | ✅ |
| Token / tools / diff metrics + week usage bar | ✅ |
| History + raw ACP stream | ✅ |
| File tree + Git status (workspace panel) | ✅ |
| File change radar (`hunk_records.jsonl`) | ✅ |
| FS watch (debounced) | ✅ |

</details>

---

## License

Copyright (c) 2026 david. All rights reserved. This package is published without an open-source license.
