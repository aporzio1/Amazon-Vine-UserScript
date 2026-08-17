# Cache Sync Race Design

## Goal

Keep every locally observed Vine item in both the local cache and the cloud
cache when price fetching overlaps a Cloud Sync request.

## Design

Cache writes carry an in-memory generation number. A cache sync captures that
number, fetches and merges the remote document, then flushes and merges the
newest local cache again before replacing local storage. Therefore a write
that completes during a network request cannot be discarded by the remote
snapshot.

When the generation changed during the sync, the script schedules one
cache-only sync after the current request finishes. Cache writes already use a
five-second debounce and a fifteen-second maximum wait; the follow-up upload
runs only after that existing flush. Full sync remains throttled at thirty
minutes, but flushed cache writes are uploaded without waiting for the next
full sync.

## Error Handling

Background cache upload failures are logged and retain local cache data. A
later cache flush or normal full sync retries the upload. Existing manual sync
errors remain visible in Vine Tools.

## Verification

A Node regression test evaluates the real userscript sync functions with GM
storage and HTTP shims. It writes an ASIN while the first remote fetch is
pending, then verifies the ASIN remains locally cached and appears in the
remote document after the queued follow-up sync.
