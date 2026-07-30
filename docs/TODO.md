# PinkCode TODO

## ACP capabilities

- [ ] ~~SessionMode `ask`~~ — **not a Grok TUI mode** (Ask = permission "prompt before tools"). Mode cycle is Normal / Plan / Auto / Always-approve.
- [x] `session/set_mode` for Plan (`plan` / `default`) — orthogonal to permission
- [x] `x.ai/session/usage` — nested `{ usage }` wire → flattened live tokens/cost
- [x] `x.ai/recap` — fire-and-forget request; body via `session_recap` timeline event
- [~] `x.ai/rewind/*` — DTO aligned; UI still thin (slash `/rewind` works)
- [x] compact — agent `/compact` slash
- [x] `x.ai/subagent/cancel` + `list_running` (ExtMethodResult envelope)
- [x] `x.ai/task/list` / `x.ai/task/kill` (ExtMethodResult envelope)
- [x] Attach/reconnect refill via `list_running` + `task/list` — owned by `useAgentEvents`
- [x] NeedsInput projection (permissions + `pending_interaction`) → `resolveCardState`
- [x] `session/set_model` — ACP standard method (not `x.ai/set_session_model`)

## Git

- [x] Real-time status — branch, upstream, ahead/behind, staged, and unstaged
- [x] Inline file diff viewer
- [x] Interactive **hunk** selection (`GitDiffHunkPanel` + `git apply --cached`)
