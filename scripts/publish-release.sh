#!/bin/bash

# GitHub Release Publisher Script
# This script automates the process of creating a new release

set -e  # Exit on error

echo "🚀 Onereach.ai GitHub Release Publisher"
echo "========================================"
echo ""

# Check if gh CLI is installed and authenticated (silent)
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not installed. Run: brew install gh"
    exit 1
fi
if ! gh api user --silent 2>/dev/null; then
    echo "❌ GitHub CLI not authenticated. Run: gh auth login"
    exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT_VERSION"
echo ""

# Prompt for new version
read -p "Enter new version number (e.g., 1.0.4): " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
    echo "❌ Version number is required"
    exit 1
fi

echo ""
echo "📝 Enter release notes (press Ctrl+D when done):"
RELEASE_NOTES=$(cat)

echo ""
echo "Summary:"
echo "--------"
echo "New Version: $NEW_VERSION"
echo "Release Notes: $RELEASE_NOTES"
echo ""
read -p "Continue with release? (y/n): " CONFIRM

if [ "$CONFIRM" != "y" ]; then
    echo "❌ Release cancelled"
    exit 1
fi

# Update package.json version
echo "📝 Updating package.json version to $NEW_VERSION..."
node -e "
const fs = require('fs');
const pkg = require('./package.json');
pkg.version = '$NEW_VERSION';
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\\n');
"

# Commit version change
echo "📤 Committing version change..."
git add package.json
git commit -m "Release v$NEW_VERSION"
git push origin main

# Build the app
echo "🔨 Building for ARM64 (Apple Silicon)..."
npm run package:mac

echo "🔨 Building for x64 (Intel)..."
npx electron-builder build --mac --x64 --publish never

# Check if all required files exist
echo "✅ Checking build files..."
FILES=(
    "dist/Onereach.ai-${NEW_VERSION}-arm64.dmg"
    "dist/Onereach.ai-${NEW_VERSION}-arm64-mac.zip"
    "dist/Onereach.ai-${NEW_VERSION}.dmg"
    "dist/Onereach.ai-${NEW_VERSION}-mac.zip"
    "dist/latest-mac.yml"
)

for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo "❌ Missing required file: $FILE"
        exit 1
    fi
    echo "✅ Found: $FILE"
done

# Create GitHub release
echo ""
echo "📦 Creating GitHub release v$NEW_VERSION..."
gh release create "v$NEW_VERSION" \
    "${FILES[@]}" \
    --title "Release v$NEW_VERSION" \
    --notes "$RELEASE_NOTES"

echo ""
echo "✅ Release v$NEW_VERSION published successfully!"
echo "🔗 View at: https://github.com/wilsr7000/onereach_desktop/releases/tag/v$NEW_VERSION"
echo ""
echo "Users will automatically receive update notifications!"
