#!/bin/bash

# Build script for signed and notarized macOS app
# Usage: ./scripts/build-signed.sh [--skip-notarize]

# Exit on error
set -e

echo "🚀 Starting build process..."

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ This script must be run on macOS"
    exit 1
fi

# Check for skip notarization flag
SKIP_NOTARIZE=false
if [[ "$1" == "--skip-notarize" ]] || [[ "$SKIP_NOTARIZE_ENV" == "true" ]]; then
    SKIP_NOTARIZE=true
    echo "⚠️  Notarization will be skipped"
fi

# Check for required environment variables (only if not skipping notarization)
if [ "$SKIP_NOTARIZE" = false ]; then
    if [ -z "$APPLE_ID" ]; then
        echo "❌ APPLE_ID environment variable not set"
        echo "Please set: export APPLE_ID='your-apple-id@example.com'"
        echo "Or run with: ./scripts/build-signed.sh --skip-notarize"
        exit 1
    fi

    if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
        echo "❌ APPLE_APP_SPECIFIC_PASSWORD environment variable not set"
        echo "Please set: export APPLE_APP_SPECIFIC_PASSWORD='your-app-specific-password'"
        echo "Or run with: ./scripts/build-signed.sh --skip-notarize"
        exit 1
    fi

    if [ -z "$APPLE_TEAM_ID" ]; then
        echo "❌ APPLE_TEAM_ID environment variable not set"
        echo "Please set: export APPLE_TEAM_ID='your-team-id'"
        echo "Or run with: ./scripts/build-signed.sh --skip-notarize"
        exit 1
    fi

    echo "✅ Environment variables configured"
    echo "   Apple ID: $APPLE_ID"
    echo "   Team ID: $APPLE_TEAM_ID"
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf dist/

# Build the app
echo "📦 Building the app..."
npm run package:mac

# The app should now be signed automatically by electron-builder
echo "✅ Build complete! App is signed."

# ── AMFI gate (2026-08-17, ported from Lite's release pipeline) ──────
# A RESTRICTED entitlement (keychain-access-groups) signed into the app
# without Contents/embedded.provisionprofile = AMFI SIGKILL at launch
# on users' machines (exit 137, empty output; Gatekeeper cannot
# override). This bricked Lite 0.0.63–0.0.70 for auto-updaters.
# preAutoEntitlements is disabled in electron-builder.yml; this gate
# catches ANY regression path (config drift, electron-builder upgrades)
# BEFORE notarization time is burned or an artifact ships.
echo "🔎 AMFI gate: checking signed entitlements vs embedded profile..."
APP_BUNDLE=$(find dist -maxdepth 3 -name "*.app" -type d | head -1)
if [ -z "$APP_BUNDLE" ]; then
    echo "❌ AMFI gate: no .app found under dist/ to inspect"
    exit 1
fi
ENTITLEMENTS=$(codesign -d --entitlements - "$APP_BUNDLE" 2>/dev/null || true)
if echo "$ENTITLEMENTS" | grep -q "keychain-access-groups"; then
    if [ ! -f "$APP_BUNDLE/Contents/embedded.provisionprofile" ]; then
        echo "❌ AMFI gate FAILED: $APP_BUNDLE carries keychain-access-groups"
        echo "   with NO Contents/embedded.provisionprofile. macOS will SIGKILL"
        echo "   this build at launch on users' machines."
        echo "   Fix: keep mac.preAutoEntitlements=false in electron-builder.yml,"
        echo "   or embed a provisioning profile authorizing the keychain group"
        echo "   for THIS bundle id."
        exit 1
    fi
    echo "✅ AMFI gate: entitlement present AND profile embedded — authorized."
else
    echo "✅ AMFI gate: no restricted keychain entitlement — clean."
fi

# Notarize the app manually (unless skipped)
if [ "$SKIP_NOTARIZE" = false ]; then
    echo ""
    echo "🔐 Starting notarization process..."
    node scripts/notarize-manual.js
    
    echo ""
    echo "🎉 Build and notarization complete!"
else
    echo ""
    echo "🎉 Build complete! (Notarization skipped)"
    echo "⚠️  Note: Users will see an 'unidentified developer' warning when installing"
fi

echo "📍 Output files are in the dist/ directory" 