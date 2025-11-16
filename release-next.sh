#!/bin/bash

# ================================================
# Onereach.ai Complete Release Script
# ================================================
# This script handles the entire release process:
# - Version bumping
# - Building & notarization
# - GitHub release with auto-update files
# ================================================

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to show header
show_header() {
    echo ""
    echo -e "${BLUE}================================================${NC}"
    echo -e "${BLUE}   Onereach.ai Release Manager${NC}"
    echo -e "${BLUE}================================================${NC}"
    echo ""
}

# Function to show menu
show_menu() {
    echo -e "${YELLOW}Choose release type:${NC}"
    echo ""
    echo "  1) Patch Release (1.6.7 → 1.6.8)"
    echo "     Bug fixes and minor updates"
    echo ""
    echo "  2) Minor Release (1.6.7 → 1.7.0)"
    echo "     New features and improvements"
    echo ""
    echo "  3) Major Release (1.6.7 → 2.0.0)"
    echo "     Breaking changes or major redesign"
    echo ""
    echo "  4) Custom Version"
    echo "     Specify exact version number"
    echo ""
    echo "  0) Cancel"
    echo ""
}

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")

show_header
echo -e "${CYAN}Current Version: ${CURRENT_VERSION}${NC}"
echo ""

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes${NC}"
    echo ""
    read -p "Commit them first? (y/n): " COMMIT_FIRST
    if [[ "$COMMIT_FIRST" == "y" ]] || [[ "$COMMIT_FIRST" == "Y" ]]; then
        read -p "Enter commit message: " COMMIT_MSG
        git add -A
        git commit -m "$COMMIT_MSG"
        git push
        echo -e "${GREEN}✅ Changes committed${NC}"
    else
        echo -e "${RED}❌ Please commit changes before releasing${NC}"
        exit 1
    fi
fi

# Show menu and get choice
show_menu
read -p "Select option (0-4): " RELEASE_TYPE

case $RELEASE_TYPE in
    1)
        NEW_VERSION=$(npm version patch --no-git-tag-version | sed 's/v//')
        RELEASE_NOTES="Bug fixes and improvements"
        ;;
    2)
        NEW_VERSION=$(npm version minor --no-git-tag-version | sed 's/v//')
        RELEASE_NOTES="New features and improvements"
        ;;
    3)
        NEW_VERSION=$(npm version major --no-git-tag-version | sed 's/v//')
        RELEASE_NOTES="Major update with significant changes"
        ;;
    4)
        read -p "Enter new version (e.g., 1.7.0): " NEW_VERSION
        # Update package.json with custom version
        npm version $NEW_VERSION --no-git-tag-version > /dev/null
        RELEASE_NOTES="Custom release"
        ;;
    0)
        echo "Release cancelled"
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid option${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}✨ Preparing release v${NEW_VERSION}${NC}"
echo ""

# Ask for release notes
echo -e "${YELLOW}Enter release notes (or press Enter for default):${NC}"
read -p "> " CUSTOM_NOTES
if [ ! -z "$CUSTOM_NOTES" ]; then
    RELEASE_NOTES="$CUSTOM_NOTES"
fi

# Step 1: Commit version bump
echo ""
echo -e "${CYAN}Step 1: Committing version bump...${NC}"
git add package.json package-lock.json
git commit -m "Bump version to ${NEW_VERSION}

$RELEASE_NOTES"
git push

# Step 2: Build and certify
echo ""
echo -e "${CYAN}Step 2: Building and notarizing...${NC}"
echo ""

# Check if credentials exist
if [ ! -f ".env.notarization" ]; then
    echo -e "${YELLOW}⚠️  Notarization credentials not found${NC}"
    echo "Running certification script to set them up..."
    ./certify-app.sh
else
    # Load credentials and run certification
    source .env.notarization
    echo "✅ Credentials loaded"
    echo ""
    
    # Clean and build
    echo "🧹 Cleaning previous builds..."
    rm -rf dist/
    
    echo "📦 Building application..."
    npm run package:mac
    
    echo ""
    echo "🔐 Notarizing application..."
    node scripts/notarize-manual.js
fi

# Step 3: Verify build files exist
echo ""
echo -e "${CYAN}Step 3: Verifying release files...${NC}"

DMG_FILE="dist/Onereach.ai-${NEW_VERSION}-arm64.dmg"
ZIP_FILE="dist/Onereach.ai-${NEW_VERSION}-arm64-mac.zip"
YAML_FILE="dist/latest-mac.yml"
BLOCKMAP_FILE="dist/Onereach.ai-${NEW_VERSION}-arm64.dmg.blockmap"

MISSING_FILES=()
[ ! -f "$DMG_FILE" ] && MISSING_FILES+=("DMG")
[ ! -f "$ZIP_FILE" ] && MISSING_FILES+=("ZIP")
[ ! -f "$YAML_FILE" ] && MISSING_FILES+=("latest-mac.yml")
[ ! -f "$BLOCKMAP_FILE" ] && MISSING_FILES+=("blockmap")

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo -e "${RED}❌ Missing files: ${MISSING_FILES[*]}${NC}"
    exit 1
fi

echo -e "${GREEN}✅ All release files present${NC}"
ls -lh dist/*.dmg dist/*.zip dist/*.yml dist/*.blockmap 2>/dev/null | awk '{print "   • " $NF " (" $5 ")"}'

# Step 4: Create detailed release notes
echo ""
echo -e "${CYAN}Step 4: Creating release notes...${NC}"

# Get list of commits since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ ! -z "$LAST_TAG" ]; then
    COMMITS=$(git log $LAST_TAG..HEAD --pretty=format:"- %s" --no-merges)
else
    COMMITS=$(git log HEAD~10..HEAD --pretty=format:"- %s" --no-merges)
fi

cat > release-notes-${NEW_VERSION}.md << EOF
# Onereach.ai v${NEW_VERSION}

## 📝 Release Notes
${RELEASE_NOTES}

## 🚀 What's Changed
${COMMITS}

## 📦 Installation

### New Users
1. Download **Onereach.ai-${NEW_VERSION}-arm64.dmg**
2. Open the DMG file
3. Drag Onereach.ai to Applications
4. Launch from Applications folder

### Existing Users  
**Auto-update is available!** You should receive an update notification.
Or manually check: Menu → Onereach.ai → Check for Updates

## ✅ Verification
This release is notarized by Apple. No Gatekeeper warnings!

To verify:
\`\`\`bash
spctl -a -vvv -t install /Applications/Onereach.ai.app
\`\`\`

## 📊 File Information
- **DMG**: $(ls -lh $DMG_FILE | awk '{print $5}')
- **ZIP**: $(ls -lh $ZIP_FILE | awk '{print $5}')
- **Platform**: macOS (Apple Silicon)
- **Minimum macOS**: 10.12

---
Released on $(date '+%B %d, %Y')
EOF

echo -e "${GREEN}✅ Release notes created${NC}"

# Step 5: Create GitHub release
echo ""
echo -e "${CYAN}Step 5: Creating GitHub release...${NC}"
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${YELLOW}GitHub CLI not installed${NC}"
    echo "Install with: brew install gh"
    echo ""
    echo "Manual release instructions:"
    echo "1. Go to: https://github.com/wilsr7000/onereach_desktop/releases/new"
    echo "2. Tag: v${NEW_VERSION}"
    echo "3. Title: Version ${NEW_VERSION}"
    echo "4. Upload ALL these files:"
    echo "   • $DMG_FILE"
    echo "   • $ZIP_FILE"
    echo "   • $YAML_FILE (⚠️ REQUIRED for auto-update)"
    echo "   • $BLOCKMAP_FILE"
    echo "5. Paste release notes from: release-notes-${NEW_VERSION}.md"
    echo "6. Click 'Publish release'"
    exit 0
fi

# Create release with gh CLI
echo "Creating GitHub release with auto-update files..."

gh release create "v${NEW_VERSION}" \
    --title "Version ${NEW_VERSION}" \
    --notes-file "release-notes-${NEW_VERSION}.md" \
    "$DMG_FILE" \
    "$ZIP_FILE" \
    "$YAML_FILE" \
    "$BLOCKMAP_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 SUCCESS! Release v${NEW_VERSION} is live!${NC}"
    echo ""
    echo -e "${BLUE}================================================${NC}"
    echo -e "${GREEN}✅ Release Summary${NC}"
    echo -e "${BLUE}================================================${NC}"
    echo ""
    echo "📌 Version: ${CURRENT_VERSION} → ${NEW_VERSION}"
    echo "🔗 Release URL: https://github.com/wilsr7000/onereach_desktop/releases/tag/v${NEW_VERSION}"
    echo "📥 Direct download: https://github.com/wilsr7000/onereach_desktop/releases/download/v${NEW_VERSION}/Onereach.ai-${NEW_VERSION}-arm64.dmg"
    echo ""
    echo "✨ Auto-update enabled:"
    echo "   • Users on 1.6.7+ will get update notifications"
    echo "   • latest-mac.yml uploaded for update checking"
    echo ""
    echo "🔒 Security:"
    echo "   • Fully notarized by Apple"
    echo "   • No Gatekeeper warnings"
    echo ""
    echo -e "${BLUE}================================================${NC}"
    
    # Cleanup
    echo ""
    read -p "Clean up build files? (y/n): " CLEANUP
    if [[ "$CLEANUP" == "y" ]] || [[ "$CLEANUP" == "Y" ]]; then
        rm -rf dist/
        rm -f release-notes-${NEW_VERSION}.md
        echo -e "${GREEN}✅ Cleanup complete${NC}"
    fi
else
    echo -e "${RED}❌ Failed to create GitHub release${NC}"
    echo "Files are ready in dist/ - create release manually"
fi

echo ""
echo "🎯 Next steps:"
echo "   1. Announce the release to your team"
echo "   2. Monitor for any user issues"
echo "   3. Check download statistics on GitHub"
echo ""
echo "Thank you for using Onereach.ai Release Manager! 🚀"
