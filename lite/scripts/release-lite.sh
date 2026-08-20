#!/bin/bash

# ============================================================================
# LITE RELEASE SCRIPT - one-command release automation for Onereach.ai Lite
# ============================================================================
#
# Tag format:    lite-vX.Y.Z
# Channel:       latest (default; lite owns its own public repo per ADR-028)
# Update YAML:   latest-mac.yml (electron-builder auto-generates, we upload as-is)
# Public repo:   wilsr7000/Onereach_Lite_Desktop_App
#
# Version handling: lite uses electron-builder's `--config.extraMetadata.version`
# to override the version baked into the packaged app's Info.plist WITHOUT
# mutating the shared root package.json (which would change full's version
# too). Pass the version as the first argument:
#
#     bash lite/scripts/release-lite.sh 0.0.1
#
# If no argument is given, an interactive prompt asks. Either way, root
# package.json is left untouched. Per ADR-029, signing is "broken-but-
# functional" today (TeamIdentifier=not set; same as full app's production
# release). Notarization is opt-in via APPLE_ID env vars.
# ============================================================================

set -e

PUBLIC_REPO="wilsr7000/Onereach_Lite_Desktop_App"
LITE_PRODUCT_NAME="Onereach.ai Lite"
# artifactName in lite/electron-builder.json produces files with dots
# instead of spaces (Onereach.ai.Lite-...) so GitHub doesn't auto-rename
# them at upload time -- which would break the YAML's url field that
# electron-updater uses to download. See ADR-029 / signing notes.
LITE_ARTIFACT_PREFIX="Onereach.ai.Lite"
LITE_YAML="latest-mac.yml"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}==============================================================${NC}"
echo -e "${BLUE}    Onereach.ai Lite Release Automation                       ${NC}"
echo -e "${BLUE}==============================================================${NC}"
echo ""

# ---------------------------------------------------------------------------
# Parse version arg
# ---------------------------------------------------------------------------
NEW_VERSION="${1:-}"

# ---------------------------------------------------------------------------
# Release gate (2026-08-07): the script previously ran NO tests, so a
# release could ship from a red tree (v0.0.33 shipped broken prompt
# flows exactly this way). Typecheck + unit + integration must pass
# before we build. Emergencies can bypass with SKIP_GATE=1 — loudly.
# ---------------------------------------------------------------------------
if [ "${SKIP_GATE:-0}" = "1" ]; then
    echo -e "${YELLOW}⚠ SKIP_GATE=1 — releasing WITHOUT the test gate. Every defect${NC}"
    echo -e "${YELLOW}  in this build ships to the update feed. Document why.${NC}"
else
    echo -e "${BLUE}Release gate: typecheck + unit + integration…${NC}"
    if ! npm run lite:typecheck; then
        echo -e "${RED}✗ Typecheck failed — fix before releasing (or SKIP_GATE=1).${NC}"
        exit 1
    fi
    if ! npm run lite:test; then
        echo -e "${RED}✗ Tests failed — fix before releasing (or SKIP_GATE=1).${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Gate green.${NC}"
fi

if [ -z "$NEW_VERSION" ]; then
    echo -e "${BLUE}No version arg supplied. Choose:${NC}"
    echo "  Usage: bash lite/scripts/release-lite.sh <version>"
    echo "  Example: bash lite/scripts/release-lite.sh 0.0.1"
    echo ""
    read -p "Enter version (e.g. 0.0.1): " NEW_VERSION
fi

if [ -z "$NEW_VERSION" ]; then
    echo -e "${RED}No version provided. Aborting.${NC}"
    exit 1
fi

# Reject non-semver values early (pretty crude but catches typos)
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo -e "${RED}Version '${NEW_VERSION}' is not valid semver (e.g. 0.0.1, 1.2.3-beta.1).${NC}"
    exit 1
fi

LITE_TAG="lite-v${NEW_VERSION}"
echo -e "${GREEN}Lite version:    ${NEW_VERSION}${NC}"
echo -e "${GREEN}Tag:             ${LITE_TAG}${NC}"
echo ""

# ---------------------------------------------------------------------------
# Notarization credentials (opt-in)
# ---------------------------------------------------------------------------
if [ -f ".env.notarization" ]; then
    # shellcheck disable=SC1091
    source ".env.notarization"
fi

if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo -e "${GREEN}Notarization creds present (Apple ID: $APPLE_ID, Team: $APPLE_TEAM_ID)${NC}"
    # Probe Apple's RFC 3161 Timestamp Authority at timestamp.apple.com.
    # IMPORTANT: This is an HTTP service on port 80 (not HTTPS on 443).
    # The TSA only accepts POST with application/timestamp-query bodies, so
    # plain GET/HEAD requests legitimately return 401 / 400 / 405 -- all of
    # those are "service up" signals. Only a connection failure (HTTP code
    # "000" or empty) means the service or routing is genuinely broken.
    # We don't filter by specific HTTP code because curl can occasionally
    # write multiple status codes (e.g. "401000") when its own exit code
    # is non-zero -- so we just extract the first 3-digit code and treat
    # anything that isn't "000" as up.
    TS_RAW=$(curl -sS -o /dev/null --connect-timeout 5 --max-time 8 -w "%{http_code}" http://timestamp.apple.com/ts01 2>/dev/null || echo "")
    TS_PROBE="${TS_RAW:0:3}"
    if [ -n "$TS_PROBE" ] && [ "$TS_PROBE" != "000" ]; then
        echo -e "${GREEN}timestamp.apple.com reachable (HTTP $TS_PROBE) -- signing with timestamps + notarizing.${NC}"
    else
        echo -e "${YELLOW}timestamp.apple.com unreachable (raw='$TS_RAW'; check proxy/firewall).${NC}"
        echo -e "${YELLOW}Forcing SKIP_NOTARIZE=1 -- bundle will be signed but not notarized.${NC}"
        echo -e "${YELLOW}Users install with one-line xattr command (see release notes).${NC}"
        export SKIP_NOTARIZE=1
    fi
else
    echo -e "${YELLOW}Notarization creds NOT set -- bundle will be signed but not notarized.${NC}"
    echo -e "${YELLOW}Users install with one-line xattr command (see release notes).${NC}"
    export SKIP_NOTARIZE=1
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v gh &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is not installed. Install with: brew install gh${NC}"
    exit 1
fi

if ! gh api user --silent 2>/dev/null; then
    echo -e "${RED}Error: GitHub CLI not authenticated. Run: gh auth login${NC}"
    exit 1
fi

if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: must be run from repo root${NC}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 1: Clean previous lite build artifacts
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Step 1: Cleaning previous lite build artifacts...${NC}"
rm -rf dist-lite/*.dmg dist-lite/*.zip dist-lite/*.yml dist-lite/*.blockmap 2>/dev/null || true
echo -e "${GREEN}Cleaned${NC}"
echo ""

# ---------------------------------------------------------------------------
# Provisioning profile (2026-08-17): the profile is GIT-IGNORED, so a
# fresh release WORKTREE lacks it — and the mac config then silently
# drops mac.provisioningProfile while osx-sign STILL auto-injects the
# restricted keychain-access-groups (webauthn) entitlement. That
# combination is AMFI-killed at exec on launch (POSIX 163 / SIGKILL) —
# it bricked 0.0.63..0.0.70 for updating users and caused this
# machine's "phantom exec kills". Resolve the profile from the MAIN
# checkout when this build runs in a linked worktree.
if [ -z "${LITE_PROVISIONING_PROFILE:-}" ] && [ ! -f "lite/build/Onereach_Lite_DeveloperID.provisionprofile" ]; then
    MAIN_CHECKOUT=$(git worktree list | head -1 | awk '{print $1}')
    if [ -f "$MAIN_CHECKOUT/lite/build/Onereach_Lite_DeveloperID.provisionprofile" ]; then
        cp "$MAIN_CHECKOUT/lite/build/Onereach_Lite_DeveloperID.provisionprofile" lite/build/
        echo -e "${GREEN}✓ Provisioning profile copied from main checkout for worktree build.${NC}"
    fi
fi

# Step 2: Build (esbuild + lib-pin + electron-builder)
#
# Slim bundle (ADR-047): lite ships only the 4 deps declared in
# lite/package.json (electron-updater, otplib, jsqr, keytar). The
# `!node_modules/<pkg>/**/*` exclude list in lite/electron-builder.json
# filters out full's heavy deps at file-copy time. Without the excludes,
# electron-builder would bundle ALL of full's deps (better-sqlite3,
# canvas, sharp, ffmpeg-installer, all @or-sdk/*, duckdb, etc.) -- 240MB+
# of code lite never imports. With the excludes + npmRebuild=false, the
# DMG drops from 283MB to ~165MB and the build is ~4x faster.
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Step 2: Building Onereach.ai Lite v${NEW_VERSION}...${NC}"
BUILD_START_TIME=$(date +%s)

# Bump lite/package.json's version so main-lite.ts's readLiteVersion()
# picks it up at runtime (the bundled lite/package.json is read FIRST,
# before extraMetadata's override on the root package.json). This file
# is the single source of truth for lite's version.
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('lite/package.json', 'utf-8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('lite/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# esbuild + lib-pin + electron-builder. The dedicated runner reads
# lite/package.json's version + deps and writes a merged temp config
# (necessary because electron-builder's flat CLI arg parser can't
# deserialize JSON object values at leaf nodes).
npm run lite:build
node lite/scripts/record-lib-sha.mjs
node lite/scripts/electron-builder-mac.mjs --publish=never

BUILD_DURATION=$(($(date +%s) - BUILD_START_TIME))
echo -e "${GREEN}Build completed in ${BUILD_DURATION} seconds${NC}"
echo ""

# ---------------------------------------------------------------------------
# Restricted-entitlement tripwire (2026-08-17): keychain-access-groups
# on the outer app WITHOUT an embedded provisioning profile is an
# AMFI-killed binary — unshippable, no matter how it happened.
APP_BUNDLE=$(find "${MAC_OUT_DIR:-dist-lite/mac-arm64}" -maxdepth 1 -name "*.app" | head -1)
if [ -n "$APP_BUNDLE" ]; then
    if codesign -d --entitlements - "$APP_BUNDLE" 2>/dev/null | grep -q "keychain-access-groups"; then
        if [ ! -f "$APP_BUNDLE/Contents/embedded.provisionprofile" ]; then
            echo -e "${RED}✗ FATAL: restricted entitlement (keychain-access-groups) present but NO embedded.provisionprofile.${NC}"
            echo -e "${RED}  This binary is AMFI-killed at launch on users' machines. Aborting.${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ Restricted entitlement is paired with an embedded provisioning profile.${NC}"
    fi
fi

# Step 3: Verify build files
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Step 3: Verifying build artifacts...${NC}"

LITE_DMG="dist-lite/${LITE_ARTIFACT_PREFIX}-${NEW_VERSION}-arm64-mac.dmg"
LITE_ZIP="dist-lite/${LITE_ARTIFACT_PREFIX}-${NEW_VERSION}-arm64-mac.zip"
LITE_DMG_BMAP="${LITE_DMG}.blockmap"
LITE_ZIP_BMAP="${LITE_ZIP}.blockmap"
LITE_YAML_PATH="dist-lite/${LITE_YAML}"

declare -a FILES=("${LITE_DMG}" "${LITE_DMG_BMAP}" "${LITE_ZIP}" "${LITE_ZIP_BMAP}" "${LITE_YAML_PATH}")

# ---------------------------------------------------------------------------
# Packaged-boot sanity (2026-08-07): v0.0.40 shipped an asar missing
# @anthropic-ai/sdk's runtime dep 'standardwebhooks' — the installed
# app crashed at boot (module-not-found), which also bricks auto-update
# since a crashing app never reaches the updater. Verify the asar can
# satisfy the known boot-critical requires before anything uploads.
# ---------------------------------------------------------------------------
ASAR_PATH=$(find "${MAC_OUT_DIR:-dist-lite/mac-arm64}" -name "app.asar" -maxdepth 4 2>/dev/null | head -1)
if [ -z "$ASAR_PATH" ]; then
    ASAR_PATH=$(find dist-lite -name "app.asar" -not -path "*build*" 2>/dev/null | head -1)
fi
if [ -z "$ASAR_PATH" ]; then
    echo -e "${RED}✗ app.asar not found under dist-lite — cannot sanity-check the package.${NC}"
    exit 1
fi
ASAR_LIST=$(npx @electron/asar list "$ASAR_PATH")
# 0.0.46 postmortem: @anthropic-ai/sdk was external and its TRANSITIVE
# deps (standardwebhooks) were dropped by electron-builder's collector
# (a nested duplicate sdk under browser-use confused resolution) — the
# shipped app crashed at require time. The sdk is now BUNDLED into
# main-lite.js (lite/esbuild.config.mjs), so no sdk entries here. The
# As of 0.0.49 every pure-JS dep is bundled into main-lite.js (the
# collector dropped sdk transitives in 0.0.46 and electron-updater
# transitives in 0.0.47). keytar is the only runtime external left
# that must ship in node_modules. Keep this list in lockstep with the
# BUILT bundle's require()s; the boot smoke below is the arbiter.
for CRITICAL in "dist-lite/build/main-lite.js" "dist-lite/build/wiser-header.html" "dist-lite/build/preload-lite-wiser.js" "node_modules/keytar/package.json"; do
    if ! echo "$ASAR_LIST" | grep -q "$CRITICAL"; then
        echo -e "${RED}✗ Packaged asar is missing ${CRITICAL} — the installed app would crash at boot.${NC}"
        echo -e "${RED}  Run npm install and rebuild before publishing. Aborting.${NC}"
        exit 1
    fi
done
echo -e "${GREEN}✓ Packaged-boot sanity: asar contains the boot-critical modules.${NC}"

# ---------------------------------------------------------------------------
# Boot smoke (0.0.47): an asar listing proves PRESENCE, not BOOTABILITY —
# 0.0.46 taught that the hard way. Launch the freshly packaged binary and
# require its boot banner before anything uploads. SKIP_BOOT_SMOKE=1 to
# bypass in emergencies — loudly.
#
# CONCURRENT SESSIONS (the 0.0.57 + first-0.0.69 aborts): any
# install/relaunch snippet that pkills by an UNANCHORED pattern — e.g.
#   pkill -f "Onereach.ai Lite.app/Contents/MacOS"     (killed the old
# in-place smoke) or pkill -f "Onereach.ai Lite" (still matches the
# smoke child today: the temp smoke.app copy keeps the product binary
# NAME) — kills the cut. The safe pattern is anchored to the installed
# app:
#   pkill -f "/Applications/Onereach.ai Lite.app/Contents/MacOS"
# The smoke tolerates ONE external SIGKILL (retry below); a second
# kill fails the cut.
# ---------------------------------------------------------------------------
if [ "${SKIP_BOOT_SMOKE:-0}" = "1" ]; then
    echo -e "${YELLOW}⚠ SKIP_BOOT_SMOKE=1 — shipping WITHOUT booting the package.${NC}"
else
    APP_BIN=$(find "${MAC_OUT_DIR:-dist-lite/mac-arm64}" -maxdepth 5 -type f -path "*Contents/MacOS/*" 2>/dev/null | head -1)
    if [ -z "$APP_BIN" ]; then
        echo -e "${RED}✗ Packaged binary not found — cannot boot-smoke. Aborting.${NC}"
        exit 1
    fi
    # 2026-08-15: macOS SIGKILLs fresh copies of the Developer-ID-signed
    # UNNOTARIZED bundle identity at exec (instant 137, empty log, no
    # syspolicy line) once its heuristics trip — while the blessed
    # /Applications install keeps running. Four cuts died this way. The
    # smoke's job is MODULE INTEGRITY (requires + boot path), which is
    # signature-independent — so smoke an AD-HOC-signed COPY and ship
    # the Developer ID original untouched.
    SMOKE_DIR=$(mktemp -d)
    cp -R "$(dirname "$(dirname "$(dirname "$APP_BIN")")")" "$SMOKE_DIR/smoke.app"
    codesign -f -s - --deep "$SMOKE_DIR/smoke.app" >/dev/null 2>&1
    APP_BIN=$(find "$SMOKE_DIR/smoke.app" -maxdepth 3 -type f -path "*Contents/MacOS/*" | head -1)
    if [ -z "$APP_BIN" ]; then
        echo -e "${RED}✗ Smoke copy failed — no binary in the ad-hoc copy. Aborting.${NC}"
        exit 1
    fi

    # One smoke attempt: launch, wait for a banner/handoff, clean up ONLY
    # our own child (an exact-path pkill — the old broad pattern killed
    # the USER'S INSTALLED APP and any concurrent cut's smoke child).
    run_boot_smoke() {
        BOOT_LOG=$(mktemp)
        # LITE_NO_KEYCHAIN (2026-08-20): the smoke child is an AD-HOC copy,
        # so its signature matches no Keychain ACL — touching the real
        # Keychain risks keytar's native abort (the 4x-in-one-day SIGABRT
        # class). Module integrity is the smoke's job; sign-in is not.
        LITE_NO_KEYCHAIN=1 "$APP_BIN" > "$BOOT_LOG" 2>&1 &
        BOOT_PID=$!
        BOOTED=0
        SMOKE_KILLED=0
        for _ in $(seq 1 25); do
            if grep -q "\[LITE\] Onereach.ai Lite v" "$BOOT_LOG"; then BOOTED=1; break; fi
            # The single-instance exit is ALSO a pass: that line prints from
            # code that runs only after every top-level require succeeded —
            # the exact integrity the smoke verifies (0.0.46 died at require
            # time, before any output). Happens whenever the user's installed
            # app is running during a cut.
            if grep -q "Another instance is already running" "$BOOT_LOG"; then BOOTED=2; break; fi
            if ! kill -0 "$BOOT_PID" 2>/dev/null; then
                # Child gone without a verdict. SIGKILL (137) = an EXTERNAL
                # kill (a concurrent session's app-restart pkill), not a
                # boot failure — the caller may retry once.
                wait "$BOOT_PID" 2>/dev/null
                [ "$?" = "137" ] && SMOKE_KILLED=1
                break
            fi
            sleep 1
        done
        kill "$BOOT_PID" 2>/dev/null || true
        sleep 1
        pkill -9 -f "$APP_BIN" 2>/dev/null || true
    }
    run_boot_smoke
    # Final-read race (2026-08-18): the loop breaks the moment the child
    # exits — WITHOUT re-reading the log. An app that prints its banner
    # and exits inside the same 1s window therefore "failed" while the
    # proof sat in the log (observed live on 0.0.76: the failure message
    # printed the banner it claimed was missing). The log is the
    # evidence; read it once more before believing the process clock.
    if [ "$BOOTED" = "0" ] && [ -f "$BOOT_LOG" ]; then
        if grep -q "\[LITE\] Onereach.ai Lite v" "$BOOT_LOG"; then
            BOOTED=1
        elif grep -q "Another instance is already running" "$BOOT_LOG"; then
            BOOTED=2
        fi
    fi
    if [ "$BOOTED" = "0" ] && [ "$SMOKE_KILLED" = "1" ]; then
        echo -e "${YELLOW}⚠ Smoke child was KILLED externally (concurrent session's pkill) — retrying once in 10s.${NC}"
        sleep 10
        run_boot_smoke
    fi
    # A booting app with a dead updater is 0.0.47's silent failure —
    # treat the updater's own unavailability log as a smoke failure.
    if grep -q "electron-updater not available" "$BOOT_LOG"; then
        echo -e "${RED}✗ Boot smoke: app boots but the UPDATER failed to load:${NC}"
        grep "electron-updater" "$BOOT_LOG" | head -3
        exit 1
    fi
    if [ "$BOOTED" = "0" ]; then
        echo -e "${RED}✗ Boot smoke FAILED — the packaged app never printed its banner:${NC}"
        tail -20 "$BOOT_LOG"
        exit 1
    fi
    if [ "$BOOTED" = "2" ]; then
        echo -e "${GREEN}✓ Boot smoke: module load proven via single-instance handoff (installed app is running).${NC}"
    else
        echo -e "${GREEN}✓ Boot smoke: the packaged app boots (ad-hoc smoke copy).${NC}"
    fi
    rm -rf "$SMOKE_DIR"
fi

# ---------------------------------------------------------------------------
# Manifest sanity (2026-08-07): the yml is uploaded as-is, so a stale
# dist artifact ships a manifest whose version disagrees with the tag —
# which BRICKS auto-update for every install (observed live: v0.0.38's
# feed briefly claimed version 0.0.9 pointing at a nonexistent zip).
# The manifest's version must match the release before anything uploads.
# ---------------------------------------------------------------------------
YML_VERSION=$(grep -m1 '^version:' "${LITE_YAML_PATH}" | awk '{print $2}')
if [ "$YML_VERSION" != "$NEW_VERSION" ]; then
    echo -e "${RED}✗ ${LITE_YAML}'s version (${YML_VERSION}) != release version (${NEW_VERSION}).${NC}"
    echo -e "${RED}  Stale dist artifact — rebuild before publishing. Aborting.${NC}"
    exit 1
fi
if ! grep -q "Onereach.ai.Lite-${NEW_VERSION}-" "${LITE_YAML_PATH}"; then
    echo -e "${RED}✗ ${LITE_YAML} does not reference the ${NEW_VERSION} artifacts. Aborting.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Manifest sanity: ${LITE_YAML} = ${YML_VERSION}, artifacts match.${NC}"

ALL_FILES_EXIST=true
for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo -e "${RED}Missing: $FILE${NC}"
        ALL_FILES_EXIST=false
    else
        SIZE=$(du -h "$FILE" | cut -f1)
        echo -e "${GREEN}Found: $(basename "$FILE") ($SIZE)${NC}"
    fi
done

if [ "$ALL_FILES_EXIST" = false ]; then
    echo -e "${RED}Build failed - missing files${NC}"
    exit 1
fi

# Bundle-size sanity check: with the slim excludes (ADR-047), the DMG
# should be ~165MB. If it's >200MB, the !node_modules/<pkg>/**/*
# excludes in lite/electron-builder.json are NOT taking effect and one
# or more of full's heavy deps is being bundled. Hard-fail so we don't
# silently regress.
LITE_DMG_BYTES=$(stat -f%z "${LITE_DMG}")
LITE_DMG_MB=$((LITE_DMG_BYTES / 1024 / 1024))
echo -e "${BLUE}Bundle size: ${LITE_DMG_MB} MB${NC}"
if [ "$LITE_DMG_MB" -gt 200 ]; then
    echo -e "${RED}Bundle too large (${LITE_DMG_MB} MB > 200 MB threshold).${NC}"
    echo -e "${RED}The slim excludes likely failed -- one of full's heavy deps slipped through.${NC}"
    echo -e "${RED}Check lite/electron-builder.json's !node_modules/* exclude list.${NC}"
    echo -e "${RED}Inspect: du -sh dist-lite/mac-arm64/*.app/Contents/Resources/app.asar.unpacked/node_modules/* | sort -rh${NC}"
    exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: Verify YAML version matches the build
# ---------------------------------------------------------------------------
YAML_VERSION=$(grep -E "^version:" "${LITE_YAML_PATH}" | awk '{print $2}')
if [ "$YAML_VERSION" != "$NEW_VERSION" ]; then
    echo -e "${RED}YAML version mismatch: ${YAML_VERSION} vs expected ${NEW_VERSION}${NC}"
    cat "${LITE_YAML_PATH}"
    exit 1
fi
echo -e "${GREEN}YAML version verified: ${YAML_VERSION}${NC}"
echo ""

# ---------------------------------------------------------------------------
# Step 5: Verify public repo accessible
# ---------------------------------------------------------------------------
if ! gh repo view "$PUBLIC_REPO" --json name &>/dev/null; then
    echo -e "${RED}Error: Public repository ${PUBLIC_REPO} not accessible${NC}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 6: Replace existing release if it exists (silent for non-interactive)
# ---------------------------------------------------------------------------
if gh release view "${LITE_TAG}" --repo "$PUBLIC_REPO" &>/dev/null; then
    echo -e "${YELLOW}Release ${LITE_TAG} already exists -- deleting + recreating${NC}"
    gh release delete "${LITE_TAG}" --repo "$PUBLIC_REPO" --yes 2>&1 | tail -2 || true
    # Also delete the tag itself so the release can be recreated cleanly
    gh api -X DELETE "repos/${PUBLIC_REPO}/git/refs/tags/${LITE_TAG}" 2>&1 | head -3 || true
fi

# ---------------------------------------------------------------------------
# Step 7: Generate release notes from recent lite/ + lib/ commits
# ---------------------------------------------------------------------------
LAST_TAG=$(git describe --tags --abbrev=0 --match 'lite-v*' 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
    COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges -- lite/ lib/ scripts/ 2>/dev/null || echo "")
else
    COMMITS=$(git log -10 --pretty=format:"- %s" --no-merges -- lite/ lib/ scripts/ 2>/dev/null || echo "")
fi

# Release notes template -- the install instructions differ depending on
# whether the bundle is notarized (the normal path) or signed-but-not-notarized
# (the degraded path when Apple's notary service or TSA is unreachable at
# build time). Notarized bundles install cleanly with no Gatekeeper prompts;
# unnotarized bundles need the one-line xattr command to bypass the
# "App cannot be opened" warning.
if [ "$SKIP_NOTARIZE" = "1" ]; then
INSTALL_BLOCK="## Install (signed, not notarized -- one-time setup)

This release is signed with Onereach's Apple Developer ID but could not
be notarized at build time (likely a transient Apple notary or timestamp
outage). To install:

1. Download the .dmg above
2. Open it and drag **Onereach.ai Lite** to /Applications
3. Open Terminal and paste this one-line command:

\`\`\`
xattr -dr com.apple.quarantine \"/Applications/Onereach.ai Lite.app\"
\`\`\`

4. Launch Onereach.ai Lite from /Applications. No further prompts."
else
INSTALL_BLOCK="## Install

1. Download the .dmg above
2. Open it and drag **Onereach.ai Lite** to /Applications
3. Launch Onereach.ai Lite from /Applications

This release is signed with Onereach's Apple Developer ID and
notarized by Apple. macOS will not show any \"unidentified developer\"
or \"App cannot be opened\" warnings."
fi

PUBLIC_NOTES="# Onereach.ai Lite ${LITE_TAG}

## Download

For Apple Silicon Macs (M1/M2/M3/M4):
${LITE_PRODUCT_NAME}-${NEW_VERSION}-arm64-mac.dmg

${INSTALL_BLOCK}

## Auto-Updates

Existing installs detect this release via electron-updater and prompt
to upgrade automatically. No reinstall needed.

## What Changed
${COMMITS}

---
*Onereach.ai Lite is the slim companion to [Onereach.ai](https://github.com/wilsr7000/Onereach_Desktop_App). Source: wilsr7000/onereach_desktop (private).*"

# ---------------------------------------------------------------------------
# Step 8: Publish to public repo
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Step 8: Publishing ${LITE_TAG} to ${PUBLIC_REPO}...${NC}"

gh release create "${LITE_TAG}" \
    "${FILES[@]}" \
    --repo "$PUBLIC_REPO" \
    --title "${LITE_TAG}" \
    --notes "$PUBLIC_NOTES"

PUBLISH_EXIT=$?

if [ $PUBLISH_EXIT -eq 0 ]; then
    echo ""
    echo -e "${GREEN}==============================================================${NC}"
    echo -e "${GREEN}                LITE RELEASE SUCCESSFUL                       ${NC}"
    echo -e "${GREEN}==============================================================${NC}"
    echo ""
    echo -e "${GREEN}Onereach.ai Lite ${LITE_TAG} is published.${NC}"
    echo ""
    echo -e "${BLUE}Public Release URL:${NC}"
    echo -e "${YELLOW}https://github.com/${PUBLIC_REPO}/releases/tag/${LITE_TAG}${NC}"
    echo ""
else
    echo -e "${RED}Failed to create public release${NC}"
    exit 1
fi
