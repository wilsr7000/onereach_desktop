# Code signing (macOS)

WISER is signed and notarized as **OneReach, Inc.** (Apple Team `6KTEPA3LSD`)
for official releases. This document explains how signing works for
maintainers, contributors, and forks — and what is deliberately **not** in
this repository.

## What is never committed

Private signing material can sign software as "OneReach, Inc." and therefore
never lives in the repo. The following are git-ignored, and the export guard
(`scripts/export-guard.mjs`) fails the build if any are staged:

- `*.p12` / `*.pfx` / `*.keystore` — the Developer ID **private key**.
- `*.cer` / `*.pem` / `*.key` — certificate/key material.
- `*.mobileprovision` / `*.provisionprofile` — provisioning profiles.
- `.env.notarization` — the Apple ID + app-specific password for notarization.

A provisioning profile contains only the *public* certificate (not the key),
but it is still CI-injected rather than committed, so forks supply their own.

## Building locally (contributors — unsigned)

You do **not** need any Apple credentials to build and run WISER locally:

```bash
npm run lite:build
LITE_PROVISIONING_PROFILE=none node lite/scripts/electron-builder-mac.mjs --publish=never
```

The result is an **unsigned** `.app`. macOS Gatekeeper will block it on first
launch; open it once with:

```bash
xattr -dr com.apple.quarantine "dist-lite/mac-arm64/WISER.app"
```

…or right-click the app → **Open** → **Open** in the dialog. This is normal
for locally-built, unsigned macOS software.

## Signing (maintainers / CI)

The signing **identity** comes from the environment, never from the repo:

- **Local maintainer:** the Developer ID certificate lives in your login
  keychain; electron-builder discovers it automatically. The provisioning
  profile (git-ignored) sits at
  `lite/build/Onereach_Lite_DeveloperID.provisionprofile`; the build uses it
  when present.
- **CI:** provide the cert and profile as encrypted secrets —
  - `CSC_LINK` (base64 of the `.p12`) + `CSC_KEY_PASSWORD` — electron-builder
    reads these natively to import the identity into a temporary keychain.
  - `LITE_PROVISIONING_PROFILE=<path>` — point the build at the profile you
    decrypted from a secret.
  - `.env.notarization` values (`APPLE_ID`, `APPLE_TEAM_ID`,
    `APPLE_APP_SPECIFIC_PASSWORD`) for notarization.

Provisioning-profile resolution (`lite/scripts/electron-builder-mac.mjs`):

| `LITE_PROVISIONING_PROFILE` | Behavior |
| --- | --- |
| a path | use that profile |
| `none` | build without a profile (unsigned / ad-hoc) |
| unset | use the default path **if the file exists**, else drop it |

So a fork or CI checkout without the profile still builds — it just isn't
signed with OneReach's identity.

## Forks

A fork that wants its own signed builds uses its **own** Apple Developer
account: create a Developer ID App ID + provisioning profile under your team,
then supply your identity via `CSC_LINK`/`CSC_KEY_PASSWORD` and your profile
via `LITE_PROVISIONING_PROFILE`. Nothing in this repo assumes OneReach's
certificate is present.
