# MarsBuild TODO

Product roadmap and backlog. Priorities lean on control-plane strengths (multi-task observability, policy gates, file-change radar) rather than re-implementing a full coding agent.

**Positioning**

| | MarsBuild | Reasonix (reference) |
|---|---|---|
| Role | Desktop **control plane** for Grok agents | DeepSeek-native **agent harness** |
| Engine | Attach / spawn external `grok` (ACP) | Owns the agent loop |
| Core value | Multi-task board · live stream · permissions · diff radar | Cache-first long sessions · cost · plugins |

Learn from Reasonix **UX and architecture habits**, not its DeepSeek runtime.

---

## Done (recent)

- [x] Live tab: Markdown render for agent / user / thought
- [x] Live tab: chronological order (terminal-style) + stick-to-bottom scroll
- [x] Top Week usage health bar (Grok billing API)
- [x] Week usage refresh: post-turn, adaptive poll, click-to-refresh

---

## P0 — Immediate UX lift (high ROI)

Inspired by Reasonix status footer, approval keyboard flow, and dense session chrome.

### Status & metrics

- [ ] **Global status footer / denser header**  
  Always-visible chips: managed count · pending permissions · week remaining · optional model.  
  Keep week usage bar; avoid burying critical state in tabs only.

- [ ] **Per-session context health bar**  
  Session list cards + detail header: used / window % (signals already on `SessionCard`).  
  Color thresholds similar to week bar (ok / mid / low / critical).

- [ ] **Live turn cost / token readout**  
  Surface ACP / `signals` usage when available (input / output / turns).  
  Prefer Grok on-disk + stream meta; no fake totals.

- [ ] **Week usage product breakdown**  
  Tooltip or popover: GrokBuild / Api / GrokChat / Imagine % (already in billing payload).

### Approvals & keyboard

- [ ] **Permission card keyboard flow**  
  `1–4` / ← → / Enter / Esc: Allow once · Allow session · Persist · Deny.  
  Default highlight = Allow once (Reasonix-style).

- [ ] **Approval axes as independent state** (UI + policy)  
  Separate: collaboration mode (normal / plan / goal) · work mode · tool approval (ask / auto / yolo).  
  Avoid one overloaded dropdown.

- [ ] **Command palette** (`Cmd/Ctrl+K`)  
  New task · Attach · Focus session · Switch policy · Jump to Live/Shell/Diff · Stop agent.

- [ ] **Session jump shortcuts**  
  `Cmd/Ctrl+1…9` focus N-th visible session; brief badge reveal while modifier held.

### Live / Shell polish

- [ ] **Shell / long tool output collapse**  
  Default fold large stdout; expand toggle (keyboard optional). Jump-to-latest when stuck mid-scroll.

- [ ] **Live “follow tail” indicator**  
  Chip when auto-scroll paused; click to resume (terminal UX).

---

## P1 — Control-plane product depth

### Structured agent work

- [ ] **Plan / Goal / Todo cards in Live**  
  Parse or map ACP plan/goal/todo updates into structured UI (not only markdown blobs).  
  Progress: current step · completed · blocked.

- [ ] **Subagent tree / sidebar**  
  Visualize spawn tree (explore / review / …) when Grok emits subagent events.  
  Status, tokens, cancel entry point.

### History, safety, recovery

- [ ] **Rewind / checkpoint timeline**  
  Jump to prior turn; show conversation vs code restore options where Grok supports it.  
  Pair with existing hunk radar.

- [ ] **Permission: Allow session / Persist rule**  
  Beyond one-shot approve: session grant + optional write to `~/.marsbuild/policies.json` path rules.

- [ ] **Policy vs sandbox clarity**  
  Document + UI: policy = allow/ask/deny; sandbox paths = hard boundary.  
  Align copy in Policy Center with that split.

### Diagnostics

- [ ] **Doctor / attach diagnostics panel**  
  Why spawn/attach failed: `grok` binary missing · auth · ACP handshake · policy.  
  One-click copy report (content-free where possible).

- [ ] **Capability health**  
  MCP / skills / project rules presence for selected cwd (when readable from Grok home / project).

---

## P2 — Multi-surface & remote

- [ ] **`marsbuild serve` (optional local HTTP)**  
  Same Rust agent manager; browser UI or API for status + batch approvals.  
  Default bind loopback; token/password if exposed.

- [ ] **Notification center**  
  Pending permissions · agent errors · turn complete · week usage critical.  
  OS notifications optional.

- [ ] **IM bridge (Telegram / Feishu / WeChat)**  
  Approve / deny / resume from phone; zero-or-low intrusion.  
  Evaluate after notification center.

- [ ] **Remote SSH workspace** (larger effort)  
  Agent runs on remote host; MarsBuild is the window.  
  Bootstrap, tunnel, known_hosts discipline — only if demand is clear.

---

## P3 — Nice-to-have / later

- [ ] Session title rename from UI
- [ ] Session list filters: project · model · has-pending · error
- [ ] Diff panel: file tree + hunk jump + “open in editor”
- [ ] Theme: light / dark / system; density compact / comfortable
- [ ] Customizable shortcuts sheet (`?`)
- [ ] Hooks: on-task-create inject project context (optional; don’t break Grok cache blindly)
- [ ] Memory file browser (read-only view of agent memory if present under session/project)
- [ ] Auto-update channel for release builds

---

## Explicit non-goals

Do **not** treat these as MarsBuild core work:

- [ ] Re-implement a DeepSeek/Grok **agent loop** inside MarsBuild
- [ ] Cache-first / append-only prompt engineering (belongs in `grok`)
- [ ] Full two-layer dynamic memory system (agent kernel)
- [ ] Competing as a general multi-provider coding agent (stay Grok control plane first)

---

## Architecture principles (keep)

1. **Single truth in Rust** — `AgentManager` + session index; UI is a shell.
2. **ACP-first live path** — disk/FS for history & radar; stream for live.
3. **Config & policy driven** — presets + per-project bindings; few hardcodes.
4. **Permissions = policy, paths = boundary** — don’t blur the two.
5. **Ship light** — Tauri app that assumes Grok installed; minimal new deps.

---

## Suggested next sprint

1. Global status density + session context bars  
2. Permission keyboard + Allow session  
3. Command palette (`Cmd/Ctrl+K`)  
4. Shell output collapse  

Then: Plan/Todo Live cards → Rewind timeline → serve / notifications.

---

## Reference

- Reasonix: https://reasonix.io/ · https://github.com/esengine/DeepSeek-Reasonix  
- Takeaways: status density · approval keyboard · independent mode axes · multi-entry same engine · doctor · remote SSH as long-horizon  
- MarsBuild stack: Tauri 2 · React · Rust · Grok home `~/.grok` · policies `~/.marsbuild`
