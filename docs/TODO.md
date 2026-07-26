# PinkCode TODO

## ACP capabilities

- [ ] SessionMode `ask` — read-only Q&A mode via `session/set_mode({ modeId: "ask" })`
- [ ] `x.ai/session/usage` — live turn tokens and cost
- [ ] `x.ai/recap` / `x.ai/rewind/*` / compact — history management
- [ ] `x.ai/subagent/cancel` and subagent list
- [ ] `x.ai/task/list` / `x.ai/task/kill` — background-task control
- [ ] `x.ai/session_notification` — pending interaction, subagent, and interaction-resolved events
- [ ] `set_session_model` — change model during a session

## Git

- [ ] Real-time status — branch, upstream, ahead/behind, staged, and unstaged
- [ ] Inline file diff viewer
- [ ] Interactive hunk selection for commits

## Subagents and tasks

- [ ] Subagent hierarchy — parent/child relationships, depth, and fork budget
- [ ] Background-task status — TaskTool, WaitTasksTool, and KillTaskTool

## ACP client

- [ ] Replace blocking `mpsc` / `recv_timeout` client with an async channel-based gateway
- [ ] Replace raw `serde_json::Value` requests with a type-safe protocol layer

## Reliability

- [ ] Distinguish channel send failures from receive failures
- [ ] Reconnect when the ACP transport dies
- [ ] Add fallback paths for operations whose primary implementation fails

## Infrastructure

- [ ] Replace `eprintln!` with structured `tracing`
- [ ] Layered configuration — environment → global → project → session, with atomic writes
