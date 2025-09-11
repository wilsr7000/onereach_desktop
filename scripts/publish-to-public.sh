#!/bin/bash

# This script publishes releases to the PUBLIC repository
# while keeping source code in the PRIVATE repository

PUBLIC_REPO="wilsr7000/Onereach_Desktop_App"
PRIVATE_REPO="wilsr7000/onereach_desktop"

echo "🔒 Publishing release from private to public repository"
echo "=================================================="
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is not installed."
    echo "Install it with: brew install gh"
    echo "Then run: gh auth login"
    exit 1
fi

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "📦 Version: $VERSION"

# Check if release files exist
FILES=(
    "dist/Onereach.ai-${VERSION}-arm64.dmg"
    "dist/Onereach.ai-${VERSION}-arm64-mac.zip"
    "dist/Onereach.ai-${VERSION}.dmg"
    "dist/Onereach.ai-${VERSION}-mac.zip"
    "dist/latest-mac.yml"
)

echo ""
echo "✅ Checking files..."
for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo "❌ Missing: $FILE"
        echo ""
        echo "Please build the app first:"
        echo "  npm run package:mac"
        echo "  npx electron-builder build --mac --x64 --publish never"
        exit 1
    fi
    echo "✅ Found: $(basename $FILE)"
done

echo ""
echo "📤 Creating release on PUBLIC repository..."
echo "Repository: $PUBLIC_REPO"
echo ""

# Check if release already exists
if gh release view "v$VERSION" --repo "$PUBLIC_REPO" &> /dev/null; then
    echo "⚠️  Release v$VERSION already exists in public repo"
    read -p "Delete and recreate it? (y/n): " CONFIRM
    if [ "$CONFIRM" = "y" ]; then
        gh release delete "v$VERSION" --repo "$PUBLIC_REPO" --yes
        echo "Deleted existing release"
    else
        echo "Cancelled"
        exit 1
    fi
fi

# Create release on PUBLIC repo
gh release create "v$VERSION" \
    "${FILES[@]}" \
    --repo "$PUBLIC_REPO" \
    --title "Onereach.ai Desktop v$VERSION" \
    --notes "## Onereach.ai Desktop v$VERSION

### 📥 Download Instructions

**For Apple Silicon Macs (M1/M2/M3):**
- Download: \`Onereach.ai-${VERSION}-arm64.dmg\`

**For Intel Macs:**
- Download: \`Onereach.ai-${VERSION}.dmg\`

### ✨ What's New in v$VERSION
- Enhanced auto-update system
- Bug reporting feature with GitHub integration
- Fixed space selection modal issues
- Improved black hole widget behavior
- Performance improvements and bug fixes

### 🔄 Auto-Updates
The app will automatically check for updates and notify you when a new version is available. You can also manually check via **Help → Check for Updates**.

### 📋 System Requirements
- macOS 10.12 or later
- Apple Silicon (M1/M2/M3) or Intel processor

### 🐛 Bug Reports
Found an issue? Report it through **Help → Report a Bug** in the app menu.

---
*This is a public releases repository. The source code is maintained privately for security.*"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Release v$VERSION published successfully!"
    echo "🔗 Public URL: https://github.com/$PUBLIC_REPO/releases/tag/v$VERSION"
    echo ""
    echo "Users can now:"
    echo "1. Download from the public releases page"
    echo "2. Receive auto-updates in their installed apps"
else
    echo "❌ Failed to create release"
    exit 1
fi
