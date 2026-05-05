# lite/neon -- Neon (Neo4j Aura) Cypher client

Public surface: `getNeonApi()` from `./api.ts`. Renderer surface:
`window.lite.neon`.

This module gives Lite first-class, App-API access to a OneReach Neon
(Neo4j Aura) database via the Edison `/omnidata/neon` flow. **It is
NOT the full app's `omnigraph-client.js`.** OmniGraph is never
imported, never referenced. Phase N0 ships a minimal transport;
typed CRUD helpers (e.g. `upsertSpace`, `upsertAsset`) arrive with
the feature ports that need them.

## Usage

### Main process

```typescript
import { getNeonApi, NeonError } from '../neon/api.js';

const rows = await getNeonApi().query(
  'MATCH (p:Person {email: $email}) RETURN p LIMIT 1',
  { email: 'rich@example.com' }
);

try {
  const ok = await getNeonApi().ping();
} catch (err) {
  if (err instanceof NeonError && err.code === 'NEON_NOT_CONFIGURED') {
    // Direct user to Settings -> Neon
  }
}
```

### Renderer

```typescript
const result = await window.lite!.neon!.query(
  'MATCH (n) RETURN count(n) AS c'
);
const status = await window.lite!.neon!.status();
const probe  = await window.lite!.neon!.testConnection();
```

`window.lite.neon.configure(...)` is intentionally **not** exposed.
The Settings page calls a different IPC flow (`lite:neon:configure`)
gated through the Settings -> Neon section.

## Configuration

Persisted in KV collection `lite-neon-config`, key `default`:

```typescript
{
  endpoint: string;   // e.g. https://em.edison.api.onereach.ai/http/35254342-.../omnidata/neon
  uri: string;        // neo4j+s://40c812ef.databases.neo4j.io
  user: string;       // 'neo4j'
  password: string;   // <secret>
  database: string;   // 'neo4j'
}
```

The Settings -> Neon section is the user-facing path. For first-run
or scripted setup, the same record can be written via the KV API:

```javascript
await window.lite.kv.set('lite-neon-config', 'default', { ... });
```

## Public API surface

| Method | Returns | Throws | Bridged to renderer |
|---|---|---|---|
| `query(cypher, params?)` | `NeonRecord[]` | `NeonError` | Yes |
| `ping()` | `boolean` | `NeonError` | No (use `testConnection`) |
| `status()` | `NeonStatus` | -- | Yes |
| `testConnection()` *(IPC only)* | `{ ok, error?, code? }` | -- | Yes |
| `configure(config)` | `void` | `KVError`, `NeonError` | No (Settings flow only) |
| `onEvent(handler)` | unsubscribe fn | -- | No |

## Error catalog

All errors extend `NeonError` (which extends `LiteError`).

| Code | When | Remediation |
|---|---|---|
| `NEON_NOT_CONFIGURED` | Endpoint or credentials missing | Open Settings -> Neon and fill in the endpoint URL, URI, and password |
| `NEON_TIMEOUT` | Request didn't return within timeout (default 30s) | Check network; consider raising timeoutMs |
| `NEON_HTTP` | Server returned non-2xx | Status-specific (401/403/404/429/5xx all carry tailored hints) |
| `NEON_NETWORK` | `fetch` rejected before any HTTP response | Check DNS/VPN/captive portal; the endpoint may be unreachable |
| `NEON_QUERY` | Server accepted but Cypher itself failed | Inspect the Cypher and parameters |
| `NEON_BAD_INPUT` | Empty / non-string Cypher passed | Pass a non-empty Cypher string |

Catch with either `instanceof NeonError` (Neon-specific) or
`instanceof LiteError` (generic across all lite modules).

## Events

Per ADR-032, the module emits typed events through the central
logging API. Subscribe via `getNeonApi().onEvent(handler)`.

Names (full catalog in `./events.ts`):

- `neon.query.start` / `.finish` / `.fail`
- `neon.ping.start` / `.finish` / `.fail`
- `neon.configure.start` / `.finish` / `.fail`
- `neon.ipc.query`, `neon.ipc.status`, `neon.ipc.test-connection`,
  `neon.ipc.configure` (instant events; ADR-030)

## Security posture (Phase N0)

**Today**: credentials travel in the request body
(`neonUri`, `neonUser`, `neonPassword`, `database`). The Edison
`/omnidata/neon` flow accepts this shape. The renderer can run any
Cypher (read or write) -- same trust boundary as
`window.lite.kv.set()`.

**Why this is OK for now**: Lite is single-tenant, single-user, with
no untrusted code in any renderer. The KV creds storage is the same
trust boundary the user already accepts for Auth tokens.

**The Settings UI never displays the password back to the renderer**
once saved. Status checks return `hasPassword: boolean`, never the
value itself. This matches Auth's main-process-only `getToken`
posture.

## Hardening roadmap

The `CredentialsProvider` abstraction in `./credentials.ts` is the
seam for future security work. Each phase below changes one file
(plus a switch case in `client.ts:buildRequest`) -- no call site
changes:

| Phase | Trigger | Change |
|---|---|---|
| **N0** -- this PR | -- | `KVCredentialsProvider` returning `{ kind: 'basic-in-body', ... }` |
| **N1** | First feature port that needs typed graph ops | New module e.g. `lite/spaces/graph.ts` calls `getNeonApi().query()` |
| **N2** | Endpoint requires bearer auth | New `BearerCredentialsProvider` (reads from `getAuthApi().getToken('edison')`) + 1 case in `buildRequest` |
| **N3** | Endpoint requires OAuth2 / mTLS | Add provider variant + switch case |
| **N4** | Renderer trust needs reduction | Add `cypher` validator at IPC, expose `window.lite.neon.queryRead` / `queryWrite`. Existing `query` becomes `queryWrite` for back-compat |

## Forward-compat (what `lite/neon` will NOT do)

- **Typed CRUD helpers** (`upsertSpace`, `upsertAsset`,
  `ensurePerson`) -- those land in feature modules
  (e.g. `lite/spaces/graph.ts`), not here
- **Cypher escape-string utility** -- callers use bound `parameters`,
  never string concatenation
- **Async-job polling pattern** -- `/omnidata/neon` is inline; if a
  future endpoint switches, add it then
- **Result chunking for large payloads** -- not needed for graph CRUD
- **Settings UI** -- already exists via `lite/settings/sections/neon.ts`

## File layout

```
lite/neon/
  README.md          (this file)
  api.ts             PUBLIC -- NeonApi interface, getNeonApi()
  client.ts          INTERNAL -- EdisonNeonClient (HTTP wrapper)
  credentials.ts     INTERNAL -- CredentialsProvider + KV/Static providers
  errors.ts          INTERNAL -- NeonError, NEON_ERROR_CODES
  events.ts          INTERNAL -- NEON_EVENTS, NeonEvent union, isNeonEvent
  main.ts            INTERNAL -- initNeon() registers IPC
  types.ts           INTERNAL -- NeonRecord, NeonNode, NeonRelationship, etc.
```

Per Rule 11, **only `api.ts` is importable from other modules.** The
other files are module-internal; tests import them directly through
`./client.js` / `./credentials.js` paths but no production code does.

## Tests

- `lite/test/unit/neon-api.test.ts` -- `runApiConformanceContract`
  (Rule 12) + module-specific behavior
- `lite/test/unit/neon-errors.test.ts` -- `runErrorConformanceContract`
- `lite/test/unit/neon-client.test.ts` -- HTTP wrapper happy path +
  every error code
- `lite/test/unit/neon-credentials.test.ts` -- KV provider round-trip
  + Static provider semantics
- `lite/test/integration/neon-integration.test.ts` -- end-to-end
  through the IPC layer with a fake fetch backend

## Borrowed patterns

- `lite/kv/client.ts` -- timeout/abort/error-normalization shape
  copied wholesale; only the wire format differs
- `lite/auth/api.ts` -- "main-process-only credential" pattern
  (`configure` not bridged)
- `lite/auth/main.ts` -- JSON-error-over-IPC pattern with
  `parseError` on the renderer side
- `omnigraph-client.js` (full app) -- *studied for the request body
  shape only*; no code imported
