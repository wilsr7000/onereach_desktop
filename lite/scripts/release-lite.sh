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
    # HEAD without a TSQ payload returns 401, which is the "service up"
    # signal -- only POST with application/timestamp-query is accepted.
    # A connection failure or DNS error here means a real outage / proxy /
    # firewall block; only then do we fall back to unnotarized + xattr.
    TS_PROBE=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 -X HEAD http://timestamp.apple.com/ts01 2>/dev/null || echo "000")
    if [ "$TS_PROBE" = "401" ] || [ "$TS_PROBE" = "200" ] || [ "$TS_PROBE" = "400" ] || [ "$TS_PROBE" = "405" ]; then
        echo -e "${GREEN}timestamp.apple.com reachable (HTTP $TS_PROBE) -- signing with timestamps + notarizing.${NC}"
    else
        echo -e "${YELLOW}timestamp.apple.com unreachable (got '$TS_PROBE'; check proxy/firewall).${NC}"
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
# Step 3: Verify build files
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Step 3: Verifying build artifacts...${NC}"

LITE_DMG="dist-lite/${LITE_ARTIFACT_PREFIX}-${NEW_VERSION}-arm64-mac.dmg"
LITE_ZIP="dist-lite/${LITE_ARTIFACT_PREFIX}-${NEW_VERSION}-arm64-mac.zip"
LITE_DMG_BMAP="${LITE_DMG}.blockmap"
LITE_ZIP_BMAP="${LITE_ZIP}.blockmap"
LITE_YAML_PATH="dist-lite/${LITE_YAML}"

declare -a FILES=("${LITE_DMG}" "${LITE_DMG_BMAP}" "${LITE_ZIP}" "${LITE_ZIP_BMAP}" "${LITE_YAML_PATH}")

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
