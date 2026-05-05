# Onereach Lite -- The Constitution

**The single rule everyone remembers: Lite imports only from `lite/` and `lib/`. Full does not import from `lite/`. `lib/` has no upward dependencies.**

## The Rules

1. **Lite imports only from `lite/` and `lib/`.** No exceptions.
2. **Full does not import from `lite/`.** Ever.
3. **`lib/` has no upward dependencies.** It does not import from full's root files or `lite/`.
4. **`packages/` is not imported by lite.** Cherry-pick into `lite/` during a port; rewrite in TS-strict.
5. **Every lite file is TypeScript-strict.** No `.js` files in `lite/`. No `any` without justification.
6. **Every chunk lands with its tests in the same PR.** After Phase 0b, the six-criteria hardening contract applies (see `../.cursor/plans/onereach_lite_strangler_build_*.plan.md`).
7. **Lite has its own ports, app ID, userData, build output, and update channel.** Never share runtime state with full.
8. **Bug reports are tagged `app:lite` or `app:full`.** Never both.
9. **Shared `lib/` changes require a reviewer from each app's CODEOWNERS group.** No one-eye merges to `lib/`.
10. **If a rule above is in your way, propose changing the rule.** Do not violate it.
11. **Modules expose a public typed API via `<module>/api.ts`.** Cross-module imports go through that interface only -- never reach into `store.ts`, `main.ts`, or other internals. See [`PORTING.md`](PORTING.md) "Module Structure" and [`DECISIONS.md`](DECISIONS.md) ADR-019.
12. **Every module's `api.ts` runs through `runApiConformanceContract` from `lite/test/harness/`, and every module-specific error class runs through `runErrorConformanceContract`.** The meta-test at `lite/test/unit/module-conformance.test.ts` enforces this: adding a module without a contract test fails the build. See [`test/HARNESS.md`](test/HARNESS.md) for the recipe and [`DECISIONS.md`](DECISIONS.md) ADR-024.

## Port Configuration

| Service | Lite | Full |
|---|---|---|
| Log server | 47392 | 47292 |
| Agent exchange | 3457 (unused in kernel) | 3456 |
| Spaces API | 47391 (unused in kernel) | 47291 |
| Distribution repo | `wilsr7000/Onereach_Lite_Desktop_App` (public) | `wilsr7000/Onereach_Desktop_App` (public) |
| Update channel | `latest` (default) | `latest` (default) |
| Update YAML | `latest-mac.yml` | `latest-mac.yml` |
| App ID | `com.onereach.lite` | `com.gsx.poweruser` |
| `productName` | `Onereach.ai Lite` | `Onereach.ai` |
| `userData` | `Onereach.ai Lite/` | `Onereach.ai/` |
| Release tag prefix | `lite-vX.Y.Z` | `vX.Y.Z` |

Each app has its own public distribution repo (per ADR-027). That's why
both can use the default `latest` channel without colliding -- each
repo's "Latest release" is per-app.

## What Lite Shares With Full

- App icon (`assets/icon.icns`, `assets/icon.ico`, `assets/tray-icon.png`)
- AI provider keys (keychain entries; lite tags every call with `appId`)
- Cloud backend (OmniGraph, AI providers, Spaces -- lit only when respective ports land)
- macOS signing identity (Apple Developer cert, `.env.notarization`)
- Source files in `lib/` (read by both apps; pinned-by-SHA at lite release time)

## What Lite Does Not Share

- Local Electron `userData` (separate per app ID)
- Log server output (separate ports)
- Bug reports (separate tags + separate sinks until Spaces ports)
- Window state, preferences, caches
- Windows signing identity (lite procures its own EV cert in Phase 1)

## Cherry-Pick Discipline

When you port a feature from full into lite:

- **Read** the full-app reference files listed in the plan's "Full-app reference map" section
- **Rewrite** the pattern in TypeScript-strict within `lite/`
- **Never `import`** from full's root files or `packages/`
- **Note** the borrowed pattern in the commit message: `[lite] foo.ts: borrows X pattern from full/foo.js:NNN-MMM; rewrites Y for lite scope.`
- **Record** the port in `lite/PORTING.md` with the chunk-hardening status block

## Decision Log

All architectural decisions live in [`DECISIONS.md`](DECISIONS.md) in standard ADR format. New decisions append. Superseded decisions are marked, not deleted.

## When in Doubt

Read [`PORTING.md`](PORTING.md) for the per-chunk template, [`DECISIONS.md`](DECISIONS.md) for the rationale behind current architecture, and the plan file at `../.cursor/plans/onereach_lite_strangler_build_*.plan.md` for the strategic context.
