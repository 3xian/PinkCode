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

## Done (protocol / plan path)

- [x] ACP `session/set_mode` for real Plan (`modeId: "plan"`) — not `/plan` text alone
- [x] `x.ai/exit_plan_mode` wire: `{ outcome: "approved" \| "cancelled" \| "abandoned", feedback? }`
- [x] Approve path: host does **not** race with mid-approve `set_mode("default")`
- [x] `plan.md` session file: host auto-allow (FS write + write tools + shell materialization)
- [x] `x.ai/ask_user_question` wire: answers map + tagged `outcome` (accept / cancel / chat / skip)
- [x] Blocking reverse-RPC trio + FS: `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`
- [x] `session/update` + `_x.ai/session/update` → Live; shell heuristic; `current_mode_update` for Plan chip
- [x] Host Mode ring: Normal → Plan → Auto → Always-approve (Plan orthogonal to permission prefs)

---

## Three different “ask” (do not conflate)

| # | Name | What it is | Wire / surface | PinkCode |
|---|------|------------|----------------|-----------|
| **①** | **ACP SessionMode `ask`** | Agent session mode: Q&A-oriented, **read-only / no tool use** (`PromptMode::Ask`) | `session/set_mode({ modeId: "ask" })` | **Missing** — no Mode chip entry |
| **②** | **Permission ring “ask”** | Host gate: ask user before tools (Default) | Host `PermissionMode`; *not* `set_mode` | **Present** as Normal / default |
| **③** | **`ask_user_question` tool** | Multi-choice form reverse-RPC | `x.ai/ask_user_question` | **Present** |

Grok ACP session mode ids are only: `default` \| `plan` \| `ask`
(`xai-grok-tools` `types/session_mode.rs`).  
UI label *“Ask before tools (Grok default / ask)”* means **②**, not **①**.

---

## Must

### H→A

- [x] **`session/cancel` for Stop**  
  `AcpClient::session_cancel` sends cancellation notification before `kill()`,  
  allowing the agent to flush state cleanly.

### A→H — keep correct (regress; do not regress)

- [x] `session/request_permission` → `{ outcome: { outcome: "selected", optionId } }`
- [x] `x.ai/exit_plan_mode` / `x.ai/ask_user_question` / `fs/*` as above

### A→H — still verify

- [ ] **Permission optionId / kind matrix**  
  Align `allow_once` / `allow_always` / `reject_*` / follow-up options with agent
  classification (Allow / Deny / Cancelled / Followup).  
  Host Auto / AcceptEdits / Bypass risk heuristics vs Grok risk tables.  
  Anchor: shell tool permission paths + leader `is_interaction_request`.

- [ ] **Plan state machine edge cases** (after core wire fix)  
  Approve / Request changes (`cancelled`+feedback) / Abandon; mid-turn
  `set_mode(plan)`; user leaves Plan via Mode chip → `set_mode(default)`.  
  Host must not force `set_mode(default)` on Approve.

---

## Should

### Session mode `ask` (①)

- [ ] **Mode chip + Shift+Tab: expose Ask**  
  Call `session/set_mode("ask")` on enter; `set_mode("default")` (or plan) on leave.  
  Do **not** implement Ask as “permission = default only”.

- [ ] **`current_mode_update` for `modeId: "ask"`**  
  Show Ask on chip; do not only treat non-`plan` as “left plan”.

- [ ] **Cycle order**  
  Confirm against Grok TUI (e.g. Normal → Ask → Plan → Auto → Always-approve, or
  TUI-equivalent). Document in `sessionMode.ts`.

### Initialize `clientCapabilities.meta`

PinkCode today: `fs` read/write true, `terminal: false`, **no** x.ai meta.

Pager advertises (see pager `client_capabilities_meta`):

- [x] `x.ai/incrementalBashOutput: true` — better Shell streaming  
- [x] `x.ai/bashOutputNoColor: true` — cleaner Live output  
- [x] `x.ai/hunkTracker: { mode }` — Diff / hunk productization  
- [ ] `x.ai/gitHeadChanged: true` — Workspace HEAD follow  

**Do not** advertise without implementing the reverse path:

- `x.ai/folderTrust.interactive` → requires `x.ai/folder_trust/request`  
- `x.ai/codeNavigation.enabled` → requires `x.ai/code/*`  
- Client hooks on `session/new` → requires `x.ai/hooks/run`  
- SDK MCP servers meta → requires `x.ai/mcp/sdk_call`  
- `terminal: true` → requires ACP terminal host methods  

### H→A methods

- [ ] **`x.ai/interject`** (or document “prompt only between turns”)  
  Mid-turn user text; plan approve-with-comments follow-up.

- [ ] **`x.ai/queue/*`** (remove / reorder / clear / edit / interject) — queue UX  

- [ ] **`x.ai/session/usage`** — Live turn cost (or keep billing API only)  

- [ ] **`x.ai/recap` / `rewind/*` / compact** — history product (PLAN P1)  

- [ ] **`x.ai/subagent/cancel` + list** — subagent tree cancel  

- [ ] **`x.ai/task/list` / `kill`** — background tasks  

- [ ] **`x.ai/hunk-tracker/*`** — after advertising hunk capability  

### A→H notifications (listen / map)

- [ ] **`x.ai/yolo_mode_changed`** — sync Mode chip with agent yolo/auto  
- [ ] **`x.ai/session_notification`** — pending_interaction, subagent_*, interaction_resolved  
- [ ] **`x.ai/fs_notify` / git head** — after capability ads  
- [ ] **Structured `session/update` kinds** — plan / todo / goal / turn_completed / recap (PLAN: Live cards)  
- [ ] **`prompt_complete` / running state** — prefer explicit signals over heuristics  

### Permission product

- [ ] Allow session / Persist rule (PLAN)  
- [ ] Bypass ≡ always-approve (bash included?) — document + tests  
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

## Blocking reverse-RPC inventory (source of truth)

Shared interactive modals (leader `is_interaction_request` / `pending_interaction`):

| Method | Priority | Status |
|--------|----------|--------|
| `session/request_permission` | Must | Done — verify option matrix |
| `x.ai/ask_user_question` | Must | Done |
| `x.ai/exit_plan_mode` | Must | Done |
| `fs/read_text_file` | Must (fs advertised) | Done |
| `fs/write_text_file` | Must (fs advertised) | Done + plan.md gate |
| `x.ai/hooks/run` | Ignore unless hooks registered | Reject → agent fail-open |
| `x.ai/folder_trust/request` | Ignore unless capability | Not sent if not advertised |
| `x.ai/mcp/sdk_call` | Ignore unless SDK MCP | Same |

---

## Recommended implementation order

1. **`session/cancel`** (Stop without kill)  
2. **Permission optionId / kind matrix** tests against Grok wire  
3. **Initialize meta:** `incrementalBashOutput` + `bashOutputNoColor` (optional hunk/git)  
4. **SessionMode `ask`** on Mode chip + `current_mode_update`  
5. **`x.ai/yolo_mode_changed`** ↔ Mode chip  
6. **`x.ai/interject`** (or document queue limits)  
7. **Structured session/update → Live** (plan/todo/subagent) — pairs with PLAN P1  
8. Document unknown reverse-RPC policy (`-32601` + fail-open) in code comments / this file  

Then return to [PLAN.md](./PLAN.md) product sprint (status density, keyboard approvals, palette).

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
- Treating permission “ask” (②) as SessionMode `ask` (①)  
