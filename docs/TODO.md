# PinkCode TODO — Grok Build host parity

ACP / reverse-RPC / capability backlog from a read-only audit of
[xai-org/grok-build](https://github.com/xai-org/grok-build).
This file is the **protocol / capability / infrastructure** checklist
so we do not re-guess wire behavior.

**Positioning:** Desktop mission control for external `grok` (ACP host). Do not re-implement the agent loop.

## Legend

| Priority | Meaning |
|----------|---------|
| **Must** | Wrong or missing → stuck turns, silent loss of function, or unsafe Stop |
| **Should** | UX / TUI parity; safe to defer with clear fallbacks |
| **Ignore** | Leader / cloud / full TUI; do not implement unless we advertise the capability |

| Direction | Meaning |
|-----------|---------|
| **A→H** | Agent → Host reverse request (blocking) or notification |
| **H→A** | Host → Agent method |

> **Three different "ask":** ① SessionMode `ask` = read-only Q&A mode
> (`session/set_mode({ modeId: "ask" })`, `PromptMode::Ask`), currently **missing**.
> ② Permission ring `ask` = host gate before tools (Default mode), **present**.
> ③ `ask_user_question` tool = multi-choice form, **present**.
> UI label *"Ask before tools"* means ②, not ①.

---

## Must

- [ ] **FollowupMessage support** — reject with follow-up via `meta.followup_message` on `RejectOnce`
- [ ] **Cancelled decision** — distinguish Cmd+C / close from rejection → `StopReason::Cancelled`
- [ ] **Plan state machine edge cases** — approve / request changes / abandon; mid-turn `set_mode(plan)`; Mode chip exit → `set_mode(default)`. Host must not force `set_mode(default)` on Approve.

---

## Should

### Capabilities

- [ ] `x.ai/gitHeadChanged: true` — workspace HEAD follow
- [ ] **`x.ai/interject`** — mid-turn user text; plan approve-with-comments follow-up
- [ ] **`x.ai/queue/*`** — remove / reorder / clear / edit / interject
- [ ] **`x.ai/session/usage`** — live turn cost
- [ ] **`x.ai/recap` / `rewind/*` / compact** — history product
- [ ] **`x.ai/subagent/cancel` + list** — subagent tree cancel
- [ ] **`x.ai/task/list` / `kill`** — background tasks
- [ ] **`x.ai/hunk-tracker/*`** — after advertising hunk capability
- [ ] **`x.ai/session_notification`** — pending_interaction, subagent_*, interaction_resolved
- [ ] **`x.ai/fs_notify` / git head** — after capability ads
- [ ] **Structured `session/update` kinds** — goal_updated / turn_completed / session_recap
- [ ] **`prompt_complete` / running state** — explicit signals over heuristics
- [ ] **`authenticate`** — session authentication handshake
- [ ] **`set_session_model`** — change model mid-session

> Do not advertise `gitHeadChanged` without implementing the reverse path. Same for `folderTrust.interactive`, `codeNavigation.enabled`, client hooks, SDK MCP, `terminal: true`.

### Permission — UX

- [ ] Allow session / Persist rule
- [ ] Plan approval **never** auto-skipped under Always-approve

### Permission — safety

- [ ] **Bash command decomposition** — split compound commands (`&&`, `||`, `;`, pipes, subshells) and evaluate each segment independently. *Ref: `bash_decompose.rs`*
- [ ] **Permission rule system** — `CompiledPolicy` with glob patterns per tool type. *Ref: `policy.rs`*
- [ ] **LLM classifier for Auto mode** — heuristic fast-path + LLM side-query. *Ref: `classifier.rs`*
- [ ] **Persistent permission state** — cross-restart memory for allowed commands, domains, MCP tools. *Ref: `state.rs`*
- [ ] **Security hardening** — CWE-178 (whitespace prefix), CWE-183 (prefix boundary), CWE-863 (tee)

### Git

- [ ] **Real-time git status panel** — branch, upstream, ahead/behind, staged/unstaged
- [ ] **Diff viewer** — inline file diffs in session detail
- [ ] **Hunk selection for commit** — interactive per-hunk review

### Shell

- [ ] Tool identity via `_meta/x.ai/tool` taxonomy + incremental bash chunks

### Subagent / tasks

- [ ] **Subagent hierarchy in UI** — parent/child relationships, depth, fork budget
- [ ] **Background task status** — display TaskTool / WaitTasksTool / KillTaskTool state

---

## Infrastructure

Source-audit items: host-side quality, safety, and architecture improvements.
Treat as **Should** priority.

### ACP client

- [ ] **Async channel-based client** — replace `mpsc` + `recv_timeout` with Gateway pattern. *Ref: `xai-acp-lib/src/gateway.rs`*
- [ ] **Fire-and-forget notifications** — non-blocking delivery for unsolicited messages
- [ ] **Type-safe protocol layer** — `AcpRequest` trait or macro-generated pairs instead of raw `serde_json::Value`

### Error handling

- [ ] **Categorized error variants** — `thiserror` with descriptive variants instead of 5-variant `AcpError`. *Ref: `xai-grok-agent/src/error.rs`*
- [ ] **Channel failure classification** — `SendFailed` vs `RecvFailed` via tagged data fields
- [ ] **Graceful degradation** — reconnection path when ACP transport dies; fallback operations (e.g. libgit2 → CLI)

### Logging

- [ ] **Replace `eprintln!` with `tracing`** — structured, leveled logging with span context

### Config

- [ ] **Layered config system** — priority-based loading (env → global → project → session) with atomic writes

---

## Ignore

Do **not** treat as core PinkCode work. Prefer not advertising related capabilities.

| Area | Examples |
|------|----------|
| Leader / multi-client | `x.ai/sessions/changed`, leaderClientId, version_mismatch |
| Cloud / hub | cloud env, hub bind, scheduled_task inject routing |
| Auth device-code suite | `x.ai/auth/*` full UI (rely on `grok login`) |
| Marketplace / bundle / plugins admin | marketplace, bundle, plugins action UIs |
| Folder trust interactive | `folder_trust/request` |
| Client hooks host | `x.ai/hooks/run` (agent fail-open if missing) |
| SDK MCP reverse | `x.ai/mcp/sdk_call` |
| Host-owned terminal | ACP `terminal/*` with `terminal: true` |
| Full TUI chrome | line-comment plan UI, pager scrollback, announcements chrome |

Unknown reverse methods today: JSON-RPC `-32601`. Acceptable when capability not advertised; agent hooks fail-open.

---

## Source anchors (grok-build)

| Category | Path (under ref checkout) |
|----------|---------------------------|
| ACP gateway | `xai-acp-lib/src/gateway.rs` |
| ACP session mode | `…/acp_session_impl/session_mode.rs` |
| ACP agent | `…/mvp_agent/acp_agent.rs` (InitializeResponse, cancel) |
| Plan tracker | `xai-grok-shell/src/session/plan_mode.rs` |
| Pending interactions | `…/session/pending_interaction.rs` |
| File state tracker | `…/session/file_state_tracker.rs` |
| Rewind / checkpoints | `…/session/rewind.rs` |
| Permission decompose | `xai-grok-workspace/src/permission/bash_decompose.rs` |
| Permission policy | `xai-grok-workspace/src/permission/policy.rs` |
| Permission classifier | `xai-grok-workspace/src/permission/classifier.rs` |
| Permission state | `xai-grok-workspace/src/permission/state.rs` |
| Git | `xai-grok-workspace/src/git/` |
| Hunk tracker | `…/hunk_tracker/` |
| Session mode types | `xai-grok-tools/src/types/session_mode.rs` |
| exit_plan wire | `…/exit_plan_mode/types.rs` |
| ask_user wire | `…/ask_user_question/types.rs` |
| Agent errors | `xai-grok-agent/src/error.rs` |
| Subagent resolution | `xai-grok-subagent-resolution/` |
| Task tools | `…/tools/task_tool.rs`, `wait_tasks_tool.rs`, `kill_task_tool.rs` |
| Config | `xai-grok-workspace/src/config/` |
| MCP state | `…/mcp/state.rs` |
| Client hooks | `…/session/acp_session/hooks.rs` |
| Initialize meta | `xai-grok-pager/src/acp/mod.rs` (`client_capabilities_meta`) |
| Interaction reverse | `…/leader/server.rs` (`is_interaction_request`) |

**PinkCode counterparts:** `src-tauri/src/acp.rs`, `agent_manager.rs`,
`permission_policy.rs`, `plan_approval.rs`, `ask_user_question.rs`,
`src/utils/sessionMode.ts`, `src/hooks/useAgentEvents.ts`.

---

## Non-goals

- Re-implement Grok agent loop or sampler inside PinkCode
- Full multi-client leader / cloud control plane
- Advertising capabilities we do not implement
- Treating permission "ask" (②) as SessionMode `ask` (①)
