# Spaces — Privacy Review for the Member Picker

**Status**: Stub (drafted alongside [`./DISCOVERY-PHASE-3.md`](./DISCOVERY-PHASE-3.md); fills in with answers from D7).

**Phase**: Pre-B condition for Phase 3d (Sharing UX) per [`.cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md`](../../.cursor/plans/lite_spaces_phase_3_writes_share_onboard_7e4c2a91.plan.md) and [ADR-048](../DECISIONS.md).

**Sign-off required**: before any 3d code lands.

---

## Why this review exists

Phase 3d's Share modal needs a member picker — a list of "people in my account I could share this Space with." That picker reads from whatever Edison surface answers Discovery question **D7**. Depending on D7's answer, the picker's response payload may carry:

- Email addresses
- Phone numbers
- Last-active timestamps
- Roles / titles
- Avatars

Some of these are PII. Some are sensitive at the org level (e.g., "this person hasn't logged in for 90 days" is information about employment status). Some are fine to render. The plan-doc posture is: **resolve which is which before code, not after**, because retrofitting privacy filters is harder than building them in.

---

## What we're protecting against

Three concrete failure modes the review must close before 3d ships:

1. **Surface leak**. The picker UI renders an email or phone for someone the user shouldn't have visibility into. Cause: response carries the field, picker renders it without filtering.
2. **Logging leak**. PII fields show up in `lite/logging/api.ts` events because the picker emits a span with the response payload as `data`. Cause: defensive logging without redaction.
3. **Cache leak**. PII fields end up in KV (`lite-people-cache` or similar) because the picker tries to be fast on repeat opens. Cause: caching the raw response.

---

## Decision matrix (fills in with D7 answers)

| Field | In response? (D7) | Render in picker? | Log? | Cache? | Why |
|---|---|---|---|---|---|
| `id` | _D7_ | Yes (hidden but used for grant) | Yes | Yes | Required for `spaces.share()` |
| `displayName` / `name` | _D7_ | Yes | Yes | Yes | Required for picker UX |
| `email` | _D7_ | _decision_ | _decision_ | _decision_ | High PII; default conservative (no log, no cache, render only if necessary) |
| `phone` | _D7_ | No | No | No | High PII; not required for share UX |
| `avatar URL` | _D7_ | Yes | No | Yes (URL only, not bytes) | Low risk; cache for picker render speed |
| `role` / `title` | _D7_ | Optional | Yes | Yes | Org-level metadata; usually fine |
| `last-active-at` | _D7_ | No | No | No | Sensitive (employment-status-adjacent) |

**Default conservative posture for any field not listed**: do not render, do not log, do not cache — until explicitly reviewed.

---

## Questions for the privacy reviewer

The reviewer (org-level privacy contact, not the engineer building 3d) signs off on these answers:

1. Is rendering `email` in the picker acceptable for the org's privacy posture? If yes, do we need to truncate (`r***@onereach.ai`) or display in full?
2. Is `phone` ever required in the share-with-teammate flow? (The plan says no; confirm.)
3. Do account members have any per-user privacy preferences that would override the picker's default visibility?
4. Are there compliance requirements (GDPR, SOC2, HIPAA) that constrain what the picker can show?
5. Is logging PII at info-level acceptable, or should it always be redacted via the existing bug-report redaction patterns from [`lite/bug-report/`](../bug-report/)?
6. Is caching `email` in `lite/kv/` acceptable, given KV is per-account-scoped server-side (per [ADR-044](../DECISIONS.md#adr-044-lite-kv-transport-via-or-sdkdiscovery--or-sdkkey-value-storage))?

---

## Mitigation patterns Lite already supports

If D7's answer requires PII filtering, Lite has the seams:

- **Render-time redaction**: a single `redactForPickerRender(person): PickerRow` helper in `lite/people/` (or wherever D7 lands the module) takes the raw response and produces the safe-to-render shape.
- **Log redaction**: the bug-report redaction pipeline already strips known credential patterns; extending it to PII fields is one regex per field. See [`lite/bug-report/redact.ts`](../bug-report/redact.ts) (when it exists; pattern lives in `lib/`).
- **No-cache option**: the SDK call can simply not cache. Picker-open-latency is acceptable as a tradeoff if D7 returns sensitive data.

---

## What this review must produce

Before 3d code begins:

1. The decision-matrix table above filled in with concrete `Yes / No / Truncated` values per field.
2. A signed-off paragraph from the privacy reviewer naming the date and the reviewer.
3. A reference back from `lite/spaces/PRIVACY-REVIEW-PICKER.md` to the specific lines of `lite/people/api.ts` (or wherever D7 lands the module) that implement the filter, so the test in `lite/test/unit/people-no-pii-leak.test.ts` can assert the right fields are stripped.

---

## Sign-off log

_Each row records a specific review pass. Latest row is authoritative._

| Date | Reviewer | Decision | D7 answer at the time | Notes |
|---|---|---|---|---|
| _pending_ | _pending_ | _pending_ | _pending D7_ | Stub — review starts when D7 returns from Edison |

---

## Related

- [`./DISCOVERY-PHASE-3.md`](./DISCOVERY-PHASE-3.md) — D7 question that gates this review
- [ADR-048](../DECISIONS.md) — Phase 3 plan + Trust Principles operationalization
- [ADR-044](../DECISIONS.md#adr-044-lite-kv-transport-via-or-sdkdiscovery--or-sdkkey-value-storage) — KV server-side per-account scoping (relevant for caching decisions)
- [ADR-046](../DECISIONS.md#adr-046-first-run-ux-hardening--oauth-popups-stay-in-same-partition--2fa-needs-setup-banner--onboarding-checklist) — first-run UX hardening (precedent for OAuth-popup privacy posture)
