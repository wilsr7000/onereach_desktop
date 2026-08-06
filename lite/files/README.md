# `lite/files/` -- File storage on OneReach

Wraps `@or-sdk/files` so other Lite modules can upload, download, list, and delete files in OneReach storage without touching the SDK directly. Per-user isolation is enforced server-side: every request carries the user's `mult` token and the active `accountId`, so files in your account are never visible to anyone else's install.

- **Public API**: [`api.ts`](api.ts) -- `FilesApi`, `getFilesApi()`, `FilesError`, `FILES_ERROR_CODES`
- **Internal**:
  - [`sdk-client.ts`](sdk-client.ts) -- `SdkFilesClient` SDK wrapper (`@internal`)
  - [`types.ts`](types.ts) -- `FilesItem`, content + option shapes
  - [`errors.ts`](errors.ts) -- `FilesError` + code catalog
  - [`events.ts`](events.ts) -- typed event surface (ADR-032)
- **Tests**: [`../test/unit/files-api.test.ts`](../test/unit/files-api.test.ts), [`../test/integration/files-integration.test.ts`](../test/integration/files-integration.test.ts)

## Usage

```typescript
import { getFilesApi } from '../files/api.js';

// Upload bytes
const url = await getFilesApi().upload('bug-attachments', 'screenshot.png', bytes, {
  contentType: 'image/png',
  rewriteMode: 'prevent-rewrite',
  expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), // 7 days
});

// Get a fresh signed URL later
const fresh = await getFilesApi().getDownloadUrl('bug-attachments/screenshot.png');

// Convenience: download bytes directly
const buf = await getFilesApi().download('bug-attachments/screenshot.png');

// List
const items = await getFilesApi().list('bug-attachments');
// [{ key, size, contentType, lastModified, downloadUrl, ... }]

// Delete
await getFilesApi().delete('bug-attachments/screenshot.png');
```

## Auth

Every method requires a signed-in OneReach account. Signed-out callers see `FILES_NOT_AUTHENTICATED`. The auth bindings are wired by `lite/main-lite.ts` after `initAuth()` returns, via `setFilesAuthBindings({ getToken, getAccountId })` -- the files module never imports `lite/auth/` directly so dep-cruiser's `no-circular-in-lite` rule stays clean (mirrors the `setKVAuthBindings` pattern from ADR-044).

## Public vs private

Every method takes an optional `isPublic: boolean` (default `false`). Private files require a signed URL to download -- the platform documents those links as valid for **24 hours** -- while public files can be hot-linked with no stated expiry. There is no per-account ACL layer beyond this -- if you need fine-grained sharing, layer it in the consumer module.

> **This client inverts the platform default.** The OneReach Files docs state: *"If no preference is specified by default, the file is set to public."* Every call site here resolves the bucket through `wantsPublicBucket()`, which returns true only for a literal `true`. Omitting the flag — or passing a JSON-round-tripped `'true'` string — yields **private**. Publishing a user's file is the failure mode worth engineering against; refusing to publish is the recoverable one. Guarded by `test/unit/files-private-by-default.test.ts`, one case per operation.

Two platform constraints worth knowing:

- **You can only overwrite a file with another file of the same privacy.** Asset uploads use `rewriteMode: 'prevent-rewrite'`, so this never bites today — but it becomes live the moment anyone switches to `'rewrite'`.
- **`setPrivacy`'s options carry the file's CURRENT bucket, not the target.** `setPrivacy(key, 'private', { isPublic: true })` demotes a public file. Get it backwards and the call addresses the wrong bucket.

**The bucket is part of the file's identity, not a transient upload setting.** A key written to the public bucket cannot be read, TTL'd, or deleted as private -- every later call must pass the same `isPublic` the upload used. Consumers that persist a key must therefore persist its bucket alongside it; `lite/spaces/create-binary.ts` records `metadata.fileIsPublic` on the asset for exactly this reason.

Use `setPrivacy(key, 'public' | 'private')` to flip an existing file in place, rather than re-uploading.

## TTL (auto-expiry)

`upload({ expiresAt })` sets an expiry at write time; `setTtl(key, expiresAt | null, { isPublic })` adds, changes, or (with `null`) clears one afterwards. No TTL is the default -- files persist until explicitly deleted.

Callers should **validate the timestamp rather than forward it blindly**. A malformed or past `expiresAt` that the bucket quietly ignores leaves the user believing a file self-destructs when it never will; `create-binary.ts` rejects both cases up front.

## Error catalog

| Code | When | Remediation |
|------|------|-------------|
| `FILES_NOT_AUTHENTICATED` | No `mult` token / no active account | Sign in via Settings -> Account |
| `FILES_NOT_FOUND` | Server returned 404 (key doesn't exist) | Check the key + isPublic flag |
| `FILES_HTTP` | Non-2xx other than 404 / 409 / 413 (incl. 401/403) | Sign out + back in to refresh the token |
| `FILES_NETWORK` | Underlying fetch rejected (DNS / TCP / TLS) | Check network connectivity |
| `FILES_ALREADY_EXISTS` | `prevent-rewrite` upload found an existing file | Use `rewriteMode: 'rewrite'` or pick a different name |
| `FILES_TOO_LARGE` | Upload exceeded the configured `maxFileSize` | Lower the file size or raise `maxFileSize` |
| `FILES_INVALID_INPUT` | Caller passed an empty key, bad TTL, etc. | Fix the call site |

`get()` and `delete()` soft-fail not-found (return `null` / no-op) -- mirrors `kv.get` / `kv.delete`.

## Hardening roadmap

- **F1: Per-renderer bridge** -- `window.lite.files.*` IPC bridge for renderer-driven uploads (file pickers, drag-and-drop). Today the module is main-process only; renderers go through their own module's IPC (e.g. bug-report's "attach file" handler).
- **F2: Files Sync** -- thin `lite/files-sync/` wrapper around `@or-sdk/files-sync-node` for the "mirror a local folder to the cloud" use case (`gsx-file-sync.js` does this in the full app). Deferred -- different mental model, no in-app consumer yet.
- **F3: Multi-env** -- when the auth-multi-env chunk lands, files inherits per-env discoveryUrl + accountId from auth.
- **F4: Resumable uploads** -- the SDK's `uploadFileV2` is single-shot. Large-file uploads with resumable behavior would need a separate code path.

## Borrowed pattern

The construction shape (token getter + discoveryUrl + accountId) mirrors `lib/edison-sdk-manager.js:349-358` -- the full app's pattern, studied but not imported (per `lite/LITE-RULES.md`). The `setFilesAuthBindings` indirection mirrors `setKVAuthBindings` (ADR-044) and is documented in ADR-045.
