# WISER Meeting Security — Credentials, Token Distribution, Rotation

> Created 2026-06-10 after the meeting-subsystem audit. Owns three things:
> the LiveKit credential rotation runbook, the hosting configuration modes
> (server-mint vs per-account credentials), and the signed KV token
> distribution scheme the guest page enforces since `GUEST_PAGE_VERSION 10`.

## 1. Incident summary (what was wrong)

1. **Hardcoded LiveKit credentials.** `lib/livekit-service.js` ships a
   LiveKit Cloud API key + secret in every build. Anyone unpacking the
   asar (or reading the repo) can mint `roomAdmin` tokens for **any** room
   on the shared LiveKit project: join, record, mute, or evict any user's
   meeting. Treat that credential as public. (It remains in place as the
   deliberately-retained legacy fallback — §2 mode 3 — until rotation.)
2. **Unauthenticated KV writes.** Meeting tokens are distributed through the
   GSX KeyValue HTTP endpoint (`…/http/{accountId}/keyvalue2`, collection
   `wiser:meeting:tokens`, key `wiser-room:<room>`), which accepts PUT and
   DELETE with no authentication. Anyone reading the public join page source
   could overwrite a room's payload and redirect guests' camera/mic streams
   to an attacker-controlled SFU.

## 2. What the code now enforces

### LiveKit credentials (`lib/livekit-service.js`)

Hosting resolves credentials in precedence order:

1. `livekitMintUrl` (settings) — server-side mint, recommended; see §4.
2. `livekitUrl` + `livekitApiKey` + `livekitApiSecret` (settings) — the
   install brings its own LiveKit Cloud project.
3. `LEGACY_SHARED_CREDENTIALS` (in code) — the original shared-project
   pair, **deliberately retained** (decision 2026-06-10: hosting must stay
   fully functional with zero configuration until rotation). It is labeled
   as legacy, logged with a warning on first use, and **contained**:
   `test/unit/leaked-credential-scan.test.js` fails if the key id, project
   host, or secret (matched by SHA-256) appears in any file other than
   `lib/livekit-service.js` — tracked or new.

While mode 3 is in play the pair must be treated as public — anyone who
unpacked any build can mint `roomAdmin` tokens for rooms on the shared
project. Configuring mode 1 or 2 takes an install off that project
entirely. Rotation (§3) is what finally kills the exposure; afterwards
`LEGACY_SHARED_CREDENTIALS` gets deleted and the scan's allowlist emptied,
making the tree fully credential-free.

### Signed token distribution (KV stays world-writable, but writes stop mattering)

The KV endpoint's auth is owned by the GSX flow, not this repo, so the
client treats KV as an **untrusted channel** instead of trusting writes:

- Each install holds a persistent ECDSA P-256 keypair
  (`lib/meeting-link-keys.js`, settings key `meetingLinkSigningKeyV1`).
- `recorder:store-meeting-tokens` writes a **v2 envelope**:
  `{ v: 2, payload: "<json string>", sig: "<base64url P1363>" }` where
  `payload` = `{ v, roomName, tokens, livekitUrl, issuedAt, expiresAt }`.
- Join links gain the public key in the **URL fragment**:
  `join.html?room=<room>#k=<base64url raw P-256 key>`. Fragments never
  reach servers, CDN logs, or the KV.
- The guest page (v10+) and the in-app "join by link" path verify
  `sig` over the exact payload bytes, then check `roomName` match,
  `expiresAt`, and `wss://` scheme. **Anything that fails reads as
  "no active meeting"** — no oracle distinguishes tampering from
  not-started, so the genuine host write always wins eventually.

Threat model after this change:

| Attack | Before | Now |
| --- | --- | --- |
| Overwrite payload → hijack streams to attacker SFU | ✅ worked | ❌ signature fails, guests keep waiting |
| Replay another room's / older meeting's payload | ✅ worked | ❌ roomName / expiresAt / key mismatch |
| DELETE or corrupt payload → block joins | ✅ | ⚠️ still possible (see §5 — needs server-side write auth) |
| Read tokens for a discoverable room name | mitigated by room-name salting | unchanged (salting + expiry; tokens grant join, not admin) |

### Cutover notes (GUEST_PAGE_VERSION 9 → 10)

- The v10 page **hard-requires `#k`**: links shared before this version
  show "This meeting link is incomplete or from an older version" — hosts
  must re-copy links after updating. Deliberate: any unsigned fallback
  would reopen the downgrade hole.
- Page republish happens automatically per account on next host action
  (`recorder:get-guest-page-url` version check), so a host's app and their
  published page upgrade together. Mixed-version multi-machine accounts
  will disagree until both update; the error message guides re-sharing.
- The signing keypair is per-install. Clearing app settings (or hosting
  the same account from a second machine) changes `#k`, which only means
  previously shared links need re-sharing.

## 3. Rotation runbook — leaked LiveKit Cloud credential

> **Status: rotation deliberately deferred (decision 2026-06-10).**
> The legacy pair is still the in-code fallback (`LEGACY_SHARED_CREDENTIALS`,
> §2 mode 3) so hosting works as-is with zero configuration. Revoking the
> key kills hosting for **every** install running on that fallback — old
> field builds and this build alike. Sequence rotation:
> 1. Deploy the mint function (§4) — or distribute per-account credentials.
> 2. Point installs at it (`livekitMintUrl`), and ship a build with
>    `LEGACY_SHARED_CREDENTIALS` removed (one labeled block in
>    `lib/livekit-service.js` + emptying the scan allowlist).
> 3. Then rotate + revoke (steps below).
>
> While deferred: the pair stays usable by anyone who extracted it from
> any build, so **all meetings hosted on the legacy-shared project remain
> exposed** (roomAdmin mint; room-name salting is the only barrier). The
> signed-KV scheme below still holds regardless — token *distribution*
> can't be hijacked even while the LiveKit project itself is shared.

Do these in order when the time comes:

1. **LiveKit Cloud dashboard** → project `gsx-desktop` (the project whose
   URL is the old `wss://gsx-desktop-….livekit.cloud`) → Settings → Keys.
2. **Create a new API key/secret** (for the server-mint function only —
   never paste it into app settings that sync, never commit it).
3. Put the new secret in the **mint function's** config (§4), or — for
   single-user installs without the function — in per-install settings
   (`livekitUrl`/`livekitApiKey`/`livekitApiSecret`).
4. Verify: host a meeting; `getConfiguredMode()` should report
   `server-mint` (or `local`), and a guest join via a fresh link must work.
5. Remove `LEGACY_SHARED_CREDENTIALS` from `lib/livekit-service.js`, empty
   the allowlist in `test/unit/leaked-credential-scan.test.js`, and flip
   the legacy-fallback tests in `test/unit/livekit-service.test.js` to the
   hard-fail expectations. Ship that build.
6. **Revoke the leaked key — last.** It is the `apiKey` sitting in
   `LEGACY_SHARED_CREDENTIALS` (until step 5 lands). Revoking invalidates
   all outstanding tokens minted from it, including any attacker-minted
   `roomAdmin` tokens — and ends hosting for any install still on the
   fallback, which is why it comes after rollout.
7. Optional hygiene: the leaked pair lives in git history. History rewrite
   is not worth it (the credential is dead after step 6) — the scan test
   only polices the working tree.

## 4. Server-side mint — GSX function contract

Goal: the LiveKit secret lives **only** in a GSX function the account owner
deploys; the desktop app calls it with the user's GSX auth token.

**Settings:** `livekitMintUrl` = the function's HTTPS trigger URL.
When set it takes precedence over local credentials (`getConfiguredMode()`).

**Request** (from `lib/livekit-service.js` `mintRoomViaServer`):

```
POST <livekitMintUrl>
Headers:  Content-Type: application/json
          n: <caller's GSX auth token>      ← same header the rest of the app uses
Body:     { "roomName": "<slug>", "guestCount": 200 }
```

**Response** `200`:

```json
{ "hostToken": "<jwt>", "guestTokens": ["<jwt>", "..."], "livekitUrl": "wss://<project>.livekit.cloud" }
```

Errors: `401/403` for auth failures (the app surfaces "GSX sign-in may have
expired"), any other non-2xx for mint failures. The client validates the
shape and requires `wss://` — anything else is rejected.

**Function-side requirements (deploy checklist):**

1. Validate the `n` token against the owning account (any cheap
   authenticated Edison API call made *with the caller's token* works as a
   validity probe; reject when it fails or resolves to a different account).
2. Enforce `roomName` against `^[a-z0-9][a-z0-9-]{0,99}$` and cap
   `guestCount` at 200 — mirror the client's limits server-side.
3. Mint with `livekit-server-sdk` exactly as the local path does
   (`generateToken` in `lib/livekit-service.js` is the reference: guests
   get `roomJoin/canPublish/canSubscribe/canPublishData/canUpdateOwnMetadata`,
   12 h TTL; host adds `roomAdmin`, 24 h TTL).
4. Rate-limit per account (one room creation burst is ~201 mints; a sane
   cap is a few rooms/minute).
5. Keep the LiveKit secret in the function's secret store, not in flow
   source.

## 5. Open item — authenticated KV write path (server-side)

Signing removes the hijack, but an attacker can still **DELETE/overwrite**
payloads to deny joins. Closing that requires changing the GSX `keyvalue`
flow (outside this repo):

- Require a valid `n` token **for PUT/DELETE** on collection
  `wiser:meeting:tokens` (reads stay public — the guest page is
  unauthenticated by design and safe because of signatures).
- The desktop already attaches its account-scoped auth implicitly (the KV
  URL is derived from the account's own refresh URL); once the flow
  enforces the header, add `n: <token>` to the three fetches in
  `recorder.js` (`store`, `clear`, `before-quit` cleanup) — a one-line
  change each, behind a settings flag if a staged rollout is needed.
- Alternative considered and rejected: moving writes to the authenticated
  `@or-sdk/key-value-storage` SDK — it doesn't help while the public flow
  endpoint still accepts unauthenticated writes to the same store.

## 6. Enforcement map

| Guarantee | Enforced by |
| --- | --- |
| Legacy pair contained to `lib/livekit-service.js` (tracked + new files; secret matched by hash) | `test/unit/leaked-credential-scan.test.js` |
| Sanctioned site stays labeled `LEGACY_SHARED_CREDENTIALS` + runbook-linked, never an unmarked default | same file, structural assertions |
| Zero-config hosting works until rotation; per-account settings and mint URL take precedence | `test/unit/livekit-service.test.js` |
| Guest page only trusts signed payloads | `test/unit/capture-guest-page.test.js` (functional ECDSA tests against the real page script) |
| Node-sign ↔ WebCrypto-verify interop | `test/unit/meeting-link-keys.test.js` |
| Page version can't regress below 10 | `test/unit/capture-guest-page.test.js` |
