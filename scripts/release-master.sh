#!/bin/bash

# ============================================================================
# MASTER RELEASE SCRIPT - One Command Release Automation
# ============================================================================
# This script handles the complete release process:
# 1. Updates version in private repo
# 2. Builds the app for both architectures
# 3. Publishes to public repository
# 4. Ensures all users get auto-updates
# ============================================================================

set -e  # Exit on any error

# Configuration
PRIVATE_REPO="wilsr7000/onereach_desktop"
PUBLIC_REPO="wilsr7000/Onereach_Desktop_App"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🚀 Onereach.ai Master Release Automation 🚀         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ GitHub CLI (gh) is not installed.${NC}"
    echo "Install it with: brew install gh"
    echo "Then run: gh auth login"
    exit 1
fi

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ Not in the Onereach app directory${NC}"
    echo "Please run this script from the project root"
    exit 1
fi

# Check git status
if [[ $(git status --porcelain) ]]; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes:${NC}"
    git status --short
    echo ""
    read -p "Commit these changes as part of the release? (y/n): " COMMIT_CHANGES
    if [ "$COMMIT_CHANGES" != "y" ]; then
        echo -e "${RED}Please commit or stash your changes first${NC}"
        exit 1
    fi
fi

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}✅ Current version: ${CURRENT_VERSION}${NC}"

# Auto-suggest next version
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR=${VERSION_PARTS[0]}
MINOR=${VERSION_PARTS[1]}
PATCH=${VERSION_PARTS[2]}
SUGGESTED_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"

# Prompt for new version
echo ""
echo -e "${BLUE}Select version bump type:${NC}"
echo "1) Patch (${MAJOR}.${MINOR}.$((PATCH + 1))) - Bug fixes"
echo "2) Minor (${MAJOR}.$((MINOR + 1)).0) - New features"
echo "3) Major ($((MAJOR + 1)).0.0) - Breaking changes"
echo "4) Custom version"
echo ""
read -p "Choose (1-4) [1]: " VERSION_CHOICE

case "${VERSION_CHOICE:-1}" in
    1)
        NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
        ;;
    2)
        NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"
        ;;
    3)
        NEW_VERSION="$((MAJOR + 1)).0.0"
        ;;
    4)
        read -p "Enter custom version: " NEW_VERSION
        ;;
    *)
        NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
        ;;
esac

echo -e "${GREEN}✅ New version will be: ${NEW_VERSION}${NC}"

# Generate automatic release notes from git commits
echo ""
echo -e "${BLUE}Generating release notes...${NC}"

# Get commits since last tag or last 10 commits
if git describe --tags --abbrev=0 2>/dev/null; then
    LAST_TAG=$(git describe --tags --abbrev=0)
    COMMITS=$(git log ${LAST_TAG}..HEAD --pretty=format:"- %s" --no-merges)
else
    COMMITS=$(git log -10 --pretty=format:"- %s" --no-merges)
fi

# Create default release notes
DEFAULT_NOTES="## What's New in v${NEW_VERSION}

### 🎯 Highlights"

# Check for specific keywords in recent commits to add relevant notes
if echo "$COMMITS" | grep -qi "fix"; then
    DEFAULT_NOTES+="\n- 🐛 Bug fixes and stability improvements"
fi
if echo "$COMMITS" | grep -qi "add\|feature\|new"; then
    DEFAULT_NOTES+="\n- ✨ New features and enhancements"
fi
if echo "$COMMITS" | grep -qi "update\|improve"; then
    DEFAULT_NOTES+="\n- 🚀 Performance improvements"
fi
if echo "$COMMITS" | grep -qi "security"; then
    DEFAULT_NOTES+="\n- 🔒 Security updates"
fi

DEFAULT_NOTES+="\n\n### 📝 Changes\n${COMMITS}"

echo -e "${GREEN}Generated automatic release notes from recent commits${NC}"
echo ""
echo "Would you like to:"
echo "1) Use auto-generated notes"
echo "2) Add custom notes"
echo "3) View and edit auto-generated notes"
read -p "Choose (1-3) [1]: " NOTES_CHOICE

case "${NOTES_CHOICE:-1}" in
    1)
        RELEASE_NOTES="$DEFAULT_NOTES"
        ;;
    2)
        echo "Enter release notes (press Ctrl+D when done):"
        CUSTOM_NOTES=$(cat)
        RELEASE_NOTES="## What's New in v${NEW_VERSION}\n\n${CUSTOM_NOTES}\n\n### Recent Changes\n${COMMITS}"
        ;;
    3)
        echo -e "$DEFAULT_NOTES"
        echo ""
        echo "Add additional notes (press Ctrl+D when done, or just Ctrl+D to use as-is):"
        ADDITIONAL=$(cat)
        if [ -n "$ADDITIONAL" ]; then
            RELEASE_NOTES="${DEFAULT_NOTES}\n\n### Additional Notes\n${ADDITIONAL}"
        else
            RELEASE_NOTES="$DEFAULT_NOTES"
        fi
        ;;
    *)
        RELEASE_NOTES="$DEFAULT_NOTES"
        ;;
esac

# Summary before proceeding
echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Release Summary:${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "Version: ${YELLOW}${CURRENT_VERSION} → ${NEW_VERSION}${NC}"
echo -e "Private Repo: ${YELLOW}${PRIVATE_REPO}${NC}"
echo -e "Public Repo: ${YELLOW}${PUBLIC_REPO}${NC}"
echo -e "${BLUE}──────────────────────────────────────────────────────────${NC}"
echo ""
read -p "🚀 Ready to create release? (y/n): " CONFIRM

if [ "$CONFIRM" != "y" ]; then
    echo -e "${RED}❌ Release cancelled${NC}"
    exit 1
fi

# Step 1: Update version in package.json
echo ""
echo -e "${YELLOW}Step 1/6: Updating package.json version...${NC}"
node -e "
const fs = require('fs');
const pkg = require('./package.json');
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\\n');
console.log('✅ Updated package.json to version ${NEW_VERSION}');
"

# Step 2: Commit and push to private repository
echo ""
echo -e "${YELLOW}Step 2/6: Committing to private repository...${NC}"

# Add all changes if user chose to commit them earlier
if [ "$COMMIT_CHANGES" = "y" ]; then
    git add -A
    git commit -m "Release v${NEW_VERSION}

${RELEASE_NOTES}"
else
    git add package.json
    git commit -m "Release v${NEW_VERSION}"
fi

git push origin main
echo -e "${GREEN}✅ Pushed to private repository${NC}"

# Step 3: Clean previous builds
echo ""
echo -e "${YELLOW}Step 3/6: Cleaning previous builds...${NC}"
rm -rf dist/mac dist/mac-arm64 dist/linux-unpacked dist/win-unpacked 2>/dev/null || true
echo -e "${GREEN}✅ Cleaned build directories${NC}"

# Step 4: Build for ARM64 (Apple Silicon)
echo ""
echo -e "${YELLOW}Step 4/6: Building for Apple Silicon (ARM64)...${NC}"
npm run package:mac
echo -e "${GREEN}✅ ARM64 build complete${NC}"

# Step 5: Build for x64 (Intel)
echo ""
echo -e "${YELLOW}Step 5/6: Building for Intel (x64)...${NC}"
npx electron-builder build --mac --x64 --publish never
echo -e "${GREEN}✅ x64 build complete${NC}"

# Step 6: Verify all required files
echo ""
echo -e "${YELLOW}Step 6/6: Publishing to public repository...${NC}"

FILES=(
    "dist/Onereach.ai-${NEW_VERSION}-arm64.dmg"
    "dist/Onereach.ai-${NEW_VERSION}-arm64-mac.zip"
    "dist/Onereach.ai-${NEW_VERSION}.dmg"
    "dist/Onereach.ai-${NEW_VERSION}-mac.zip"
    "dist/latest-mac.yml"
)

echo "Verifying build files..."
ALL_FILES_EXIST=true
for FILE in "${FILES[@]}"; do
    if [ ! -f "$FILE" ]; then
        echo -e "${RED}❌ Missing: $FILE${NC}"
        ALL_FILES_EXIST=false
    else
        SIZE=$(du -h "$FILE" | cut -f1)
        echo -e "${GREEN}✅ Found: $(basename $FILE) ($SIZE)${NC}"
    fi
done

if [ "$ALL_FILES_EXIST" = false ]; then
    echo -e "${RED}❌ Build failed - missing files${NC}"
    exit 1
fi

# Check if public repo exists (this will fail if repo doesn't exist or is private)
echo ""
echo "Checking public repository..."
if ! gh repo view "$PUBLIC_REPO" --json name &>/dev/null; then
    echo -e "${YELLOW}⚠️  Public repository not found or not accessible${NC}"
    echo ""
    echo "Please create a PUBLIC repository at:"
    echo -e "${BLUE}https://github.com/new${NC}"
    echo ""
    echo "Repository name: onereach-desktop-releases"
    echo "Make sure it's PUBLIC ✅"
    echo ""
    read -p "Have you created the public repository? (y/n): " REPO_CREATED
    if [ "$REPO_CREATED" != "y" ]; then
        echo -e "${RED}Please create the public repository first${NC}"
        exit 1
    fi
fi

# Check if release already exists and delete if needed
if gh release view "v${NEW_VERSION}" --repo "$PUBLIC_REPO" &>/dev/null; then
    echo -e "${YELLOW}⚠️  Release v${NEW_VERSION} already exists${NC}"
    read -p "Delete and recreate? (y/n): " DELETE_EXISTING
    if [ "$DELETE_EXISTING" = "y" ]; then
        gh release delete "v${NEW_VERSION}" --repo "$PUBLIC_REPO" --yes
        echo "Deleted existing release"
    else
        echo "Skipping public release"
        exit 1
    fi
fi

# Create release on public repository
echo ""
echo "Creating release on public repository..."

# Format release notes for public
PUBLIC_NOTES="# Onereach.ai Desktop v${NEW_VERSION}

## 📥 Download Instructions

**For Apple Silicon Macs (M1/M2/M3):**
Download: \`Onereach.ai-${NEW_VERSION}-arm64.dmg\`

**For Intel Macs:**
Download: \`Onereach.ai-${NEW_VERSION}.dmg\`

${RELEASE_NOTES}

## 🔄 Auto-Updates
If you have a previous version installed, you'll automatically receive an update notification. Simply click \"Download Update\" when prompted.

## 📋 System Requirements
- macOS 10.12 or later
- Apple Silicon (M1/M2/M3) or Intel processor

## 🐛 Found a Bug?
Report issues through **Help → Report a Bug** in the app menu.

---
*This is the official releases repository. The app will automatically check here for updates.*"

gh release create "v${NEW_VERSION}" \
    "${FILES[@]}" \
    --repo "$PUBLIC_REPO" \
    --title "v${NEW_VERSION}" \
    --notes "$PUBLIC_NOTES"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║            🎉 RELEASE SUCCESSFUL! 🎉                    ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${GREEN}✅ Version ${NEW_VERSION} has been released!${NC}"
    echo ""
    echo -e "${BLUE}What happened:${NC}"
    echo "1. ✅ Updated version in package.json"
    echo "2. ✅ Committed and pushed to private repo"
    echo "3. ✅ Built apps for both architectures"
    echo "4. ✅ Published to public repository"
    echo "5. ✅ Auto-updater configured"
    echo ""
    echo -e "${BLUE}Public Release URL:${NC}"
    echo -e "${YELLOW}https://github.com/${PUBLIC_REPO}/releases/tag/v${NEW_VERSION}${NC}"
    echo ""
    echo -e "${BLUE}What happens next:${NC}"
    echo "• All existing users will see an update notification"
    echo "• New users can download from the public release page"
    echo "• Updates install automatically on app restart"
    echo ""
    echo -e "${GREEN}🚀 Your users are getting the update now!${NC}"
else
    echo -e "${RED}❌ Failed to create public release${NC}"
    echo "You can try manually with:"
    echo "./scripts/publish-to-public.sh"
    exit 1
fi
