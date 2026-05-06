<!-- PR template -- the three-checkbox question is required per lite/LITE-RULES.md -->

## Summary

<!-- 1-3 bullets describing what this PR does and why -->

## Affected apps

Which apps does this PR change? Check all that apply:

- [ ] **Full app** -- changes to root files, packages/, or full-app behavior
- [ ] **Onereach Lite** -- changes under `lite/`
- [ ] **Shared `lib/`** -- changes that affect BOTH apps (requires CODEOWNERS dual review)

## Borrowed patterns (lite ports only)

<!-- If this PR ports a feature from full into lite, name the borrowed pattern:
     `[lite] foo.ts: borrows X pattern from full/foo.js:NNN-MMM; rewrites Y for lite scope.`
     References should be studied, NEVER imported. Lite imports only from lite/ and lib/. -->

_(N/A or pattern citation)_

## Chunk hardening status (post-Phase 0b)

<!-- If this PR is a menu-item port that lands under the chunk hardening contract, fill in: -->

- [ ] Contract test (zod-schema-driven)
- [ ] Unit coverage ≥85% lines, ≥95% branches on money/auth/data-write paths
- [ ] Integration test through real boundary
- [ ] E2E happy path on built lite (Playwright)
- [ ] Failure-mode tests for documented modes (PR tier, not nightly)
- [ ] Observability: log span + SLI metric

## Test plan

<!-- How was this tested? -->

- [ ] Unit tests pass locally (`npm test`)
- [ ] E2E tests pass locally (`npm run test:e2e` for full; `lite:test:e2e` once configured)
- [ ] Both apps run side-by-side without conflict (relevant for changes that touch ports / userData / IPC)

## Constitutional doc updates

<!-- Per .cursorrules, after completing work: -->

- [ ] PUNCH-LIST.md updated (full-app changes)
- [ ] LITE-PUNCH-LIST.md updated (lite changes)
- [ ] ROADMAP.md updated (major feature)
- [ ] DECISIONS.md ADR added (architectural decisions)
- [ ] PORTING.md updated (lite port status)
