# Release Integrity — Decision Needed

> Surfaced from the [state-of-Lite audit](../) §7 #5. Open question: how should lite verify that a downloaded update actually came from us, not just from someone with GitHub publish rights?

## Threat model

`electron-updater` verifies SHA512 of the downloaded `.dmg`/`.zip` against `latest-mac.yml`. But [`lite/scripts/release-lite.sh`](scripts/release-lite.sh) **hand-writes** that YAML to work around an electron-builder checksum bug — meaning the YAML and the binary are signed only by GitHub-release-write-permission, not by any private key we control.

If a maintainer's GitHub creds are compromised, the attacker can:
1. Mint a signed-by-Apple-Developer-ID `.dmg` (they need our cert OR the cert is pinned on disk → see Option B)
2. Push a tag like `lite-v5.1.0`, upload the YAML + binary
3. Every running lite instance polls, sees a "newer" version, downloads it (SHA matches the YAML), installs it

Auto-updaters are high-leverage attack surface — one compromise pushes to every user. Worth treating seriously even at small scale.

---

## Options

### Option A — GitHub artifact attestations (recommended)

GitHub now generates SLSA-provenance attestations for build artifacts produced by Actions workflows. A user's auth-only push cannot produce a valid attestation; only a workflow run can.

- Move release-lite.sh into a GitHub Actions workflow (signing/notarization happens in CI).
- Workflow uploads the `.dmg`/`.zip` + the attestation alongside the GitHub Release.
- At update-check time, lite fetches the attestation and verifies it via `gh attestation verify` (or a small JS verifier) before trusting the YAML.
- Public key custody: zero. GitHub manages the keys.

**Pros**
- No private key custody on our side.
- Full provenance chain — verifies the artifact came from a specific workflow on a specific commit.
- Cross-platform.

**Cons**
- Requires moving the release pipeline to GitHub Actions (it currently runs locally via `release-lite.sh`).
- Adds a runtime dependency: lite needs to call out to verify attestations on update.
- Most invasive option, biggest delta from current shape.

### Option B — Codesign team-ID pinning

After download, before applying the update, run `codesign --verify --strict` on the new `.app` and parse the Team ID. Reject the update if it doesn't match `6KTEPA3LSD` (OneReach, Inc.). The Apple Developer ID is the gate.

**Pros**
- Cheap (~30 lines in the updater install path).
- Reuses infrastructure we're already building (the resign-deep pipeline).
- No new key custody burden.

**Cons**
- macOS-only — Windows updates would have no equivalent.
- Doesn't help if our Developer ID cert is stolen.
- Doesn't verify lite-specific identity — any OneReach-signed binary would pass (e.g., a malicious build of the *full* app with the lite tag prefix).

### Option C — Detached signature on the YAML

Generate a release-signing keypair (e.g. minisign / ed25519). After release-lite.sh writes `latest-mac.yml`, sign it offline with the private key. Bundle the public key into the app at build time. At update-check time, fetch `latest-mac.yml.sig` alongside the YAML and verify before trusting.

**Pros**
- Cryptographically strong, independent of GitHub or Apple.
- Cross-platform.
- Modest implementation effort (a signed YAML is a well-trodden pattern).

**Cons**
- Real key custody discipline required (can't lose it; rotation needs an in-app fallback or breaks updates).
- Requires patching or wrapping electron-updater, which doesn't natively support YAML signature verification.
- Adds another secret to the release flow.

### Option D — Defer + accept

Document the threat model in [`DECISIONS.md`](DECISIONS.md), accept it for Phase 0a (small user base, fast detection if compromised, lateral blast radius limited because lite is a kernel with little surface), revisit in Phase 1 once the user base grows or the kernel ships content tabs.

**Pros**
- Zero implementation cost now.
- Honest about what we're carrying.

**Cons**
- The "small user base" justification expires fast — once content-tab ports land, lite becomes more valuable as a target.

---

## Suggested next move

If signing/notarization (the current spike) lands cleanly, **Option B is the smallest next step** — bolt a Team-ID check onto the updater's pre-install verify, document it as a layer, and then plan Option A as the durable answer for Phase 1. Option B + a recorded ADR-D-style deferral is a reasonable Phase 0a stopping point.

Open for the user to weigh in.

---

## Implementation effort estimates

| Option | LoC est. | Files touched | Cross-app impact | Phase fit |
|---|---|---|---|---|
| A — GH attestations | ~200 (workflow) + ~50 (verifier) | release-lite.sh, .github/workflows/, lite/updater/ | Could share a verifier with full's updater | Phase 1 |
| B — Team-ID check | ~30 | lite/updater/install.ts | macOS only | Phase 0a |
| C — Detached YAML sig | ~100 (release script) + ~50 (verifier) | release-lite.sh, lite/updater/ | Pattern reusable in full | Phase 0b |
| D — Defer | 0 | DECISIONS.md (one ADR) | n/a | Phase 0a accepted, Phase 1 revisit |

Numbers are rough; treat as ordering, not commitments.
