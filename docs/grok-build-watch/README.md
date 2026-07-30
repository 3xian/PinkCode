# Grok Build Watch

Track `../grok-build` main vs PinkCode, and what we still need to absorb.

| File | Role |
|------|------|
| [STATUS.md](./STATUS.md) | Cursors, open queue, recent digests — **start here** |
| [entries/](./entries/) | One file per logged sync (full notes) |

## Pointers

- **`last_logged`** — newest upstream commit written under `entries/`.
- **`open`** — count of syncs not fully digested (`done` / `n/a` only). Work remains if `open > 0`.
- Per entry: `PinkCode` = `open` | `done · YYYY-MM-DD · one-liner`.

## Log a new sync

```powershell
cd ../grok-build   # sibling of this repo
git rev-parse HEAD   # should match STATUS last_logged
git fetch origin main
git log HEAD..origin/main --oneline
# empty → nothing to log

git log HEAD..origin/main --format=fuller
git diff --stat HEAD..origin/main
git show origin/main:crates/codegen/xai-grok-shell/Cargo.toml | Select-String '^version'

# then: write entries/YYYY-MM-DD-<shortsha>.md, update STATUS, pull
git pull origin main
```

Filename: `entries/YYYY-MM-DD-<7-char-sha>.md` (note date = day you write the entry).

### Entry template

```markdown
# YYYY-MM-DD — monorepo sync `<shortsha>`

| | |
|--|--|
| Noted | YYYY-MM-DD |
| Remote | `<full sha>` (commit date) |
| Prev HEAD | `<full sha>` |
| xai-grok-shell | `x.y.z` (bumped? yes/no) |
| Size | N commits · **X files** · **+A / -B** |
| PinkCode | open |

### Upstream changelog

1. …

### Notes

- …

### PinkCode impact

| Area | Notes | Status |
|------|-------|--------|
| … | … | open |

### Digested

- **When:**
- **What:**
- **Paths:**
```

## Digest

1. Default new rows to `open`; use `n/a` when PinkCode is unaffected.
2. After shipping: set entry `PinkCode` to `done · date · one-liner`, fill **Digested**, mark impact rows `done` / `n/a`.
3. Update STATUS: drop from **Open**, prepend **Recent** (trim to ~8).
4. Never delete `entries/`; only trim STATUS recent list.

## Agent prompts

**Log upstream:** Read STATUS → if local `../grok-build` is ahead of `last_logged`, add `entries/…`, update STATUS, pull.

**Digest:** Read STATUS **Open** → open entry → change PinkCode as needed → mark done and refresh STATUS.

**Health check:** STATUS only — act if `open > 0` or HEAD ≠ `last_logged`.
