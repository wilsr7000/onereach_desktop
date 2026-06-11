# lite/ai

Main-process AI assist for Spaces. Drafts metadata for a new Space — a
polished purpose statement and 3–5 high-level objectives — from a short,
rough note the user types in the Space-creation wizard.

Provider-flexible: the same `spaceAssist()` surface is served by **either**
the Anthropic **Claude API** **or** a user-supplied **OneReach HTTP flow**.
The renderer reaches it through `window.lite.ai`; the key/token never leave
the main process.

## How it talks to providers

- **Claude** uses the official `@anthropic-ai/sdk` (added to
  `lite/package.json` and externalized in `lite/esbuild.config.mjs` per
  ADR-047's dependency recipe; ships with its tiny transitive deps). Model
  defaults to `claude-fable-5`, with structured JSON output.
- **OneReach flow** uses raw HTTP to a user-supplied flow URL, authenticated
  with a **FLOW token minted from the logged-in session** — the same
  `/http/{accountId}/refresh_token` mechanism `kv/flow-http-client.ts` uses.
  The user supplies only the flow URL; the token comes from login.

The SDK is reached through an injectable seam (`makeClaudeMessageCreator`),
so `callClaude` and the service unit-test without a network or the SDK.

## Configuration

Resolved by `config.ts`. **Environment variables win over the file, per
field.** Nothing here is committed; the user owns the file/env (analogous to
their `.env.notarization`). The secret stays in the main process and is
never logged or sent over the bridge.

### Environment variables

| Var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Use Claude. The key. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-fable-5`. |
| `ANTHROPIC_BASE_URL` | Optional. Defaults to `https://api.anthropic.com`. |
| `ONEREACH_FLOW_URL` | Use a OneReach flow. The flow's HTTP URL. |
| `ONEREACH_FLOW_TOKEN` | Optional token override. Normally the token is minted from login — leave unset. |
| `ONEREACH_FLOW_TOKEN_BASE_URL` | Optional. Override the `/refresh_token` host (defaults to edison). |
| `AI_PROVIDER` | Optional. Force `claude` or `onereach-flow`. |

### `ai-config.json` (in the app's userData dir)

```json
{
  "provider": "claude",
  "claude": { "apiKey": "sk-ant-...", "model": "claude-fable-5" },
  "onereachFlow": { "url": "https://...", "token": "..." }
}
```

For the OneReach flow, `onereachFlow.token` is optional — omit it and the
FLOW token is minted from the logged-in session at call time. When both
providers are present, `provider` (or `AI_PROVIDER`) decides; otherwise
Claude is preferred, then the OneReach flow. If nothing is configured,
`getStatus()` reports `{ configured: false }` and the wizard falls back to
fully manual entry.

## OneReach flow contract

The flow is called with `Authorization: FLOW <token>` (minted from the
logged-in session via `/http/{accountId}/refresh_token`) and a `POST` body:

```json
{ "purpose": "<user text>", "name": "<optional space name>" }
```

It must return JSON containing `description` (string) and `objectives`
(string[]), either at the top level or nested under `value` / `data` /
`result` / `output` / `response` / `body`. (The user supplies only the flow
URL — they never paste a token; `spaceAssist` fails with
`AI_NOT_CONFIGURED` if no one is signed in and no token override is set.)

## Public surface (`api.ts`)

- `getAiApi(): AiApi` — singleton.
- `AiApi.getStatus()` → `{ configured, provider }` (no secrets).
- `AiApi.spaceAssist({ purpose, name? })` → `{ description, objectives }`.
- `setAiConfigDir(dir)` — main-wiring hook (`initAi` calls it).
- `_resetAiApiForTesting()` / `_setAiApiForTesting(api)`.

## Error catalog (`AI_ERROR_CODES`)

| Code | When |
|---|---|
| `AI_NOT_CONFIGURED` | No provider configured. |
| `AI_INVALID_INPUT` | Blank/empty purpose. |
| `AI_NETWORK` | Request couldn't be sent (DNS/offline/TLS/abort). |
| `AI_AUTH_REJECTED` | Provider rejected the key/token (401/403). |
| `AI_RATE_LIMITED` | Provider rate-limited (429). |
| `AI_PROVIDER_ERROR` | Non-2xx status or an explicit refusal. |
| `AI_BAD_RESPONSE` | Response wasn't the expected `{description,objectives}` shape. |

## Security notes

- The API key / flow token enter only via `config.ts` and stay in the main
  process. They are never returned by `getStatus()`, never sent over the
  bridge, and never placed in error context or logs.
- The renderer (strict CSP, `default-src 'self'`) cannot make this network
  call itself — it goes through the `lite:ai:*` IPC handlers here.
