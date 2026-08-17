# Cache Sync Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent overlapping price-cache writes and Supabase syncs from losing seen ASINs.

**Architecture:** Track local cache-write generations, serialize cache syncs, and re-merge the newest local cache before applying a remote result. A flushed write queues one cache-only follow-up upload outside the normal full-sync interval.

**Tech Stack:** Vanilla JavaScript userscript, Node built-in `node:test`, Supabase REST RPC.

## Global Constraints

- Keep the userscript dependency-free and preserve existing GM storage/network helpers.
- Bump `@version`, prepend `CHANGES.md`, and update `README.md` for this user-visible sync reliability fix.
- Preserve unrelated uncommitted saved-search work.

---

### Task 1: Regression harness

**Files:**
- Create: `tests/cache-sync-race.test.js`
- Test: `tests/cache-sync-race.test.js`

**Interfaces:**
- Consumes: exposed test hook `{ setCache, setCachedPrice, flushCacheUpdates, syncCacheWithSupabase }`.
- Produces: a failing test for a cache write made while Supabase GET is pending.

- [ ] **Step 1: Write failing test**

Create a `node:test` harness that evaluates the real userscript with mocked GM
storage and HTTP. Pause the first Supabase GET, call `setCachedPrice` for a
new ASIN, then release the response. Assert the final local and remote caches
both contain that ASIN.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cache-sync-race.test.js`

Expected: FAIL because the current sync snapshot omits the ASIN written after
the initial flush.

- [ ] **Step 3: Commit**

Do not commit in this shared dirty worktree unless the user requests it.

### Task 2: Serialize and preserve cache writes

**Files:**
- Modify: `amazon-vine-price-display.user.js:370-380`
- Modify: `amazon-vine-price-display.user.js:563-610`
- Modify: `amazon-vine-price-display.user.js:3198-3233`
- Test: `tests/cache-sync-race.test.js`

**Interfaces:**
- Consumes: `cacheWriteGeneration`, `queueCacheSync()`, and the current local cache.
- Produces: `syncCacheWithSupabase()` that preserves writes arriving during its request and uploads them in a follow-up cache-only sync.

- [ ] **Step 1: Write minimal implementation**

Increment `cacheWriteGeneration` from `setCachedPrice`. Queue background
cache sync only after `flushCacheUpdates` persists a change. Use one shared
cache-sync promise. In both remote merge and local apply callbacks, flush
pending writes without recursively queuing work, read current local cache,
and merge it by newest timestamp. If the generation advanced during sync,
queue a follow-up.

- [ ] **Step 2: Run regression test**

Run: `node --test tests/cache-sync-race.test.js`

Expected: PASS; local and remote cache both retain the late ASIN.

### Task 3: Release metadata and verification

**Files:**
- Modify: `amazon-vine-price-display.user.js:4`
- Modify: `CHANGES.md:3`
- Modify: `README.md:126`

- [ ] **Step 1: Document behavior**

Bump the version to the next available release, add a changelog fix entry, and state that cache
writes upload after the local price-fetch batch instead of waiting up to the
normal full-sync interval.

- [ ] **Step 2: Run verification**

Run: `node --test tests/cache-sync-race.test.js && node --check amazon-vine-price-display.user.js && node --check sync-callback/callback-v1.50.0.js && git diff --check`

Expected: all commands exit zero.
