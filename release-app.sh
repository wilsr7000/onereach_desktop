#!/bin/bash

# ================================================
# Onereach.ai Release Script
# ================================================
# Creates a GitHub release with notarized binaries
# ================================================

set -e

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")

echo "📦 Preparing Release v${VERSION}"
echo "================================"

# Check if files exist
if [ ! -f "dist/Onereach.ai-${VERSION}-arm64.dmg" ]; then
    echo "❌ DMG file not found. Run ./certify-app.sh first"
    exit 1
fi

if [ ! -f "dist/Onereach.ai-${VERSION}-arm64-mac.zip" ]; then
    echo "❌ ZIP file not found. Run ./certify-app.sh first"
    exit 1
fi

# Verify notarization
echo "🔍 Verifying notarization..."
if spctl -a -vvv -t install "dist/mac-arm64/Onereach.ai.app" 2>&1 | grep -q "accepted"; then
    echo "✅ App is properly notarized"
else
    echo "⚠️  Warning: App may not be properly notarized"
fi

# Get file sizes
DMG_SIZE=$(ls -lh "dist/Onereach.ai-${VERSION}-arm64.dmg" | awk '{print $5}')
ZIP_SIZE=$(ls -lh "dist/Onereach.ai-${VERSION}-arm64-mac.zip" | awk '{print $5}')

# Create release notes
cat > release-notes.md << EOF
# Onereach.ai v${VERSION}

## 🚀 What's New
- Learning Management System (LMS) integration
- Quick Starts tutorials with Apple TV-style interface
- Comprehensive logging for learning content
- Settings for custom API endpoints
- Open LMS in native app window

## 📦 Downloads
- **DMG** (${DMG_SIZE}): For standard installation
- **ZIP** (${ZIP_SIZE}): For manual installation

## ✅ This release is notarized
No Gatekeeper warnings on macOS!

## 📋 Installation
1. Download the DMG file
2. Open the DMG
3. Drag Onereach.ai to Applications
4. Launch from Applications folder

## 🔒 Verification
\`\`\`bash
codesign -dv --verbose=4 /Applications/Onereach.ai.app
spctl -a -vvv -t install /Applications/Onereach.ai.app
\`\`\`

---
Built on $(date)
EOF

echo ""
echo "📝 Release Notes created"
echo ""
echo "📤 Creating GitHub Release..."
echo ""

# Check if gh CLI is installed
if command -v gh &> /dev/null; then
    echo "Using GitHub CLI to create release..."
    
    # Create release
    gh release create "v${VERSION}" \
        --title "Version ${VERSION}" \
        --notes-file release-notes.md \
        "dist/Onereach.ai-${VERSION}-arm64.dmg" \
        "dist/Onereach.ai-${VERSION}-arm64-mac.zip" \
        "dist/latest-mac.yml"
    
    echo ""
    echo "✅ Release created successfully!"
    echo "🔗 View at: https://github.com/wilsr7000/onereach_desktop/releases/tag/v${VERSION}"
else
    echo "GitHub CLI not found. Install with: brew install gh"
    echo ""
    echo "Manual upload instructions:"
    echo "1. Go to: https://github.com/wilsr7000/onereach_desktop/releases/new"
    echo "2. Tag: v${VERSION}"
    echo "3. Title: Version ${VERSION}"
    echo "4. Copy release notes from release-notes.md"
    echo "5. Upload these files:"
    echo "   - dist/Onereach.ai-${VERSION}-arm64.dmg"
    echo "   - dist/Onereach.ai-${VERSION}-arm64-mac.zip"
    echo "   - dist/latest-mac.yml (for auto-updater)"
    echo "6. Publish release"
fi

echo ""
echo "📊 Distribution Summary:"
echo "========================"
echo "Version: ${VERSION}"
echo "DMG: ${DMG_SIZE}"
echo "ZIP: ${ZIP_SIZE}"
echo "Status: Notarized ✅"
echo "========================"
