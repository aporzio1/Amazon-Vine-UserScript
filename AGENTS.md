# Repository Guidelines

## Project Structure & Module Organization

This repository ships one distributable:
`amazon-vine-price-display.user.js`. It is a vanilla JavaScript userscript
wrapped in a single IIFE; configuration, storage, network helpers, UI,
filtering, sync, and initialization all live in that file. `README.md`
documents installation and behavior, while `CHANGES.md` is the release
history. Screenshots are stored at the repository root. Design notes and
planning records belong under `docs/`. Supabase schema migrations live in
`supabase/migrations/`; the no-secret OAuth return page is in
`sync-callback/`.

There is no generated source, package manager, build pipeline, or automated
test directory.

## Build, Test, and Development Commands

- `node --check amazon-vine-price-display.user.js && node --check sync-callback/callback-v1.50.0.js`
  checks JavaScript syntax without executing browser-only APIs.
- `npx markdownlint-cli2 "*.md" "docs/**/*.md"` validates Markdown using `.markdownlint.json`.
- `npx html-validate sync-callback/index.html` validates the OAuth return page.
- `git diff --check` catches trailing whitespace and malformed patch lines.

For runtime testing, install the `.user.js` file in Tampermonkey,
Violentmonkey, Greasemonkey, or Safari Userscripts, then reload a matched
Amazon Vine, product, or review-creation page. Inspect the browser console for
`[Vine]` messages and errors.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single-quoted strings, `camelCase` for
functions and variables, and `UPPER_SNAKE_CASE` for constants and `CONFIG`
keys. Prefer `const`; use `let` only for reassignment. Keep reusable selectors
and persisted key names in `CONFIG`. Route storage through
`getStorage`/`setStorage` and cross-origin requests through the existing
helpers. Preserve the userscript metadata block and avoid build-time
dependencies.

## Testing Guidelines

No automated framework or coverage threshold exists. Run the syntax and
whitespace checks for every change. Manually exercise the affected page type
and nearby regressions: badge/filter behavior on Vine grids, settings
persistence, modal keyboard controls, API failure states, and review-form
filling. Test in at least one supported userscript manager; note additional
browser coverage in the pull request.

## Commits, Releases & Pull Requests

Follow the existing imperative, outcome-focused commit style, for example
`Fix item-request 403 by removing the whole-page MutationObserver (v1.47.0)`.
Every code change must bump `@version`, prepend a matching `CHANGES.md` entry,
and update `README.md` when user-visible behavior changes.

Pull requests should explain the problem and solution, list manual test pages
and browsers, link relevant issues, and include screenshots for UI changes.
Never commit API keys, GitHub tokens, cached user data, or Amazon session
details.
