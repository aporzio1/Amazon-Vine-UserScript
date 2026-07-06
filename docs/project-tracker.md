# Project Tracker — Amazon Vine UserScript

## 1. Current State

Single-file vanilla-JS userscript (`amazon-vine-price-display.user.js`, ~2900 lines) for Tampermonkey / Violentmonkey / Greasemonkey / Safari Userscripts. No build step, no package manager, no tests — the `.user.js` file is the distributable; users auto-update via `@updateURL` / `@downloadURL` on `raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main`.

Current version: **v1.46.0**.

Capabilities today:
- Price badges + tiered color filter (green/yellow/red) on Vine grids, with per-tier hotkey toggles.
- Cross-origin product-page price fetch with 7-day ASIN cache, batched/debounced writes, 503-retry throttling.
- Settings modal (Saved Searches, Cloud Sync, Price Settings, Shortcuts) with drag-reorder, inline rename, focus trap.
- Cloud Sync via GitHub Gists (price cache + saved searches), timestamp-based conflict resolution.
- AI Review Generator on `/dp/*` and `/review/create-review*` (OpenAI JSON mode, auto-fills live Amazon review form).
- Keyboard shortcuts + infinite-scroll auto-advance.

See `CLAUDE.md` for architecture, subsystem map, and release workflow.

## 2. Shipped

- **2026-07-06 — v1.46.0** (`1813358`) — Full-script audit release. 11 bug fixes + hardening. See details below.
  - Fixes: paginated gist discovery via shared `findOrCreateGist` helper (kills duplicate-gist creation); sync timestamp convergence for saved searches + keywords; `.term` normalization in search sync; hotkeys guarded while settings modal open; reopenable AI review panel; mutation-observer double-process fix; infinite-scroll 503-retry teardown guard + chain-cap refund + duplicate-sentinel fix; focus trap skips hidden tabs; threshold migration refreshes in-memory state; guarded empty AI provider response.
  - Hardening: secrets set via `.value` not `innerHTML`; `DocumentFragment` appends; shared `wireConfirmButton` helper; `keypress`→`keydown`; provider config table; duplicate-keyword short-circuit.
- **2026-xx — v1.45.1** (`9ac23d7`) — Fix approx-price tiles never persisting seen status.
- **2026-xx — v1.45.0** (`e552496`, #4) — Reduce Amazon rate-limit risk + efficiency fixes.
- **2026-xx — v1.44.x** (`aca7169`, #5) — Fix Amazon 503 blocking by throttling concurrent product fetches.
- **2026-xx** (`0389629`) — Preserve variant metadata when persisting seen status.

## 3. In Progress

_None._

## 4. Backlog

P3 features deferred from the v1.46.0 audit (user wants these saved for later), roughly ordered:

1. **Pre-release/gray toggle chip** — add a gray chip to the color-filter toolbar. Filter engine already handles the gray class (~line 1749); UI just lacks the chip. Small.
2. **"Test connection" buttons** — for AI API keys + GitHub token in settings. One cheap API call + status banner each. Small.
3. **"Load more" affordance on stalled infinite scroll** — when infinite scroll hits `INFINITE_MAX_CHAIN` with all tiles hidden, the sentinel goes silent; surface a manual "load more" control. Small-medium.
4. **Restore natural order for sort "none"** — snapshot original DOM order before first sort so "none" can revert. Small-medium.
5. **Stats tab export/clear actions + label fix** — add export/clear; fix misleading `seenToday`/`seenThisWeek` labels (measure cache-write time, not seen time). Medium.
6. **Consolidate 3 sync gists into 1 multi-file gist** — one round-trip per sync; structurally eliminates gist-discovery problems. Bigger refactor. Medium-large.

## 5. Open Decisions

_None pending._

## 6. Known Issues / Tech Debt

- **Dark mode intentionally unsupported** (low) — modal surface is hardcoded white; `@media prefers-color-scheme: dark` broke button contrast in v1.41.0, reverted in v1.41.1. Match Amazon's light-only host. See `CLAUDE.md` gotchas.
- **Three separate sync gists** (med) — price cache + saved searches (+ keywords) each round-trip independently; root cause of prior duplicate-gist bugs. Consolidation tracked as Backlog #6.
- **Stats labels misleading** (low) — `seenToday`/`seenThisWeek` measure seen time, not cache-write time. Tracked as Backlog #5.

## 7. Plans & Specs

_No standalone plan/spec docs in the repo. `CLAUDE.md` is the canonical architecture reference._
