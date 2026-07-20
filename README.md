<!-- Relative path (same-repo) so GitHub does NOT rewrite via camo.githubusercontent.com,
     which often fails in CN even when the original CDN URL opens fine. -->
<p align="center">
  <img src="docs/logo.png" alt="MarsBuild" width="128" />
</p>

<h1 align="center">MarsBuild</h1>

<p align="center">
  <strong>Desktop mission control for Grok agents.</strong><br/>
  See every tool call, file change, and permission.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#what-you-get">What you get</a>
  ·
  <a href="#architecture">Architecture</a>
  ·
  <a href="#status">Status</a>
</p>

<br/>

A desktop console for [Grok Build](https://x.ai) — multi-task board, live ACP streams, file-change radar, and policy-gated permissions in one place. Stop babysitting a stack of terminals.

Built with **Tauri 2 · React · TypeScript · Rust**.

## Quick start

**Prerequisites**

| | macOS | Windows 11 | Linux |
|---|---|---|---|
| Node | 20+ | 20+ | 20+ |
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

Rust tests (policy, sessions, ACP helpers):

```bash
cd src-tauri && cargo test
```

**Env (optional):**

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` | Full path to `grok` / `grok.exe` (else `PATH`, `GROK_HOME/bin`, or `~/.grok/bin`) |
| `GROK_HOME` | Grok data root (default `~/.grok` / `%USERPROFILE%\.grok`) |
| `MARSBUILD_HOME` | MarsBuild config root for `policies.json` (default `~/.marsbuild`) |

## What you get

- **Command center** — every session on one board; spawn, attach, prompt, stop
- **White box** — thought / tool / message live stream, shell output, token & week usage
- **Change radar** — file hunks the agent actually wrote, not a black-box diff
- **Brakes** — permission gate + risk policies (Research / Code / Balanced / Trusted), per-project binding

Grok-native by design: reads `~/.grok/sessions`, speaks ACP over `grok agent stdio`, stores policies in `~/.marsbuild/policies.json`.

## Architecture

```
UI (React)
  ├─ invoke()  →  sessions / spawn / attach / prompt / stop / policy / permission / week usage
  └─ listen()  ←  agent-update | agent-status | agent-permission
                    | agent-shell | agent-prompt-complete | sessions-changed
        │
        ├─► AgentManager (Rust) — N × ACP client, permission queue, policy engine
        └─► Session index (Rust) — FS watch on ~/.grok/sessions, stats, hunks
```

## Status

Early **0.1.0** — usable for daily Grok multi-task ops; APIs and UI still moving.

<details>
<summary><strong>Feature checklist</strong></summary>

| Area | Status |
|------|--------|
| Scan `~/.grok/sessions` + `active_sessions.json` | ✅ |
| Task board (active / idle, filter, search) | ✅ |
| Token / tools / diff metrics + week usage bar | ✅ |
| Session timeline (`updates.jsonl` / `events.jsonl`) | ✅ |
| File change radar (`hunk_records.jsonl`) | ✅ |
| FS watch (debounced) + ACP live stream | ✅ |
| Spawn / attach (`grok agent stdio`, `session/load`) | ✅ |
| Live stream + shell panel + follow-up prompt / stop | ✅ |
| Permission gate + FS write gate | ✅ |
| Risk policy center + per-project binding | ✅ |

</details>

## License

Private / TBD.
