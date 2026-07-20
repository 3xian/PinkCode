# Usage Calculations

This document describes how MarsBuild computes and displays **usage** metrics: the weekly (or billing-period) credit battery, the 7-day token sparkline, and related UI formatting. It is a pure technical reference for the logic in the Rust backend and React frontend.

---

## Overview

MarsBuild exposes two independent usage surfaces in the left-rail status card:

| Surface | Source of truth | Meaning |
|--------|------------------|---------|
| **Week battery** | Grok billing API (`cli-chat-proxy`) | Remaining overall credit budget for the current billing period (typically weekly). |
| **7-day token chart** | Local session files under `~/.grok` (`updates.jsonl`) | Approximate tokens consumed per UTC day from completed agent turns. |

These numbers answer different questions and must not be mixed:

- The battery answers: *How much of my plan’s credit allowance is left before reset?*
- The sparkline answers: *How many tokens did local sessions burn day by day?*

---

## 1. Weekly / period credit usage (battery)

### 1.1 Data path

1. Frontend calls Tauri command `get_week_usage` (see `src/api.ts` → `getWeekUsage()`).
2. Backend implementation lives in `src-tauri/src/billing.rs` (`fetch_week_usage` / `fetch_week_usage_inner`).
3. Request:

   ```
   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
   Authorization: Bearer <session token>
   Accept: application/json
   User-Agent: marsbuild
   x-grok-client-mode: billing
   ```

4. The session token is read from `~/.grok/auth.json` (or `$GROK_HOME/auth.json`). The first non-empty `key` field under any top-level entry is used. If the file is missing or empty, the command still returns a `WeekUsage` object with `error` set (UI shows “n/a” / short hint).

5. HTTP client honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (and lowercase variants) so proxied networks work.

### 1.2 Response mapping

Relevant fields from the billing JSON (`config`):

| API field | Mapped to `WeekUsage` | Notes |
|-----------|----------------------|--------|
| `creditUsagePercent` | `usedPercent` | Overall credit **used** for the period (0–100+, may exceed 100). |
| derived | `remainingPercent` | See formula below. |
| `productUsage[]` | `productUsage` | Per-product slices (`product`, `usagePercent`). |
| product `GrokBuild` | `buildUsedPercent` / `buildRemainingPercent` | Optional product-level view. |
| `currentPeriod.type` | `periodType` | e.g. `USAGE_PERIOD_TYPE_WEEKLY`. |
| `currentPeriod.start` / `end` | `periodStart` / `periodEnd` | Fallback: `billingPeriodStart` / `billingPeriodEnd`. |
| (local) | `fetchedAt` | Unix-seconds string at fetch time. |
| (local) | `error` | Soft failure message when auth/network/parse fails. |

### 1.3 Remaining percent formula

```text
remaining(used) = clamp(100 − used, 0, 100)
```

Implemented as:

```rust
fn remaining(used: f64) -> f64 {
    (100.0 - used).clamp(0.0, 100.0)
}
```

Examples:

| `usedPercent` | `remainingPercent` |
|---------------|--------------------|
| 0 | 100 |
| 85 | 15 |
| 120 | 0 (clamped) |
| −5 | 100 (clamped) |

On hard fetch failure, the error payload uses `usedPercent = 0`, `remainingPercent = 100`, plus a non-null `error` string so the UI does not treat the defaults as real data.

### 1.4 Product-level Build metrics

If `productUsage` contains an entry whose `product` equals `GrokBuild` (case-insensitive):

```text
buildUsedPercent      = that entry’s usagePercent
buildRemainingPercent = remaining(buildUsedPercent)
```

These are **tooltip-only** extras. They are **not** used to drive the battery fill.

### 1.5 What the battery displays (frontend)

Component: `WeekUsageBar` in `src/components/StatsBar.tsx`.

**Displayed value = overall remaining**, not Grok Build product remaining:

```text
remaining = clamp(usage.remainingPercent, 0, 100)
```

Rationale (also documented in code comments): Grok Build product % is only one slice of the budget. Overall weekly credit can already be nearly exhausted while Build still shows a higher “left” percentage. Matching Grok’s “weekly limit left” requires the **overall** remaining figure.

**Liquid height** = same remaining percentage (fill from the bottom of the battery).

**Severity levels** (CSS class on the battery):

| Remaining | Level | Intent |
|-----------|-------|--------|
| > 50 | `ok` | Default purple |
| ≤ 50 and > 25 | `mid` | Deeper purple |
| ≤ 25 and > 10 | `low` | Magenta shift |
| ≤ 10 | `critical` | Red–magenta warning |

**Percent text formatting** (`fmtPct`):

```text
round to 1 decimal place; if integer, show without decimal
e.g. 12.34 → "12.3%",  50 → "50%",  NaN → "—"
```

**Period label** from `periodType`:

- contains `WEEKLY` / `week` → `"Week"`
- contains `MONTHLY` / `month` → `"Month"`
- contains `DAILY` / `day` → `"Day"`
- else → `"Period"`

**Reset countdown** uses `formatTimeUntil(periodEnd)` (`src/utils/format.ts`): accepts ISO timestamps or unix seconds/millis strings; shows relative remaining time (`2d 3h`, `4h 12m`, …) or `"resetting…"` when past end.

**Tooltip** (native `title`): period remaining, optional Build remaining, reset ETA, and “click to refresh”.

### 1.6 Refresh policy (frontend)

In `src/App.tsx`:

- Idle poll interval for week usage (faster while agents are live).
- Minimum gap between non-forced requests (`WEEK_USAGE_MIN_GAP_MS`).
- In-flight guard so concurrent refreshes do not stack.
- Clicking the battery forces a refresh (`force: true`).
- Live agent activity can schedule a debounced refresh after streams settle.

---

## 2. Trailing token usage series (sparkline)

### 2.1 Data path

1. Frontend calls `get_token_usage_series` with `days` (default **7**).
2. Backend: `sessions::token_usage_series` in `src-tauri/src/sessions.rs`.
3. Scans Grok session trees under the sessions root (typically `~/.grok/sessions/...`), reading each session’s `updates.jsonl`.

### 2.2 Window definition

```text
window_days = clamp(requested_days, 1, 31)
today_index = floor(unix_secs / 86400)          // UTC day index
start_index = today_index − (window_days − 1)   // inclusive window
start_secs  = start_index × 86400
```

The series always returns exactly `window_days` points, one per UTC calendar day from `start_index` through `today_index`, including days with zero activity.

Each point:

```text
TokenDayPoint {
  date:   "YYYY-MM-DD" (UTC),
  tokens: u64,
  turns:  u64
}
```

Totals:

```text
totalTokens = Σ tokens over all days in the window
totalTurns  = Σ turns  over all days in the window
```

### 2.3 Session pruning before scan

For each session directory, if `summary.json` has a last-activity timestamp older than `start_secs − 1 day` (i.e. last activity more than one full day before the window start), the session is skipped. This avoids opening large historical `updates.jsonl` files that cannot contribute to the window.

### 2.4 Which events count

From each `updates.jsonl` line:

1. Cheap pre-filter: line must contain both `"turn_completed"` and `"usage"`.
2. Full JSON parse; resolve update payload at `/params/update` or top-level `update`.
3. Require `sessionUpdate == "turn_completed"` and a present `usage` object.
4. Token amount = `turn_consumed_tokens(usage)` (see below). Skip if zero.
5. Timestamp: prefer `_meta.agentTimestampMs` (ms → seconds); other fallbacks exist. Drop turns with `ts < start_secs`.
6. Bucket by `day_index = ts / 86400`; accumulate tokens and turn count with saturating add.

### 2.5 Per-turn token formula

```text
input  = usage.inputTokens  | usage.input_tokens  | 0
output = usage.outputTokens | usage.output_tokens | 0
cached = usage.cachedReadTokens | usage.cached_read_tokens | 0

if input > 0 OR output > 0:
    tokens = (input − cached) + output     // saturating arithmetic
else:
    tokens = usage.totalTokens | usage.total_tokens | 0
```

**Intent:** count **fresh** spend only:

```text
fresh ≈ non-cached input + output
```

Re-sent or cache-hit context (`cachedReadTokens`) is subtracted from input so the chart tracks new token burn rather than full context window size every turn. When breakdown fields are absent, fall back to `totalTokens`.

### 2.6 Caching

Full-tree scans are expensive. Results are cached in-process for **45 seconds** (`TOKEN_SERIES_CACHE_TTL`), keyed by `window_days`. Cache is bypassed when TTL expires or the requested window size changes.

### 2.7 Frontend presentation

`TokenUsageChart` in `src/components/StatsBar.tsx`:

- Header value: `formatTokens(series.totalTokens)` (`1.2k`, `3.4M`, or raw).
- Sparkline: smooth cubic (Catmull-Rom → Bezier) over daily token values; y-scale is relative to the max day in the window (not absolute plan limits).
- Tooltip lists each day: date, tokens, turns; footer notes that cache hits are excluded.
- Meta row: first day, total turns, last day.

---

## 3. Context usage on session cards (related)

Not the status-card battery/chart, but related “usage” display on each task card:

```text
contextPct(used, total) = min(100, round((used / total) × 1000) / 10)
```

Shows as `{n}% ctx` with one decimal place when needed. Independent of billing and of the 7-day series; sourced from the session summary’s context window fields.

---

## 4. Type contracts (camelCase over IPC)

Rust structs use `#[serde(rename_all = "camelCase")]`. Frontend TypeScript types in `src/types.ts`:

**`WeekUsage`**

- `usedPercent`, `remainingPercent`
- `buildUsedPercent?`, `buildRemainingPercent?`
- `periodType`, `periodStart?`, `periodEnd?`
- `productUsage: { product, usagePercent }[]`
- `fetchedAt`, `error?`

**`TokenUsageSeries`**

- `days: { date, tokens, turns }[]`
- `totalTokens`, `totalTurns`, `windowDays`

---

## 5. Design rules (do not break)

1. **Battery fill = overall remaining**, never Build-only product remaining.
2. **Sparkline tokens = fresh input + output**, not raw `totalTokens` when breakdown exists.
3. **UTC day buckets** for the series; do not switch to local timezone without an explicit product decision.
4. **Soft errors** for billing: return a full `WeekUsage` with `error` set so the UI stays usable offline / without login.
5. Keep the two metrics visually paired but conceptually separate: credit budget vs. observed local token burn.

---

## 6. Key source files

| Concern | Path |
|---------|------|
| Billing fetch & remaining formula | `src-tauri/src/billing.rs` |
| Token series aggregation | `src-tauri/src/sessions.rs` (`token_usage_series*`, `turn_consumed_tokens`) |
| IPC commands | `src-tauri/src/lib.rs` (`get_week_usage`, `get_token_usage_series`) |
| Shared Rust models | `src-tauri/src/models.rs` |
| Frontend types | `src/types.ts` |
| Frontend API | `src/api.ts` |
| Battery + sparkline UI | `src/components/StatsBar.tsx` |
| Poll / refresh orchestration | `src/App.tsx` |
| Percent / time / token formatting | `src/utils/format.ts`, `fmtPct` in `StatsBar.tsx` |

---

## 7. Quick formulas cheat sheet

```text
# Billing battery
remainingPercent = clamp(100 − creditUsagePercent, 0, 100)
batteryFill%     = clamp(remainingPercent, 0, 100)   # UI only

# Per-turn local tokens
turnTokens = (inputTokens − cachedReadTokens) + outputTokens
           | totalTokens   # fallback

# Day bucket (UTC)
dayIndex = floor(unixSeconds / 86400)

# Context on a card
ctx% = min(100, round(used / window × 1000) / 10)
```
