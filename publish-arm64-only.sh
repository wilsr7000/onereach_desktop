#!/bin/bash

# Quick publish script for ARM64 build only

set -e

PUBLIC_REPO="wilsr7000/Onereach_Desktop_App"

echo "🚀 Publishing Onereach.ai v2.2.0 (ARM64 only)"
echo "=================================================="
echo ""

# Check if gh CLI is installed and authenticated
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is not installed."
    echo "Install it with: brew install gh"
    exit 1
fi

# Check authentication
if ! gh auth status &> /dev/null; then
    echo "❌ Not authenticated with GitHub"
    echo "Run: gh auth login"
    exit 1
fi

# Get version
VERSION=$(node -p "require('./package.json').version")
echo "📦 Version: $VERSION"

# Check files
FILES=(
    "dist/Onereach.ai-${VERSION}-arm64.dmg"
    "dist/Onereach.ai-${VERSION}-arm64-mac.zip"
    "dist/Onereach.ai-${VERSION}-arm64.dmg.blockmap"
    "dist/Onereach.ai-${VERSION}-arm64-mac.zip.blockmap"
    "dist/latest-mac.yml"
)

echo ""
echo "✅ Checking build files..."
ALL_GOOD=true
for FILE in "${FILES[@]}"; do
    if [ -f "$FILE" ]; then
        SIZE=$(du -h "$FILE" | cut -f1)
        echo "  ✅ $(basename $FILE) ($SIZE)"
    else
        echo "  ❌ Missing: $(basename $FILE)"
        ALL_GOOD=false
    fi
done

if [ "$ALL_GOOD" = false ]; then
    echo ""
    echo "❌ Some files are missing. Build first with:"
    echo "   npm run package:mac"
    exit 1
fi

echo ""
echo "📤 Publishing to: $PUBLIC_REPO"
echo ""

# Check if release exists
if gh release view "v$VERSION" --repo "$PUBLIC_REPO" &> /dev/null; then
    echo "⚠️  Release v$VERSION already exists"
    read -p "Delete and recreate? (y/n): " CONFIRM
    if [ "$CONFIRM" != "y" ]; then
        echo "Cancelled"
        exit 0
    fi
    gh release delete "v$VERSION" --repo "$PUBLIC_REPO" --yes
    echo "Deleted existing release"
fi

# Create release notes
RELEASE_NOTES="## Onereach.ai Desktop v$VERSION

### 📥 Download

**For Apple Silicon Macs (M1/M2/M3/M4):**
- Download: \`Onereach.ai-${VERSION}-arm64.dmg\`

> Intel Mac builds available on request.

### ✨ What's New in v$VERSION

#### New Features
- 🎬 **Video Editor**: Built-in video editing capabilities with scene detection and trimming
- ⬇️ **YouTube Downloader**: Download videos directly from the app
- 🎭 **Agentic Player**: Enhanced AI interaction capabilities
- 🧪 **Improved Testing**: Better test automation and reliability

#### Updates
- 📋 Enhanced clipboard management and storage
- 🖥️ Improved browser rendering
- 📊 Better event logging and tracking
- ⚙️ Refined settings management
- 💰 Enhanced cost tracking
- 🔗 Flipboard IDW feed improvements

#### Bug Fixes & Improvements
- Fixed black hole widget behavior
- Improved window management
- Enhanced preload script performance
- Menu system updates
- Overall stability and performance improvements

### 🔄 Auto-Updates

The app automatically checks for updates. You can also manually check via:
**Help → Check for Updates** in the menu.

### 📋 System Requirements
- macOS 10.12 or later
- Apple Silicon (M1/M2/M3/M4) processor
- ~200 MB disk space

### 🐛 Bug Reports
Found an issue? Report it through **Help → Report a Bug** in the app menu.

---
*Released: $(date '+%B %d, %Y')*  
*This is the official public releases repository.*"

# Create release
echo "Creating GitHub release..."
gh release create "v$VERSION" \
    "${FILES[@]}" \
    --repo "$PUBLIC_REPO" \
    --title "Onereach.ai Desktop v$VERSION" \
    --notes "$RELEASE_NOTES"

if [ $? -eq 0 ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║            ✅ RELEASE PUBLISHED! ✅                      ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "🎉 Version $VERSION is now live!"
    echo ""
    echo "🔗 Release URL:"
    echo "   https://github.com/$PUBLIC_REPO/releases/tag/v$VERSION"
    echo ""
    echo "📥 Direct download:"
    echo "   https://github.com/$PUBLIC_REPO/releases/download/v$VERSION/Onereach.ai-${VERSION}-arm64.dmg"
    echo ""
    echo "✨ Auto-update enabled for all users!"
    echo ""
else
    echo "❌ Failed to create release"
    exit 1
fi












































