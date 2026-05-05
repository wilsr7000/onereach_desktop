# Kernel Signing Spike

> Time-boxed investigation: does the electron-builder + Electron 41 nested-signature bug from full's [`PUNCH-LIST.md`](../PUNCH-LIST.md#L11-L17) manifest on lite's smaller surface?

## Background

Full app's known issue (PUNCH-LIST.md lines 11-17):

> **Notarization not producing valid signatures** — macOS won't persist mic/camera TCC permissions, so users see the same permission dialog on every launch.
> **Root cause**: electron-builder 26.8.1 + Electron 41.2.1 produces bundles with nested code signatures that fail `codesign --verify --deep --strict`. Current `package.json` has `strictVerify: false` and `gatekeeperAssess: false` to silently skip this check, but the underlying malformed signatures cause Apple's notarization service to reject the bundle.

Lite's surface is much smaller (no `claude-code/`, no `packages/agents/`, no `Flipboard-IDW-Feed/`, fewer native deps), so the bug may not manifest. If it does, the fix back-ports to full.

## Time Box

**Maximum 2 PR cycles** (estimate: roughly 1-3 days of focused work).

If the spike runs over budget, escalate to the user with findings and decide whether to:
- Defer signing to Phase 1 (downgrade Phase 0a exit gate to unsigned + Gatekeeper bypass)
- Continue spending on the fix
- Accept a workaround

## Investigation Steps

### Step 1: Build unsigned and verify structure

```bash
npm run lite:package:mac -- --config.mac.identity=null
```

Inspect `dist-lite/mac-arm64/Onereach.ai Lite.app/`:

- Are there nested `.app` bundles? (Look in `Contents/Resources/`, `Contents/Frameworks/`)
- Are there native helper apps with their own Info.plist?
- Compare with full's structure: which sources of nesting does lite NOT have?

If lite has no nested bundles at all, the bug almost certainly does not apply.

### Step 2: Sign and verify

Set up identity (already in `.env.notarization`):

```bash
source .env.notarization  # exposes APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD
npm run lite:package:mac
```

Then verify:

```bash
codesign --verify --deep --strict --verbose=4 "dist-lite/mac-arm64/Onereach.ai Lite.app"
echo "exit code: $?"
```

- Exit 0 + no errors  → lite signs cleanly. Document and proceed.
- Non-zero exit → bug manifests. Continue to Step 3.

### Step 3: Notarize and check ticket

```bash
xcrun notarytool submit "dist-lite/Onereach.ai Lite.dmg" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait
```

If notarization succeeds and `codesign --verify` passed, the spike is complete -- lite ships signed.

If notarization fails, the rejection log will identify the offending nested bundle. Check whether the same path exists in full's bundle (it almost certainly does).

### Step 4: Try the three documented fix paths

If the bug DOES manifest, try in order of cost:

#### Path A: electron-builder version downgrade

```bash
npm install electron-builder@25.1.8 --save-dev
npm run lite:package:mac
codesign --verify --deep --strict "dist-lite/mac-arm64/Onereach.ai Lite.app"
```

Versions known to be problematic: 26.8.x, 26.9.x. Try 25.x.

#### Path B: electron-builder version upgrade

```bash
npm install electron-builder@latest --save-dev
npm run lite:package:mac
codesign --verify --deep --strict "dist-lite/mac-arm64/Onereach.ai Lite.app"
```

If 27.x or higher exists with the fix, this is the cleanest path.

#### Path C: Custom afterPack re-sign script

If neither version change works, write `lite/scripts/resign-deep.mjs`:

1. Walk `dist-lite/mac-arm64/Onereach.ai Lite.app` recursively
2. Find every nested `.app`, `.framework`, `.bundle`, `.dylib`, `.so`
3. `codesign --remove-signature` then `codesign --sign <identity> --deep --options=runtime --entitlements ...` each one in dependency order (innermost first)
4. Finally re-sign the outer `.app`
5. Hook via `afterPack` in `lite/electron-builder.json`

Reference: [electron-builder afterPack hook docs](https://www.electron.build/configuration/configuration#afterpack)

### Step 5: Back-port the fix

Whichever path succeeds for lite gets back-ported to the full app's signing pipeline:

- If Path A: update full's `electron-builder` version and verify full still builds
- If Path B: same but newer
- If Path C: the `resign-deep.mjs` script lives at `scripts/` (root) and is referenced from full's `package.json` build.afterPack as well

Either way, full's PUNCH-LIST.md entry gets resolved -- update it with the version + path that worked.

## Exit Criteria

This spike is complete when ONE of these is true:

- `codesign --verify --deep --strict` passes on the lite signed `.app` AND notarization succeeds → kernel ships signed in Phase 0a as planned.
- 2 PR cycles consumed without resolution → escalate, downgrade to unsigned kernel + Gatekeeper bypass + defer signing to Phase 1.

---

## Findings (2026-05-04)

Spike status: **partial -- second exit criterion triggered**. ADR-029 records the deferral + ship strategy.

### What we confirmed

1. **The bug DOES manifest on lite.** `codesign --verify --deep --strict` fails with "nested code is modified or invalid" on every signable item (4 Helper.app variants + 4 frameworks). Same fingerprint as production full app at `/Applications/Onereach.ai.app`.

2. **Path A (downgrade to electron-builder 25.1.8) is dead.** Per [electron-builder#8966](https://github.com/electron-userland/electron-builder/issues/8966), the same signing-order bug exists in 25.1.8.

3. **Path B (upgrade to 27.x) is dead.** No 27.x release exists on npm. 26.9.0 is the latest as of this spike.

4. **Path C (custom `afterPack` re-sign in inner-first order) is partial.** We wrote `scripts/resign-deep.js` that signs all nested items deepest-first then the outer .app. The script:
   - Successfully signs in correct dependency order
   - Successfully verifies that each individual item has a valid signature on disk (`codesign --verify <item>` returns "valid on disk")
   - **Still fails `codesign --verify --deep --strict`** because the issue isn't ONLY ordering -- the leaf signatures themselves have `TeamIdentifier=not set`, and the designated requirement is generated as `certificate root = H"<leaf-hash>"` instead of the standard `anchor apple generic and certificate leaf[OU] = "<TeamID>"` Apple-anchor pattern.

### Root cause (confirmed)

Comparing our signature against a known-good third-party app (1Password):

```
# 1Password (correct):
Identifier=org.mantle.Mantle
TeamIdentifier=2BUA8C4S2C
designated => identifier "org.mantle.Mantle" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "2BUA8C4S2C"

# Ours (broken):
Identifier=org.mantle.Mantle
TeamIdentifier=not set
designated => identifier "org.mantle.Mantle" and certificate root = H"43dc6809038b61fa7623d398fd3db5f4230ca3fc"
```

Codesign falls back to `certificate root = H"<hash>"` when it can't validate the cert chain as Developer ID Application. This happens despite both Developer ID intermediate certs (G1 + G2) being present in the login keychain and the leaf cert being valid (expires Feb 2027). Why codesign fails to recognize the chain is not yet root-caused.

### What ships today

Per ADR-029: lite ships with the same broken-but-functional signature full ships with. First-time install requires right-click → Open. Auto-updates work via Squirrel.Mac (which uses laxer verification at install-time).

`scripts/resign-deep.js` is kept in the codebase, opt-in via `RESIGN=1` env var, so the eventual proper fix slots in without rewriting.

### What's required before public launch

(Tracked in `LITE-PUNCH-LIST.md` Critical/Blocking)

The remaining work, in order of likely cost:

1. **Try `--keychain` explicit flag.** Codesign uses default keychain search list; explicitly passing the user keychain may help it find the chain. ~1 hour to test.

2. **Try explicit `--requirements` with the standard Apple-anchor DR pattern.** Bypass codesign's default DR generator and force the proper one. ~2 hours.

3. **Try `osx-sign` with explicit `optionsForFile` per-file overrides.** Some users on the upstream issue report that fine-grained `--identifier` per nested item helps. ~3 hours.

4. **Bypass `@electron/osx-sign` entirely and write a manual codesign+notarize pipeline.** Heaviest option; only if 1-3 fail. ~1-2 days.

5. **Wait for upstream fix in `@electron/osx-sign`.** No timeline known.

### Back-port path to full

When a fix lands for lite, the same fix back-ports to full because:
- Both apps use the same `scripts/resign-deep.js` and `scripts/notarize.js` (shared, not duplicated)
- Both apps use the same Developer ID Application identity from the same keychain
- Full's nested structure is a superset of lite's, so a fix that works for lite's 8 items will also work for full's larger set

Update full's `package.json` `build.afterSign` to call the same `scripts/notarize.js` (already does), then enable `notarize: true` and `RESIGN=1` once verified.

## Logging

This file is the running log of spike findings. ADR-029 in `DECISIONS.md` is the formal decision record + supersedes the original "Logging" section's instruction to write ADR-014.

---

## Findings (as of 2026-05-04)

### Step 1 (build unsigned) — skipped
Lite has nested `.app` bundles (Onereach.ai Lite Helper, Helper (GPU), Helper (Renderer), Helper (Plugin)) and Frameworks (Electron Framework, Mantle, ReactiveObjC, Squirrel) inside `Contents/Frameworks/`. The bug applies to bundles with this shape, so we proceeded to Step 2.

### Step 2 (sign and verify) — bug **confirmed** on lite
`npm run lite:package:mac` (electron-builder 26.9.0 + Electron 41.2.1) signs the .app with the OneReach Developer ID cert, but `codesign --verify --deep --strict` exits 1 with `nested code is modified or invalid` on every Helper .app and every Framework. So the bug is not bundle-size dependent — lite hits it too.

### Step 4 — Path C (custom re-sign script) implemented but paused
[`scripts/resign-deep.js`](../scripts/resign-deep.js) walks the .app bottom-up, strips every existing signature, then re-signs each item innermost-first with the same identity / entitlements / hardened runtime. Wired via [`scripts/notarize.js`](../scripts/notarize.js) afterSign hook (shared with lite + full). Bundle ID is read from `context.packager.appInfo.id` so the same hook works for both `com.gsx.poweruser` (full) and `com.onereach.lite` (lite).

**Iteration found a second bug**: even after correct-order re-signing, `codesign --display --verbose=4` shows `TeamIdentifier=not set` on the nested Helper apps. That's a separate `@electron/osx-sign` issue and the deep re-sign doesn't fix it. Re-signing without also fixing the team-id is no improvement over electron-builder's default — same broken-but-functional state, just slower to produce.

### Current default — Path C **off**
[`scripts/notarize.js`](../scripts/notarize.js) gates the deep re-sign behind `RESIGN=1` (opt-in). Default builds and `release-lite.sh` skip it. The bundle electron-builder produces is what ships:

- The outer `.app` signature is valid (Apple Developer ID, hardened runtime, entitlements). Squirrel.Mac's auto-update flow checks the outer signature against the installed identity → upgrade flow works.
- Nested signatures fail `codesign --verify --deep --strict`. Apple's notary service rejects the bundle. **Internal upgrade testing is fine; first-launch on a fresh Mac without the OneReach cert pre-trusted requires the right-click → Open Gatekeeper bypass.**
- Same operational state as full's bundle today.

### Reactivating the spike
When the upstream `@electron/osx-sign` team-id issue is fixed (or we patch it locally), set `RESIGN=1`, verify with `codesign --verify --deep --strict`, attempt notarization, and either:

- Pass → flip the default in [`scripts/notarize.js`](../scripts/notarize.js) to `RESIGN_OFF=1` opt-out, log ADR-026 (or next), back-port to full's release pipeline.
- Fail → re-evaluate; the spike escalates to a Phase 1 deferral.

### Open
- Upstream `TeamIdentifier=not set` issue in `@electron/osx-sign`. Track / fix.
- Notarization can't proceed until the team-id issue is resolved.
- ADR not yet logged in [`DECISIONS.md`](DECISIONS.md) — will land when the spike resolves.
