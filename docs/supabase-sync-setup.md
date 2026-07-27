# Supabase Cloud Sync Setup

The userscript contains the complete PKCE login and Supabase data-sync client.
The public callback is deployed at:

`https://amazon-vine-sync-auth.pages.dev/`

The callback has no Supabase credentials. It only returns a one-time
authorization code to the Amazon window that opened it.

## 1. Supabase Project

The production project is **Vine Userscript** (`jlneekyaknmfciilobtw`). Its
initial migration has been applied and recorded in Supabase's migration
history. For a replacement environment, create a Free project, open **SQL
Editor**, paste
`supabase/migrations/20260727000000_create_vine_sync_documents.sql`, and run
it once.

The migration creates three per-user JSON documents, enables Row Level
Security, and installs a revision-checked update function. Do not put a
`service_role` key in the userscript.

## 2. Configure Google Login

In Google Auth Platform:

1. Create an OAuth client with application type **Web application**.
2. Add `https://amazon-vine-sync-auth.pages.dev` as an authorized JavaScript
   origin.
3. Add the Supabase callback as an authorized redirect URI:
   `https://jlneekyaknmfciilobtw.supabase.co/auth/v1/callback`.
4. Configure the `openid`, email, and profile scopes.

Copy the Google client ID and secret into the Supabase Google provider
settings and enable the provider.

The production project's site URL and redirect allowlist are already set to
the Cloudflare callback. For a replacement project, add this entry under
**Supabase → Authentication → URL Configuration**:

`https://amazon-vine-sync-auth.pages.dev/**`

## 3. Configure the Userscript

The production public values are already in the userscript. For a replacement
project, copy its Project URL and publishable key from **Supabase → Project
Settings → API**, then update:

```js
SUPABASE_URL: 'https://PROJECT_REF.supabase.co',
SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_...',
SUPABASE_AUTH_CALLBACK_URL: 'https://amazon-vine-sync-auth.pages.dev/',
```

The publishable key is designed for client applications. Authorization is
enforced by the migration's RLS policies, not by hiding this key.

## 4. Verify

1. Reinstall or update the userscript.
2. Open **Vine Tools → Cloud Sync → Connect with Google**.
3. Complete Google sign-in and confirm the modal shows the connected account.
4. Click **Sync Now** on two browsers and verify cache, searches, and keyword
   lists converge.
5. In Supabase's Table Editor, confirm each user only has the three supported
   document kinds.

## 5. Migrate Existing GitHub Gists

Run this once from a browser that used the previous GitHub sync:

1. Connect the Supabase account in **Vine Tools → Cloud Sync**.
2. Confirm the legacy token is detected, or paste the previous token into the
   migration field. The token needs permission to read the user's Gists.
3. Click **Import legacy Gists**.
4. Verify the reported cache, search, and keyword counts on another connected
   browser.
5. Keep the old Gists briefly as a backup, then revoke the GitHub token. The
   importer never edits or deletes a Gist.

The importer recognizes `vine_price_cache.json`, `vine_saved_searches.json`,
and `vine_keyword_lists.json`, including the original array-only saved-search
format and truncated Gist files. It union-merges searches and keywords and
keeps the newest cache entry for each ASIN. After success, it removes the
legacy token and Gist IDs from local userscript storage.

The sync payload intentionally excludes Amazon cookies, AI provider keys, and
all other local settings.
