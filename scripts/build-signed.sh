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