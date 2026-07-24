# PinkCode TODO — Grok Build host parity

Protocol and control-plane backlog derived from a read-only audit of
[xai-org/grok-build](https://github.com/xai-org/grok-build) (`SOURCE_REV` pin when present).

**Product UX roadmap** (status footer, command palette, multi-surface, …) lives
in [PLAN.md](./PLAN.md). This file is the **ACP / reverse-RPC / capability**
checklist so we do not re-guess wire behavior.

**Positioning:** PinkCode is a desktop mission control for external `grok`
(ACP host). Do not re-implement the agent loop.

| Priority | Meaning |
|----------|---------|
| **Must** | Wrong or missing → stuck turns, silent loss of function, or unsafe Stop |
| **Should** | UX / TUI parity; safe to defer with clear fallbacks |
| **Ignore** | Leader / cloud / full TUI; do not implement unless we advertise the capability |

| Direction | Meaning |
|-----------|---------|
| **A→H** | Agent → Host reverse request (blocking) or notification |
| **H→A** | Host → Agent method |

---

## Three different "ask" (do not conflate)

| # | Name | What it is | Wire / surface | PinkCode |
|---|------|------------|----------------|-----------|
| **①** | **ACP SessionMode `ask`** | Agent session mode: Q&A-oriented, **read-only / no tool use** (`PromptMode::Ask`) | `session/set_mode({ modeId: "ask" })` | **Missing** — no Mode chip entry |
| **②** | **Permission ring "ask"** | Host gate: ask user before tools (Default) | Host `PermissionMode`; *not* `set_mode` | **Present** as Normal / default |
| **③** | **`ask_user_question` tool** | Multi-choice form reverse-RPC | `x.ai/ask_user_question` | **Present** |

Grok ACP session mode ids are only: `default` \| `plan` \| `ask`
(`xai-grok-tools` `types/session_mode.rs`).  
UI label *"Ask before tools (Grok default / ask)"* means **②**, not **①**.

---

## Must

### Permission optionId / kind matrix

- [ ] **FollowupMessage support** — allow user to reject but send follow-up message  
  via `meta.followup_message` on `RejectOnce` response. Agent classifies as `Followup`.

- [ ] **Cancelled decision** — distinguish user cancellation (Cmd+C / close dialog) from rejection.  
  `Decision::Cancelled` → `PermissionDecision::Cancelled` → `StopReason::Cancelled`.

### Plan state machine edge cases

- [ ] Approve / Request changes (`cancelled`+feedback) / Abandon; mid-turn
  `set_mode(plan)`; user leaves Plan via Mode chip → `set_mode(default)`.  
  Host must not force `set_mode(default)` on Approve.

---

## Should

### Session mode `ask` (①)

- [ ] **Mode chip + Shift+Tab: expose Ask**  
  Call `session/set_mode("ask")` on enter; `set_mode("default")` (or plan) on leave.  
  Do **not** implement Ask as "permission = default only".

- [ ] **`current_mode_update` for `modeId: "ask"`**  
  Show Ask on chip; do not only treat non-`plan` as "left plan".

- [ ] **Cycle order**  
  Confirm against Grok TUI (e.g. Normal → Ask → Plan → Auto → Always-approve, or
  TUI-equivalent). Document in `sessionMode.ts`.

### Initialize `clientCapabilities.meta`

- [ ] `x.ai/gitHeadChanged: true` — Workspace HEAD follow  

**Do not** advertise without implementing the reverse path:

- `x.ai/folderTrust.interactive` → requires `x.ai/folder_trust/request`  
- `x.ai/codeNavigation.enabled` → requires `x.ai/code/*`  
- Client hooks on `session/new` → requires `x.ai/hooks/run`  
- SDK MCP servers meta → requires `x.ai/mcp/sdk_call`  
- `terminal: true` → requires ACP terminal host methods  

### H→A methods

- [ ] **`x.ai/interject`** (or document "prompt only between turns")  
  Mid-turn user text; plan approve-with-comments follow-up.

- [ ] **`x.ai/queue/*`** (remove / reorder / clear / edit / interject) — queue UX  

- [ ] **`x.ai/session/usage`** — Live turn cost (or keep billing API only)  

- [ ] **`x.ai/recap` / `rewind/*` / compact** — history product (PLAN P1)  

- [ ] **`x.ai/subagent/cancel` + list** — subagent tree cancel  

- [ ] **`x.ai/task/list` / `kill`** — background tasks  

- [ ] **`x.ai/hunk-tracker/*`** — after advertising hunk capability  

### A→H notifications (listen / map)

- [ ] **`x.ai/session_notification`** — pending_interaction, subagent_*, interaction_resolved  
- [ ] **`x.ai/fs_notify` / git head** — after capability ads  
- [ ] **Structured `session/update` kinds** — goal_updated / turn_completed / session_recap (PLAN: Live cards)  
  Note: Plan mode state uses `SessionMode` (`handle_session_mode`), not a session update kind.
- [ ] **`prompt_complete` / running state** — prefer explicit signals over heuristics  

### Permission product

- [ ] Allow session / Persist rule (PLAN)  
- [ ] Keep: plan approval **never** auto-skipped under Always-approve  

### Shell

- [ ] Tool identity via `_meta/x.ai/tool` taxonomy + incremental bash chunks after meta ads  

---

## Ignore (unless product explicitly wants them)

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

| Topic | Path (under ref checkout) |
|-------|---------------------------|
| Session mode ids | `xai-grok-tools/src/types/session_mode.rs` |
| Plan tracker / PromptMode | `xai-grok-shell/src/session/plan_mode.rs` |
| `set_mode` handler | `…/acp_session_impl/session_mode.rs` |
| exit_plan wire | `…/exit_plan_mode/types.rs` |
| ask_user wire | `…/ask_user_question/types.rs` |
| Pending interactions | `…/session/pending_interaction.rs` |
| Interaction reverse set | `…/leader/server.rs` `is_interaction_request` |
| Client hooks reverse | `…/session/acp_session/hooks.rs` |
| Initialize meta (pager) | `xai-grok-pager/src/acp/mod.rs` `client_capabilities_meta` |
| Agent capabilities ads | `…/mvp_agent/acp_agent.rs` InitializeResponse |
| Cancel | `…/mvp_agent/acp_agent.rs` `cancel` |

PinkCode counterparts: `src-tauri/src/acp.rs`, `agent_manager.rs`,
`permission_policy.rs`, `plan_approval.rs`, `ask_user_question.rs`,
`src/utils/sessionMode.ts`, `src/hooks/useAgentEvents.ts`.

---

## Explicit non-goals (protocol)

- Re-implement Grok agent loop or sampler inside PinkCode  
- Full multi-client leader / cloud control plane  
- Advertising capabilities we do not implement  
- Treating permission "ask" (②) as SessionMode `ask` (①)  
