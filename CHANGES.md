# Amazon Vine Price Display - Change Log

## Version 1.50.1 - Cache Items Without Prices

- **Fix**: Items for which Amazon returns no reliable price now remain marked as seen for the full seven-day cache lifetime. The script still retries price detection after 12 hours without making the tile look new again.
- **Fix**: Cached no-price items now participate in **Hide Seen** and retain their seen state if a later retry finds a price.
- **Enhancement**: Added a visible cached **Price unavailable** badge plus safe product metadata, JSON-LD, and alternate-buybox extraction fallbacks.

## Version 1.50.0 - Secure Google Login for Cloud Sync

- **Feature**: Replaced manually copied GitHub personal access tokens and private Gists with Google login backed by Supabase Auth. Each browser keeps its own refreshable session and can be disconnected from Vine Tools.
- **Security**: Sign-in uses authorization-code flow with PKCE, a random per-attempt state value, exact-origin `postMessage` validation, and a callback page with a restrictive Content Security Policy. Amazon sessions and AI provider keys are explicitly excluded from sync.
- **Security**: Added a Supabase migration that enables Row Level Security for every sync document. Authenticated users can only select, create, or update their own rows; the publishable client key cannot bypass these policies.
- **Fix**: Cloud writes now use revision-checked optimistic concurrency and retry conflicts instead of allowing two devices to silently overwrite the same document.
- **Enhancement**: Price cache, saved searches, and keyword lists share one account-based sync operation with automatic session refresh, a connected-account display, and a per-device Disconnect action.
- **Migration**: Added a one-time GitHub Gist importer in the Cloud Sync tab. It understands the previous cache, saved-search, and keyword formats, losslessly merges them with local and Supabase data, removes locally stored GitHub credentials after success, and leaves the original Gists untouched for rollback.
- **Infrastructure**: Added and deployed the no-secret OAuth return page at `https://amazon-vine-sync-auth.pages.dev/`, plus `docs/supabase-sync-setup.md` for the remaining project and Google-provider configuration.

## Version 1.47.1 - TEMPORARY Diagnostic Build (badges/hide-style disabled)

- **Diagnostic (temporary)**: v1.47.0 (MutationObserver removed) still 403'd on the real "Request product" click, falsifying the observer theory. This build disables badge-node injection (`item.appendChild(badge)`) and all `applyColorFilter` DOM effects (hide/style/class toggles) entirely — price detection, caching, and all UI panels/sync/keyboard nav/infinite scroll stay on. Isolates whether writing badge nodes / hide-style onto Amazon's tile elements at init time is the real trigger. Not a release; will be reverted (or made permanent if this is confirmed as the cause and no cleaner fix is found).

## Version 1.47.0 - Fix Item-Request 403 by Removing the Whole-Page MutationObserver

- **Fix (major)**: Clicking "Request product" was throwing a 403 from Amazon's own order-request API while the script was active. A multi-day bisection (v1.46.2–v1.46.19, all temporary diagnostic builds, now reverted) traced it to the whole-body `MutationObserver` added for reactive tile detection: its relevance filter matches `data-recommendation-id`, which is also present on the tile clone Amazon's own order popover creates — so the observer's callback fired reactively at the exact moment "Request product" was clicked, and something about running our JS in that window broke Amazon's own request handling.
- **Removed**: The `MutationObserver` on `document.body` (`observePageChanges`) is gone entirely rather than further narrowed, to stop the breakage immediately. **Cost**: tiles Amazon adds to the page other than through our own infinite-scroll fetch no longer get badges/color-filter automatically — a manual reload picks them up. Infinite scroll itself is unaffected: `loadNextPageInline` now calls `processVineItems` directly on the tiles it appends, instead of relying on the observer to notice them.
- Removed the now-unused `isReordering` guard (existed only to stop the observer from reacting to our own sort-driven `appendChild` calls) and the `MUTATION_DEBOUNCE` config constant.

## Version 1.46.19 - TEMPORARY Diagnostic Build (bisection A9)

- **Diagnostic (temporary)**: A5-retest (v1.46.18) still 403'd against the real "Request product" click, with the mutation-inspection logic (querySelector/classList checks on added nodes) intact but `processVineItems` skipped — narrows the trigger to the `MutationObserver` itself. This build makes the observer's callback truly empty (returns immediately, no mutation inspection at all) to isolate whether merely having a `MutationObserver` attached to `document.body` subtree is enough, independent of what its callback does. Not a release; will be reverted.

## Version 1.46.18 - TEMPORARY Diagnostic Build (bisection A5, re-test)

- **Diagnostic (temporary)**: Do-nothing control (v1.46.17) came back clean against the actual "Request product" click, confirming this is script-caused. Re-running Build A5 (MutationObserver attached and watching, reactive `processVineItems` call skipped entirely) specifically against that click — the original A5 clean read was never verified against this exact action. Not a release; will be reverted.

## Version 1.46.17 - TEMPORARY Diagnostic Build (do-nothing control, re-test #3)

- **Diagnostic (temporary)**: New info — the 403 fires specifically on clicking "Request product" in the order popover, not from opening the modal or browsing. None of the prior "clean" builds (including the original do-nothing controls, v1.46.2/v1.46.7) were confirmed to have actually exercised this exact click. `init()` returns immediately, script does nothing at all — re-verifying the true baseline against the real repro step (click "Request product") before trusting any further bisection layers. If the 403 fires even here, it is not a script-caused bug at all. Not a release; will be reverted.

## Version 1.46.16 - TEMPORARY Diagnostic Build (bisection A8)

- **Diagnostic (temporary)**: A7 (v1.46.15) still 403'd, ruling out outbound fetches (`fetchPrice`/`fetchParentPrices`) as the sole trigger. Every `item.dataset.vine*` write inside `processBatch` is now gated behind `isInitialLoad`, so the reactive (mutation-triggered) path is fully read-only — queries, cache lookups, `getHideCached`/`getColorFilter` callbacks, `checkAndAutoAdvance`, and `scheduleSortRefresh` still run, but nothing is written to any Amazon tile DOM node. Isolates whether writing `data-vine-*` attributes onto Amazon's live tile elements reactively is the trigger, vs. the remaining read-only machinery. Not a release; will be reverted.

## Version 1.46.15 - TEMPORARY Diagnostic Build (bisection A7)

- **Diagnostic (temporary)**: A6 (v1.46.14) still 403'd — the `style.position` write is ruled out. Fable's review found the reactive `processVineItems(false)` call only does real work on genuinely unprocessed tiles, and the `MutationObserver`'s own relevance filter matches Amazon's order-popover clone (`data-recommendation-id`) — so the reactive run is guaranteed to fire right as the order popover opens. Leading suspect: outbound fetches (`fetchPrice` / `fetchParentPrices`, which calls Amazon's own internal `/vine/api/recommendations/` endpoint) firing reactively at that exact moment, colliding with Amazon's in-flight request for the same `recId`. This build skips the entire uncached-item fetch loop when triggered reactively; dataset writes and cache reads still run reactively as before. Not a release; will be reverted.

## Version 1.46.14 - TEMPORARY Diagnostic Build (bisection A6)

- **Diagnostic (temporary)**: A5 (v1.46.13) confirmed the reactive `processVineItems(false)` call (triggered by the whole-body `MutationObserver`) is the 403 trigger. Correction to the bisection: a module-level `TEST` object (line 34, left over from Build C) has been unconditionally suppressing badge-node injection and color-filter/hide logic in every build since v1.46.5 — those paths were never actually re-tested in B2/A2/A3/A4/A5, so "badges/hide-style ruled out" did not hold. The one live, untested candidate still running unconditionally in `processBatch` was `item.style.position = 'relative'`. This build re-enables the reactive call but skips that style write specifically when triggered reactively (it already ran safely at init in prior builds). Not a release; will be reverted.

## Version 1.46.13 - TEMPORARY Diagnostic Build (bisection A5)

- **Diagnostic (temporary)**: A4 (v1.46.12) confirmed the whole-body `MutationObserver` is the 403 trigger. This build keeps the observer attached and watching `document.body` subtree, but its reactive `processVineItems(false)` callback is now a no-op (logs only). Isolates whether the mere act of observing is enough, or whether it's specifically the reactive re-processing call — noting that direct `processVineItems(true)` at init was already cleared in Build B2. Not a release; will be reverted.

## Version 1.46.12 - TEMPORARY Diagnostic Build (bisection A4)

- **Diagnostic (temporary)**: A3 (v1.46.11) passed clean, ruling out GitHub auto-sync + keydown hook. This build isolates the remaining pair: whole-body `MutationObserver` (`observePageChanges`) stays ON, infinite scroll (`setupInfiniteScroll`) is OFF. Not a release; will be reverted.

## Version 1.46.11 - TEMPORARY Diagnostic Build (bisection A3)

- **Diagnostic (temporary)**: A2 (v1.46.10) confirmed the active half is the 403 trigger under the clean-session protocol. This splits the active half in two: whole-body `MutationObserver` (`observePageChanges`) + infinite scroll are disabled; GitHub auto-sync + the window keydown hook stay on. Isolates whether repeated tile reprocessing/network activity (observer+scroll) or the low-DOM-touch pair (sync+keydown) is the trigger. Not a release; will be reverted.

## Version 1.46.10 - TEMPORARY Diagnostic Build (bisection A2)

- **Diagnostic (temporary)**: Clean retest of B2 (v1.46.9) showed no 403 with badges/dataset writes/hide-style + UI panels all on, active half still off. This re-enables the active half (whole-body MutationObserver, infinite scroll, window keydown hook, GitHub auto-sync) — the only piece left off — everything else stays on. Confirms whether the active half is the trigger, tested under the clean-session protocol. Not a release; will be reverted.

## Version 1.46.9 - TEMPORARY Diagnostic Build (bisection B2)

- **Diagnostic (temporary)**: Clean retest of Build B (v1.46.8, fresh session) showed no 403 with active half off + price badges off + UI panels on. This build keeps the active half off but re-enables `processVineItems` in full (badges, dataset writes, hide/style logic all restored) to test whether touching Amazon's tiles at all reproduces the 403, under the same clean-session protocol. Not a release; will be reverted.

## Version 1.46.8 - TEMPORARY Diagnostic Build (re-test bisection B)

- **Diagnostic (temporary)**: Re-run of Build B (active half off, price badges off, UI panels on) with a fresh session/cooldown before this test. Prior A–D bisection reads may have been contaminated by a sticky Amazon WAF flag persisting across build swaps rather than reflecting each build's own behavior — a clean B retest settles whether the trigger is in the standalone UI panels (`createColorFilterUI`'s grid-insertion fallback is the leading suspect) or whether the earlier bisection chain needs to restart from Build A. Not a release; will be reverted.

## Version 1.46.7 - TEMPORARY Diagnostic Build (re-test do-nothing control)

- **Diagnostic (temporary)**: Re-run of the v1.46.2 do-nothing control — `init()` returns immediately, script performs no work at all. D (dataset-writes-only) still showed the item-request 403, so re-confirming the baseline control before concluding the trigger is outside the script entirely. Not a release; will be reverted.

## Version 1.46.6 - TEMPORARY Diagnostic Build (bisection D)

- **Diagnostic (temporary)**: Only `data-vine-*` attribute writes run on Amazon's tiles; badge-node injection and the color-filter/hide logic (`display:none`, class toggles) are both skipped. Isolates whether the attribute writes vs. the hide/style changes trigger the item-request 403. Not a release; will be reverted.

## Version 1.46.5 - TEMPORARY Diagnostic Build (bisection C)

- **Diagnostic (temporary)**: Badges re-enabled, but the badge NODE injection into Amazon's tiles (`appendChild` + external links) is skipped; only `data-vine-*` writes and the color-filter/hide logic run. Isolates whether appending a child node to Amazon's tile (vs. attribute/style changes) triggers the item-request 403. Not a release; will be reverted.

## Version 1.46.4 - TEMPORARY Diagnostic Build (bisection B)

- **Diagnostic (temporary)**: Active half stays off (ruled out in A); price badges (`processVineItems`) now also disabled; UI panels kept. Isolates whether injecting badges into Amazon's tiles triggers the item-request 403. Not a release; will be reverted.

## Version 1.46.3 - TEMPORARY Diagnostic Build (bisection A)

- **Diagnostic (temporary)**: Passive display half (price badges, settings/filter/review UI) runs; active half (whole-body MutationObserver, infinite scroll, window keyboard hook, GitHub auto-sync) is disabled. Isolates which half of `init()` triggers the item-request 403. Not a release; will be reverted.

## Version 1.46.2 - TEMPORARY Diagnostic Build (do-nothing)

- **Diagnostic (temporary)**: `init()` returns immediately, so the script loads but performs no work — no price fetching, badges, UI, observers, or key handlers. This is an isolation test for an item-request 403 (Amazon anti-bot block) that occurs while the script is enabled; it is not a release and will be reverted once the trigger is identified.

## Version 1.46.1 - Scope Tile Lookups to the Items Grid

- **Hardening**: Tile lookups (`findVineItems`, `processVineItems`) are now scoped to the items grid instead of the whole document, so tiles Amazon clones into overlays/popovers (appended to `<body>`) are never picked up and processed. Falls back to a document-wide query on Vine layouts that have no grid. (Note: this was initially believed to fix an item-request failure; it does not — that bug is a 403 on Amazon's order API and remains under investigation.)

## Version 1.46.0 - Full-Script Audit: Sync, Infinite Scroll, Modal & AI Panel Fixes

- **Fix**: Cloud sync could silently create a **duplicate private gist** for users with more than ~30 gists — the gist lookup only read the first API page, so the existing sync gist was never found on a new device. All three sync paths (price cache, saved searches, keywords) now share one paginated find-or-create helper.
- **Fix**: Saved-search and keyword sync no longer diverge timestamps after a merge. Both sides now land on the same timestamp, so the next sync is a no-op instead of endlessly re-pulling/re-pushing.
- **Fix**: Saved-search sync no longer throws on malformed/legacy entries missing a `term` — entries are normalized defensively before merging (matching the keyword-sync behavior).
- **Fix**: Filter hotkeys (1/4/5/6) and arrow-key pagination no longer fire against the page while the Vine Tools modal is open with focus on a button or tab.
- **Fix**: The AI Review Generator panel can be reopened after closing — the close button (and Escape) now leaves a "🤖 AI Review Generator" button in its place. Previously a closed panel was gone until a full page reload.
- **Fix**: Mutation-observer debounce could double-run item processing when two DOM batches landed in the same animation frame; both pending stages are now cancelled before rescheduling.
- **Fix**: Infinite scroll's 503 retry no longer re-appends pages after the feature has been disabled, no longer burns a slot in the no-scroll chain cap on a failed attempt, and re-enabling infinite scroll after "End of results" no longer leaves a duplicate sentinel.
- **Fix**: The settings modal's focus trap skips controls inside hidden tabs, so Tab/Shift-Tab no longer lands on invisible elements.
- **Fix**: Threshold format migration in the settings modal now refreshes the in-memory thresholds immediately instead of waiting for a Save.
- **Fix**: An empty AI-provider response now surfaces a clear "returned no review content" error instead of an unhelpful TypeError.
- **Security**: API keys and the GitHub token are no longer interpolated into the settings modal's `innerHTML` — they're assigned as DOM properties after the markup is built, so a corrupted stored value can't break out of an attribute.
- **Performance**: Infinite-scroll tiles are appended via a single `DocumentFragment` (one layout pass instead of one per tile).
- **Performance**: Adding a duplicate keyword now shows a notice and skips the full grid re-filter + background gist sync it used to trigger.
- **Enhancement**: Extracted a shared two-step confirm helper for the delete-search and clear-cache buttons; replaced deprecated `keypress` handlers with `keydown`; provider API-key/model lookups now use a config table instead of nested ternaries.

## Version 1.45.1 - Fix Approx-Price Tiles Never Marking Seen

- **Fix**: Multi-variant tiles that get a `~$` approximate price (Amazon substituted a different variant on fetch) never persisted their "seen" status, so "Hide Seen" could never dismiss them — they reappeared on every reload even after being shown. The tile's price is still always refetched fresh (an unreliable price is never served from cache), but its seen/dismissed state now carries over across reloads like any other item.

## Version 1.43.0 - Multi-Variant Price Fix, Keywords, Sort, Infinite Scroll & More

- **Fix (major)**: Multi-variation listings no longer show the wrong price. A parent-ASIN tile (e.g. a $16.99 accessory merged into a $299.99 listing) used to display the default child's buybox price. The script now reads `data-is-parent-asin` / `data-recommendation-id` from the tile, asks the Vine recommendations API which variations are actually offered, and shows their exact ETV when the API reports it — or a price range probed from the offered children's pages otherwise. Ranges display as `$a–$b` with a 🔀 indicator and are color-coded by the lowest price.
- **Fix**: Price extraction is now scoped to the buybox (`#corePriceDisplay…`, `#apex_desktop`, etc.), excludes strikethrough list prices, and drops the `.a-price-whole` selectors that silently truncated cents and matched carousel prices.
- **Fix**: The fetched page's ASIN is verified against the requested one; mismatches (Amazon substituting a different variant) render as `~$x` and are never cached. Parent entries cached before this release are treated as stale and refetched, so previously poisoned prices self-heal.
- **Fix**: Pages that load fine but have no price (pre-release items) are no longer retried 3 extra times.
- **Feature**: Keyword lists (new "Keywords" tab) — highlight keywords outline matching tiles in orange; block keywords hide them. Synced to a private Gist like saved searches.
- **Feature**: Sort by price — a filter-bar button cycles Off / $↑ / $↓ and keeps the page sorted as prices arrive.
- **Feature**: Infinite scroll (opt-in, Price Settings) — loads the next page inline near the bottom, deduped by ASIN. Mutually exclusive with auto-advance.
- **Feature**: Stats tab — cache size and age, items seen today/this week, a price histogram colored by your thresholds, and visible/hidden counts for the current page.
- **Feature**: Price-check links on each badge — **K**eepa (marketplace-aware), **C**amelCamelCamel, and **G**oogle search of the product title. Toggleable in Price Settings.
- **Feature**: Claude (Anthropic) is a third AI review provider alongside OpenAI and DeepSeek, with a configurable model (default `claude-opus-4-8`).

## Version 1.42.2 - Remove Purple Filter

- **UX**: Removed the purple ($0) filter — the checkbox, its hotkey (3), the badge style, and the $0 → purple color mapping. $0-ETV items now fall through to red like any other sub-threshold item.

## Version 1.42.1 - Stop Fabricating Personal Anecdotes in AI Reviews

- **Fix**: AI-generated reviews were inventing personal stories (e.g. "I took this on a two-week European vacation") not provided by the user. The prompt now explicitly forbids fabricated trips, events, or life context and keeps the review grounded in what the product actually does.

## Version 1.42.0 - DeepSeek Provider Support

- **Feature**: AI Review Generator now supports DeepSeek as an alternative AI provider alongside OpenAI. Select the active provider in Vine Tools > Price Settings via a new "AI Provider" dropdown.
- **Feature**: DeepSeek model is configurable in Settings (default: `deepseek-v4-flash`). Switching providers shows/hides the relevant API key and model fields inline — no page reload required.
- **Enhancement**: Error messages when an API key is missing now name the active provider (e.g., "DeepSeek API key not configured") for clarity.

## Version 1.41.7 - Retry & Friendlier Errors for OpenAI 429

- **Fix**: "Generate Review" was bailing out with a bare `HTTP 429` on the very first rate-limit response. OpenAI's RPM/TPM limits and short bursts both surface as 429, but the script wasn't retrying, so a single overlap with another request killed the generation.
- **Fix**: 429 responses are now retried up to 4 attempts total with exponential backoff (1s, 2s, 4s), honoring the `Retry-After` header when OpenAI sends one. 5xx responses get the same treatment. The status banner updates in real time during backoff so the user can see what's happening instead of staring at a hung button.
- **Fix**: `insufficient_quota` (billing/plan exhausted) is no longer treated as transient — we surface it immediately as "OpenAI quota exceeded — check your plan and billing at platform.openai.com" instead of burning four retries first.
- **Hardening**: `gmFetch` now attaches `status`, `statusText`, `responseText`, and `responseHeaders` to the rejected `Error`, so callers can read OpenAI's structured error body (`error.code`, `error.message`) instead of just a status line. Used to produce specific messages for 401 (invalid key), 429 quota vs rate-limit, and 5xx.

## Version 1.41.6 - Defensive Cache Entry Validation

- **Fix**: Sync was crashing with `TypeError: null is not an object (evaluating 'localEntry.timestamp')` inside `syncWithGitHub`'s `getCache` callback when any cache entry was `null` (e.g. a partially-written entry, or stale data from an older schema). The loop dereferenced `localEntry.timestamp` without checking the entry itself.
- **Hardening**: `syncWithGitHub` now coerces both `localCache` and `remoteCache` to plain objects (non-null, non-array) before merging, skips any individual entry that isn't a real object, and pulls `timestamp` only when it's actually a number. Same type-guards applied to `enforceCacheSizeLimit`'s sort comparator and the initial `memoryCache` hydration in `getCache` so a corrupted storage blob can't poison eviction or first-load either.

## Version 1.41.5 - JSON Response Format for AI Reviews

- **Fix**: Negative reviews (2-star, especially with user comments) were producing a blob of prose that got split wrong — the entire review landed in the title field and the body was empty. The model was ignoring the "first line = title, rest = body" format rule and returning everything on a single line separated by a period.
- **Fix**: Now requests the review as a JSON object with explicit `title` and `body` fields, using OpenAI's `response_format: { type: "json_object" }` JSON mode. No more newline parsing games.
- **Hardening**: `parseGeneratedReview` has a three-tier fallback: JSON first, then newline-split (for older cache), then first-sentence split (if model ignores JSON mode and returns one-line prose). `max_tokens` bumped from 500 to 700 since JSON adds some overhead.

## Version 1.41.4 - Scope Review Form Lookup to React App Container

- **Fix**: The v1.41.3 scoped lookup used `form[name="ryp__review-form"]`, which Amazon no longer emits. The body field is rendered by the React app inside `<div id="react-app" class="ryp__desktop">` — scope now prefers that container, with `#react-app` + the old form selectors as fallbacks.
- **Fix**: Expanded body textarea selectors to cover the `reviewText`/`reviewBody` camelCase naming Amazon uses in its `window.P.appConfig.validationRules`, plus placeholder-text and aria-label heuristics.
- **Diagnostics**: When the body field still can't be found, the console now dumps *every* visible textarea and contenteditable inside the review scope (with tag, id, class, aria-label) so the exact selector can be identified in one round trip.

## Version 1.41.3 - Rufus Textarea Exclusion + Scoped Review Form Lookup

- **Fix**: The review-body auto-fill was silently populating Amazon's Rufus AI shopping-chat textarea (`<textarea id="rufus-text-area">`) instead of the real review body. My last-resort "first non-vine textarea" fallback matched it because Rufus's widget ships on the same page.
- **Fix**: Auto-fill now prefers **scoped** lookup inside `form[name="ryp__review-form"]` (or equivalent) before falling back to page-wide selectors — this guarantees we can't accidentally target a different feature's text input.
- **Fix**: Explicit deny-list for field IDs matching `/rufus/i` or `/search/i`, plus `rufus-text-area` and our own `vine-review-comments`. Any future Amazon-injected textarea that shares one of these naming conventions will be skipped.

## Version 1.41.2 - Review Body Auto-Fill for Rich-Text Editor

- **Fix**: Review-form auto-fill now handles Amazon's rich-text editor (contenteditable `<div>`) in addition to the legacy `<textarea>`. Title was working but body would silently fail to populate when the form rendered as a ProseMirror/Lexical-style editor.
- **Implementation**: `fillReviewField` now branches on element type — `<input>`/`<textarea>` still use the React native-setter + `input` event path; contenteditable editors use `execCommand('insertText')` after selecting existing contents (which triggers the beforeinput/input events Draft/Lexical/ProseMirror listen for), with a `textContent` + `InputEvent` fallback.
- **Diagnostics**: The console now logs what field types were matched (e.g. `{title: 'INPUT#ryp__review-title__input', body: 'DIV#(no-id)[contenteditable]'}`) so if a new Amazon variant ships, we can see which selector to add. Status messages are now specific about which half of the fill succeeded.

## Version 1.41.1 - Dark Mode Revert & UI Polish

- **Fix**: Reverted the `@media (prefers-color-scheme: dark)` block from v1.41.0. On macOS dark mode, the modal interior remained hardcoded white but buttons pulled dark-mode text colors, making "Save Settings" (white-on-yellow) and "Clear Cache" (red-on-black) illegible. Userscript is now explicitly light-only to match its host (Amazon is light-only too).
- **Hardening**: Primary button (`.vine-btn-primary`) now hardcodes `color: #0F1111` so yellow-button text can never flip even if someone reintroduces a dark theme later.
- **UX**: Demoted "Clear Cache" from a full-width twin of "Save Settings" to a small, underlined, right-aligned danger-link. Save is the happy path; Clear Cache is an escape hatch — the visual weight now reflects that. Two-step armed-click confirmation retained.
- **Consistency**: Migrated all remaining inline hardcoded grays (`#374151`, `#6b7280`, `#9ca3af`, `#e5e7eb`, `#f3f4f6`, `#f9fafb`, `#1f2937`, `#333`, `#e7e7e7`, and the green callout trio `#f0fdf4`/`#bbf7d0`/`#166534`) to `--vine-*` CSS tokens. The modal's copy/labels/borders now all read from the same palette.

## Version 1.41.0 - Code & UI Cleanup Pass

- **Feature**: Saved searches now support **drag-and-drop reordering** — grab the ⋮⋮ handle on any row and drop it where you want. Up/down arrow buttons removed.
- **UX**: Rename is now **inline** (click ✏️, type, Enter) instead of a native `prompt()`; delete is a **two-step armed-click** instead of a native `confirm()`; same pattern for "Clear Cache".
- **UI**: Settings modal, AI Review Generator, and saved-search rows all redesigned to match Amazon's native palette (white cards, `#D5D9D9` borders, `#FFD814` primary buttons, `#007185` links). Purple gradients and the Google Fonts `Cookie` import removed.
- **Accessibility**: Modal is now a proper `role="dialog"` with focus trap, focus restoration on close, and body scroll lock while open. Every icon-only button gets an `aria-label`. Status banners use `role="status" aria-live="polite"`. Darker green price badge for WCAG AA contrast. Tap-targets bumped to 44×44 on mobile.
- **UX**: `Esc` now closes the AI Review Generator and works even when focus is inside an input. An explicit ✕ close button was added to the settings modal. Dark-mode support via `prefers-color-scheme`.
- **Fix**: `syncWithGitHub` now flushes pending cache writes *before* merging with remote — prevents dropped prices during the 2s auto-sync window. PATCH is also skipped when the merged cache byte-matches the remote file.
- **Performance**: `applyColorFilter` no longer writes the cache on every re-apply — the "mark seen for next session" write happens once per item, guarded by `vineSeenPersisted`. Pre-release detection (`isPreReleaseItem`) is memoized on `dataset.vinePreRelease`. Cache expiry cleanup is deferred to `requestIdleCallback` so it doesn't block the first `processBatch`.
- **Refactor**: Extracted shared `gmFetch`, `githubRequest`, `makeShowStatus`, `findFirstMatch`, and pagination helpers. Collapsed triplicated retry logic in `fetchPrice`. Merged duplicate `beforeunload` listeners.
- **Cleanup**: Deleted dead `processVineItem` (~90 lines), unused `itemsProcessedThisSession`, unused `SHIPPING_ADDRESS_KEY` / `ENABLE_QUICK_BUY_KEY`, and the duplicate threshold-migration block in `getPriceColorSync`.
- **Fix**: Saved-search rows now built via DOM nodes (not `innerHTML` template interpolation) — closes a class of XSS vectors around renamed search names.
- **Fix**: Mobile FAB visibility now driven by a `body.vine-has-header-link` class instead of a broken sibling selector that never matched.
- **Fix**: The double-tap `V V` hotkey now resets properly if any other key is pressed between presses.
- **Fix**: UI injection retries (color filter bar, AI Review panel) are now capped at 10 attempts to prevent runaway polling on unsupported pages.

## Version 1.40.6 - AI Title Strict Constraints

- **Enhancement**: Fixed the AI Review title prompt and made it extremely explicit that the title MUST be a single, short phrase under 10 words, preventing long rambling multi-sentence titles.

## Version 1.40.5 - AI Review Box Fix

- **Fix**: Improved Amazon Review Box auto-fill logic to correctly target React-handled textareas and fallback gracefully to the unassigned textareas on the page. Form inputs now use native setters to ensure Amazon's validation registers the injected text properly.

## Version 1.40.4 - AI Review Auto-Fill

- **Feature**: AI Review Generator now automatically fills the Amazon review form fields (title and body) with the generated text when used on the review creation page (`/review/create-review`), saving you a couple of clicks!

## Version 1.40.3 - AI Title Refined

- **Enhancement**: Updated AI Review Generator title instructions to specify it must be under 100 characters and short but useful ("less is more").

## Version 1.40.2 - AI Review Enhancement

- **Enhancement**: Refined AI Review Generator prompt to further improve natural human tone.
  - Eliminated conversational greetings (e.g., "Hey there") at the start of reviews.
  - Prevented the AI from explicitly writing "Title:" prefixes or putting quotes around the title text.

## Version 1.40.1 - Code Quality Fixes

- **Fix**: Removed duplicate `autoAdvance` variable assignment on settings save.
- **Fix**: Improved price regex to prevent matching bare decimals (e.g. `"19."`) — now requires at least one digit after the decimal point.
- **Security**: Added `escapeHtml` utility and applied it to saved search name rendering to prevent XSS via malicious search names.
- **Fix**: Clipboard copy failures in the AI Review Generator now log the actual error to the console instead of silently swallowing it.
- **UX**: Settings modal now remembers and restores the last active tab across opens instead of always defaulting to "Searches".
- **Performance**: Replaced five separate `forEach` event listener loops on the search list with a single delegated `click` listener, reducing DOM overhead on every render.

## Version 1.40.0 - Saved Search Sync & Gist Improvements

- **Feature**: Implemented timestamp-based synchronization for saved searches to resolve conflicts between local and remote Gist storage.
- **Enhancement**: Enhanced Gist cache synchronization with truncated file handling and optimized merge logic.
- **Removed**: Pre-release item filtering and pre-release filter hotkey.

## Version 1.39.01 - AI Review Update

- **Enhancement**: Updated AI Review Generator prompts to enforce length constraints:
  - **Title**: One sentence, clear and concise.
  - **Body**: 5-8 sentences.

## Version 1.30.00 - Mobile Browser Support

- **Mobile Compatibility**: Added comprehensive mobile browser support for
  better accessibility across all devices.
  - **Floating Action Button (FAB)**: When the desktop header navigation is
    not found (typically on mobile browsers), a floating settings button now
    appears in the bottom-right corner.
  - **Multiple Header Selectors**: Improved header detection with fallback
    selectors for both desktop and mobile Amazon layouts.
  - **Responsive Styling**: Added mobile-optimized CSS with media queries for
    screens under 768px:
    - Smaller price badges (12px font, reduced padding)
    - Wrapped color filter checkboxes with better spacing
    - Full-width settings dialog (95vw) for better mobile viewing
  - **Touch-Friendly Interface**: Settings modal now has proper padding and
    overflow handling for mobile browsers.
  - **Accessibility**: FAB includes proper ARIA labels and touch-optimized
    sizing (56px).

## Version 1.29.00 - Native Filter Design

- **UI Overhaul**: Redesigned the "Price Filter" UI to be subtle and blend in with Amazon's native design.
  - The filters are now injected directly into the **Search Toolbar**, placing them neatly between the "Additional Items" buttons and the Search box.
  - Removed the large gradient-colored floating box.
  - Checkboxes now use standard styling with dark gray text to look like they belong on the page.
  - Filters are less intrusive but still easily accessible.

## Version 1.28.01 - Auto-Sync

- **Feature**: Cloud Sync now runs automatically (in the background) when you load a Vine page, provided you have a GitHub token saved.
- **Improved**: Added a 2-second delay to auto-sync to prioritize loading the page interface first.

## Version 1.28.00 - Cloud Sync

- **Feature**: Added Cloud Sync using private GitHub Gists to synchronize price cache across multiple devices/browsers.
- **UI**: Added "Cloud Sync" tab to Settings modal for token management and manual syncing.
- **Logic**: Implemented intelligent cache merging (union of keys, preferring newer timestamps).

## Version 1.27.01 - Filter UI Improvement

- **Fix**: The price filter bar at the top of the grid is now pinned (`position: relative`) so it scrolls with the page content rather than floating over it (`sticky`), preventing it from obscuring content on smaller screens.

## Version 1.27.00 - Intelligent Caching

- **Optimization**: The script now only caches item prices if the item is visible under the current color filters.
- **Benefit**: Prevents the cache from filling up with "junk" items (e.g. low value/red items) that the user has filtered out, keeping the cache smaller and more relevant.
  - If a filter hides an item, its price is fetched for display determination but **not saved** to the 7-day cache.
  - This allows re-checking for better filtering decisions in future sessions without stale hidden data.

## Version 1.26.02 - Keyboard Navigation

### New Features

1. **Keyboard Shortcuts for Pagination**:
   - **Right Arrow (→)**: Navigate to the next page
   - **Left Arrow (←)**: Navigate to the previous page
   - Shortcuts are disabled when typing in input fields (search, comments, etc.)
   - Works on all Vine browsing pages

### Technical Changes

1. **Version**: Updated from 1.26.01 to 1.26.02

2. **New Function**: `setupKeyboardNavigation()`
   - Listens for arrow key presses
   - Intelligently detects when user is typing and disables shortcuts
   - Finds and clicks pagination buttons

---

## Version 1.26.01 - Auto-Advance Fix

### Fixes

1. **Auto-Advance Logic**:
    - The "Auto-advance when all items hidden" feature now works **independently** of the "Hide Cached" filter.
    - It now correctly advances to the next page if all items are hidden by **ANY** filter (including the new Purple $0 filter, Green/Yellow/Red price filters, or Hide Cached).

## Version 1.26.00 - Support for $0 ETV Items

### Enhancements

1. **Purple Highlight for $0 Items**:
   - Items with a confirmed price/ETV of $0.00 are now highlighted in **Purple**.
   - These items are distinct from the "Red" (Low Price) category.
   - Example: A $0.00 item will show a purple badge with the tax value.

2. **$0 ETV Filter**:
   - Added a "🟣 Purple ($0)" filter toggle to the top bar.
   - Allows unique filtering for free items (often highly desirable in Vine).

### Technical Changes

1. **Version**: Updated from 1.25.08 to 1.26.01

2. **Logic Updates**:
   - `extractPriceFromHTML`: Now accepts `0` or `0.00` as a valid price (previously ignored).
   - `getPriceColorSync`: Added logic to return `'purple'` specifically when `price === 0`.
   - `CONFIG`: Updated default filters to include `purple: true`.
   - CSS: Added `.vine-price-purple` class with specific styling.

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.08 - UX Improvements

### UI Changes

- **Improved Filter Controls**: Moved the "Hide Cached Items" toggle from the Settings menu to the sticky top filter bar. You can now toggle visibility of previously seen items instantly alongside the price color filters.

## Version 1.25.07 - Minor UI Improvements

### Fixes

- **Color Filter Visibility**: Restricted the Green/Yellow/Red price filter checkboxes to only appear on Vine browsing pages (`/vine/vine-items`), preventing them from cluttering other pages like Orders or Account.

## Version 1.25.06 - AI Review Generator Enhancements

### New Features

1. **Universal AI Review Generator**:
    - Now works on **all** Amazon product pages (`/dp/*`), not just Vine-specific URLs.
    - Added support for **Review Creation Pages** (`/review/create-review*`). You can now generate reviews directly correctly on the submission form.
2. **Smart Context & UI Improvements**:
    - **Context Awareness**: On review pages, the script automatically fetches the product description from the product page using the ASIN, ensuring the AI has full context.
    - **Split Output**: Generated reviews are now separated into "Review Title" and "Review Body" fields, each with its own "Copy" button for easier pasting.
    - **Close Button**: Added a close (✕) button to the generator UI.
3. **Settings Integration**:
    - Added an **OpenAI API Key** input field directly in the "Vine Tools" settings menu for easier configuration.

## Version 1.25.03 - Natural Language Improvements

### Enhancements

1. **Significantly Improved AI Prompt for More Natural Reviews**:
   - Reviews now sound much more human and less AI-generated
   - Emphasizes casual, conversational language
   - Uses personal pronouns, contractions, and varied sentence structure
   - Includes specific instructions to avoid common "AI tells"
   - Maintains all Amazon Vine Voice guidelines

2. **Anti-AI Detection Features**:
   - Avoids phrases like "As a...", "overall", "in conclusion"
   - Prevents overly balanced pro/con structure
   - Encourages authentic imperfections
   - Focuses on specific personal observations
   - Writes like texting a friend

3. **Enhanced Prompt Engineering**:
   - System prompt positions AI as actual customer
   - User prompt emphasizes personal testing experience
   - Better integration of user comments
   - More natural sentiment handling

### Technical Changes

1. **Version**: Updated from 1.25.02 to 1.25.03

2. **Prompt Improvements**:
   - Expanded system prompt with natural language guidelines
   - Added explicit list of AI tells to avoid
   - Reframed user prompt to sound more personal
   - Maintained all Amazon Vine Voice requirements

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.02 - Review Page Support

### Enhancements

1. **AI Review Generator Now Works on Review Creation Pages**:
   - Appears on Amazon's review creation page (`/review/create-review`)
   - Perfect for Vine reviewers - generate reviews directly on the review form page
   - Also works on regular product pages and review pages for non-Vine purchases
   - Automatically detects page type and finds appropriate elements

### Technical Changes

1. **Version**: Updated from 1.25.01 to 1.25.02

2. **New @match Directives**:
   - Added `@match https://www.amazon.com/review/create-review*`
   - Added `@match https://www.amazon.com/*/review/create-review*`

3. **Smart Page Detection**:
   - Detects if on product page (`/dp/`) or review page (`/review/create-review`)
   - Different element selectors for each page type
   - Extracts product title/description from review page when available

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.01 - Universal Review Generator

### Enhancements

1. **AI Review Generator Now Works on All Amazon Product Pages**:
   - Previously limited to Vine pages only
   - Now available on ANY Amazon product page (/dp/ URLs)
   - Useful for writing reviews for all Amazon purchases, not just Vine items
   - Other features (price display, color filter, etc.) remain Vine-only

### Technical Changes

1. **Version**: Updated from 1.25.00 to 1.25.01

2. **New @match Directives**:
   - Added `@match https://www.amazon.com/*/dp/*`
   - Added `@match https://www.amazon.com/dp/*`
   - Allows script to run on all Amazon product pages

3. **Conditional Feature Loading**:
   - Added `isVinePage` check in init function
   - Vine-specific features only load on Vine pages
   - AI Review Generator loads on all product pages

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

---

## Version 1.25.00 - AI Review Generator

### New Features Added

1. **AI-Powered Review Generator**:
   - Automatically generates Amazon Vine reviews using OpenAI's GPT-3.5
   - Appears on product detail pages (when viewing /dp/ URLs)
   - Beautiful gradient UI matching the Vine Tools theme
   - Follows Amazon Vine Voice guidelines for quality reviews

2. **Review Customization**:
   - **Star Rating Selector**: Choose 1-5 stars for your review sentiment
   - **Comments Field**: Add specific points you want mentioned (e.g., "Used for 2 weeks", "Great battery life")
   - **Product Description**: Automatically extracts product details from the page
   - **Copy to Clipboard**: One-click copy of generated review

3. **OpenAI Integration**:
   - Configure your OpenAI API key in Vine Tools > Price Settings
   - Uses GPT-3.5-turbo model for cost-effective generation
   - Secure API key storage (stored locally, never shared)
   - Clear error messages if API key is missing or invalid

4. **Review Quality**:
   - Follows Vine Voice guidelines: unbiased, honest, insightful
   - Generates title + 2 paragraphs or less
   - Natural writing voice that sounds genuine
   - Avoids mentioning star rating numbers
   - Proper grammar and sentence structure

### Technical Changes

1. **Version**: Updated from 1.24.01 to 1.25.00

2. **New Storage Key**: `OPENAI_API_KEY: 'vine_openai_api_key'`
   - Stores user's OpenAI API key securely

3. **New Functions**:
   - `generateReview(productDescription, starRating, userComments)`: Calls OpenAI API to generate review
   - `createReviewGeneratorUI()`: Creates the review generator interface on product pages

4. **API Integration**:
   - Uses OpenAI Chat Completions API
   - Model: gpt-3.5-turbo
   - Temperature: 0.7 for natural variation
   - Max tokens: 500 for concise reviews

5. **UI Components**:
   - Star rating dropdown (1-5 stars with emoji)
   - Comments textarea with placeholder examples
   - Generate button with loading state
   - Review output area with copy button
   - Status messages for success/error feedback

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Navigate to any Amazon product page (/dp/ URL)
2. Scroll to find the "🤖 AI Review Generator" section
3. First time: Add your OpenAI API key in Vine Tools > Price Settings
4. Select your star rating (1-5 stars)
5. Optionally add specific comments you want included
6. Click "Generate Review"
7. Copy the generated review to your clipboard
8. Paste into Amazon's review form

**Note**: This feature requires an OpenAI API key. Get yours at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). GPT-3.5-turbo is very affordable for occasional use.

---

## Version 1.24.01 - Filter UI Improvements

### UI Enhancements

1. **Right-Aligned Filter**:
   - Filter bar now appears on the right side of the page instead of spanning full width
   - More compact and unobtrusive design
   - Better visual hierarchy

2. **Compact Box Design**:
   - Filter container now only wraps around the content (label + checkboxes)
   - Changed from full-width to inline-flex layout
   - Cleaner, more polished appearance

### Technical Changes

1. **Version**: Updated from 1.24.00 to 1.24.01

2. **UI Structure**:
   - Added wrapper div for right alignment (`vine-color-filter-wrapper`)
   - Changed filter container from `display: flex` to `display: inline-flex`
   - Moved sticky positioning to wrapper for better control

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)
- `README.md` (updated feature description)

---

## Version 1.24 - Color Filter Feature

### New Features Added

1. **Color Filter Bar**:
   - Prominent filter bar displayed at the top of the grid view
   - Three checkboxes for filtering items by price color:
     - 🟢 Green ($90+)
     - 🟡 Yellow ($50-89)
     - 🔴 Red (<$50)
   - Checkboxes can be selected in any combination
   - Sticky positioning keeps filter visible while scrolling
   - Beautiful gradient design matching the Vine Tools theme

2. **Real-time Filtering**:
   - Instantly shows/hides items based on selected filters
   - Works seamlessly with existing "Hide cached items" feature
   - Filter state persists across page reloads and sessions

### Technical Changes

1. **Version**: Updated from 1.23 to 1.24

2. **New Storage Key**: `COLOR_FILTER_KEY: 'vine_color_filter'`
   - Stores object: `{ green: boolean, yellow: boolean, red: boolean }`
   - Default: all colors enabled

3. **New Functions**:
   - `getColorFilter(callback)`: Retrieves color filter settings with caching
   - `applyColorFilter(item, color)`: Applies filter to individual item
   - `createColorFilterUI()`: Creates and inserts the filter bar UI
   - `applyColorFilterToAllItems()`: Applies filter to all processed items

4. **Enhanced Badge System**:
   - Added `data-price-color` attribute to price badges
   - Enables efficient filtering by color category
   - Added `data-vine-color-filtered` attribute to track filter state

5. **UI Design**:
   - Gradient purple background matching Vine Tools
   - Hover effects on checkbox labels
   - Responsive layout with flexbox
   - Smooth transitions

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Navigate to any Amazon Vine items page
2. The color filter bar appears automatically at the top of the grid
3. Check/uncheck color boxes to show/hide items by price range
4. Filter settings are saved automatically

This feature allows Vine reviewers to quickly focus on items in their preferred price ranges without scrolling through unwanted items.

---

## Version 1.21 - Auto-Advance Feature

### New Features Added

1. **Auto-Advance Toggle**:
   - New checkbox in Price Settings: "Auto-advance when all items hidden"
   - When enabled (along with "Hide cached items"), automatically navigates to the next page when all items on the current page are hidden
   - Repeats until it finds a page with non-hidden items
   - Helpful for quickly skipping through pages of already-viewed items

### Technical Changes

1. **Version**: Updated from 1.20 to 1.21

2. **New Storage Key**: `AUTO_ADVANCE_KEY: 'vine_auto_advance'`
   - Stores boolean value for auto-advance preference

3. **New Functions**:
   - `getAutoAdvance(callback)`: Retrieves auto-advance setting
   - `checkAndAutoAdvance()`: Checks if all items are hidden and navigates to next page

4. **Logic Flow**:
   - After processing items in `processBatch()`, calls `checkAndAutoAdvance()`
   - After saving settings, calls `checkAndAutoAdvance()` to immediately check current page
   - Waits 1 second after page load to ensure all items are processed
   - Finds next page button using multiple selectors for compatibility
   - Only advances if next page button exists and is not disabled

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Click "Vine Tools" in the Vine header
2. Go to "Price Settings" tab
3. Enable "Hide cached items"
4. Enable "Auto-advance when all items hidden"
5. Click "Save Settings"
6. The script will automatically skip to the next page if all items are hidden

---

## Version 1.15 - Saved Searches Feature

### New Features Added

1. **Renamed Menu**: "Price Settings" → "Vine Tools"
   - Better reflects the expanded functionality

2. **Tabbed Interface**:
   - Tab 1: Price Settings (existing functionality)
   - Tab 2: Saved Searches (new functionality)

3. **Saved Searches Management**:
   - **Add Searches**: Users can create custom search shortcuts with:
     - Custom name (e.g., "Electronics")
     - Search term (e.g., "laptop")
   - **Quick Navigation**: Click any saved search to navigate to:
     - `https://www.amazon.com/vine/vine-items?search={searchterm}`
   - **Edit**: Rename saved searches using the ✏️ button
   - **Delete**: Remove saved searches using the 🗑️ button
   - **Keyboard Shortcut**: Press Enter in either input field to add search

### Technical Changes

1. **Version**: Updated from 1.14 to 1.15

2. **New Storage Key**: `SAVED_SEARCHES_KEY: 'vine_saved_searches'`
   - Stores array of objects: `[{ name: string, term: string }]`

3. **UI Components**:
   - Tab switching logic with visual feedback
   - Dynamic search list rendering
   - Event listeners for add/edit/delete operations
   - Responsive button layout with color-coded actions:
     - Green gradient: Navigate to search
     - Orange: Edit search name
     - Red: Delete search

4. **User Experience**:
   - Empty state message when no searches exist
   - Confirmation dialog before deleting
   - Success/error status messages
   - Persistent storage across sessions

### Files Modified

- `amazon-vine-price-display.user.js` (main userscript)

### Usage

1. Click "Vine Tools" in the Vine header
2. Switch to "Saved Searches" tab
3. Enter a name and search term
4. Click "Add Search" or press Enter
5. Click the green button to navigate to that search
6. Use ✏️ to rename or 🗑️ to delete

This feature helps Vine reviewers quickly access their frequently-used searches without typing them repeatedly.
