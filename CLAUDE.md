# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Shape

Single-file vanilla-JS userscript (`amazon-vine-price-display.user.js`, ~3150 lines) that runs inside Tampermonkey / Violentmonkey / Greasemonkey / Safari Userscripts. There is **no build step, no package manager, no test suite, and no lint runner** — the `.user.js` file IS the distributable. Edits are made directly to it and users pick up changes via the `@updateURL` / `@downloadURL` pointing at `raw.githubusercontent.com/aporzio1/Amazon-Vine-UserScript/main/…`.

## Release Workflow (MANDATORY)

Every code change MUST also:

1. Bump `// @version` in the userscript header (top of `amazon-vine-price-display.user.js`).
2. Add a matching entry at the top of `CHANGES.md` using the existing `## Version X.Y.Z - Short Title` format with `**Feature**`, `**Enhancement**`, `**Fix**`, `**Security**`, `**UX**`, or `**Performance**` labeled bullets.
3. Commit version bump + changelog in the same commit as the code change.

Users auto-update based on the `@version` line — forgetting to bump it means nobody gets the fix.

## Runtime & Page Matches

The script is injected by `@match` directives into:

- `https://vine.amazon.com/*` and `https://www.amazon.com/vine/*` — full feature set (price badges, color filter, settings, hotkeys, cloud sync).
- `https://www.amazon.com/dp/*` — AI Review Generator panel only.
- `https://www.amazon.com/review/create-review*` — AI Review Generator with **auto-fill into the live Amazon review form** (title + body textareas).

`init()` (bottom of file) branches on `isVinePage` to decide which subsystems to boot. `createReviewGeneratorUI()` and `setupKeyboardNavigation()` run on every matched page.

## Architectural Subsystems (all inside one IIFE)

| Subsystem | Key functions | Notes |
|---|---|---|
| **Storage abstraction** | `getStorage`, `setStorage` | GM_setValue/GM_getValue first, `localStorage` fallback with `vine_price_display_` prefix. Every persistence read/write MUST go through these — never touch `localStorage` or `GM_*` directly. |
| **Price cache** | `getCache`, `setCache`, `cleanupExpiredCache`, `enforceCacheSizeLimit`, `flushCacheUpdates`, `setCachedPrice` | Keyed by ASIN. 7-day TTL (`CACHE_DURATION`), hard cap `MAX_CACHE_SIZE = 50000`. Writes are batched/debounced via `flushCacheUpdates`. |
| **Price fetching** | `fetchPrice`, `extractPriceFromHTML`, `extractASIN`, `isValidAmazonURL` | Uses `GM_xmlhttpRequest` to GET the product page HTML, then runs `CONFIG.PRICE_SELECTORS` against it. Exponential backoff via `MAX_RETRIES` / `RETRY_BASE_DELAY`. |
| **Item processing** | `processVineItem`, `processBatch`, `processVineItems`, `observePageChanges`, `checkAndAutoAdvance` | `MutationObserver` (debounced by `MUTATION_DEBOUNCE = 50ms`) detects new cards as the SPA loads. When "Hide Cached" + "Auto-Advance" are both on, `checkAndAutoAdvance` navigates to the next page once all visible cards are hidden. |
| **Color filter UI** | `createColorFilterUI`, `applyColorFilter`, `applyColorFilterToAllItems`, `getPriceColorSync`, `createPriceBadge` | Injected into the Vine search toolbar. Thresholds live in `CONFIG.DEFAULT_THRESHOLDS` (GREEN ≥ 90, YELLOW ≥ 50, RED ≤ 49.99) and are user-overridable. |
| **Settings UI** | `createSettingsUI`, `findHeaderContainer`, `addSettingsLink`, `createFloatingButton`, `switchTab`, `renderSearches` | Injects a "Vine Tools" link into Amazon's header; falls back to a bottom-right FAB on mobile / when header isn't found. Modal has tabs: **Searches**, **Price Settings**, **Cloud Sync**. Last active tab is persisted to `LAST_ACTIVE_TAB_KEY`. |
| **AI Review Generator** | `generateReview`, `createReviewGeneratorUI` | Calls OpenAI `gpt-3.5-turbo` via `GM_xmlhttpRequest`. System prompt enforces Vine Voice guidelines + strict title format (short phrase, < 10 words, < 60 chars, no `Title:` prefix, no quotes). On `/review/create-review*` pages, fills the React-controlled title input and body textarea using **native value setters** (`Object.getOwnPropertyDescriptor(...).set.call(el, value)` then `input` event) — do NOT replace with plain `el.value =` assignments, React's synthetic event system will drop them. |
| **Cloud Sync (GitHub Gists)** | `syncWithGitHub`, `syncSearchesWithGitHub` | Two separate private gists: `vine_price_cache.json` and `vine_saved_searches.json`. Gist IDs cached in `GIST_ID_KEY` / `GIST_SEARCHES_ID_KEY`. Saved searches use **timestamp-based conflict resolution** (`SAVED_SEARCHES_TIMESTAMP_KEY`). Auto-syncs 2s after `init()` if a token is saved. |
| **Keyboard shortcuts** | `setupKeyboardNavigation` | `V V` within 500ms opens the modal; `1–6` toggle filters; `←/→` paginate; `Esc` closes modals. Disabled while focus is in an input/textarea. |

## Config & Storage Keys

All persisted keys are centralized in the `CONFIG` object (lines ~31–71). When adding a new persisted value, **add the key to `CONFIG` first** — there are several subsystems (migration, clear-cache, cloud-sync) that iterate these keys. Do not inline string key names elsewhere.

`CONFIG.AMAZON_DOMAINS` and `CONFIG.PRICE_SELECTORS` are the two places to extend when Amazon changes markup or a new regional TLD needs support.

## Known Gotchas

- **Bulk-API-style batching**: Cache writes are coalesced in `flushCacheUpdates`. If you change cache mutation code, ensure the flush still fires — a missed flush means the next page load loses the data.
- **Price regex**: Must require at least one digit after the decimal (don't match bare `"19."`). Regression hit in v1.40.1.
- **XSS surface**: User-entered saved-search names are rendered into the settings modal — always route through `escapeHtml`. (v1.40.1 fix.)
- **React review form**: See AI Review Generator row above. The fallback path for non-React textareas also needs to stay in place for older Amazon layouts (v1.40.5).
- **`CampaignWithCampaignMembers` / other Amazon-specific quirks do not apply here** — this is a browser userscript, not a Salesforce project.
- **Not sandboxed from Amazon's CSP**: We rely on `@inject-into content` and `@run-at document-idle`. Don't use `eval` or inject inline `<script>` tags.

## Lint / Docs Conventions

- `.markdownlint.json` is present; keep Markdown files lint-clean.
- README features list and keyboard-shortcut table are user-facing — update them when behavior changes, not just `CHANGES.md`.
