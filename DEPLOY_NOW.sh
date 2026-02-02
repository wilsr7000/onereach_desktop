#!/bin/bash

# Quick Deploy Script for Onereach.ai
# This script helps you build and deploy quickly

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     🚀 Onereach.ai Quick Deploy v2.3.0                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Step 1: Check GitHub authentication
echo -e "${YELLOW}Step 1: Checking GitHub authentication...${NC}"
if ! gh auth status &>/dev/null; then
    echo -e "${RED}❌ GitHub CLI is not authenticated${NC}"
    echo ""
    echo "Please run this command in your terminal:"
    echo -e "${BLUE}gh auth login${NC}"
    echo ""
    echo "Then run this script again."
    exit 1
else
    echo -e "${GREEN}✅ GitHub CLI is authenticated${NC}"
fi

# Step 2: Show current status
CURRENT_VERSION=$(node -p "require('./package.json').version")
CURRENT_BRANCH=$(git branch --show-current)

echo ""
echo -e "${BLUE}Current Status:${NC}"
echo "  Version: $CURRENT_VERSION"
echo "  Branch: $CURRENT_BRANCH"
echo ""

# Check for uncommitted changes
if [[ $(git status --porcelain) ]]; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes${NC}"
    git status --short | head -20
    echo ""
    
    read -p "Do you want to commit all changes before building? (y/n): " COMMIT_NOW
    if [ "$COMMIT_NOW" = "y" ]; then
        echo ""
        read -p "Enter commit message: " COMMIT_MSG
        git add -A
        git commit -m "$COMMIT_MSG"
        git push origin $CURRENT_BRANCH
        echo -e "${GREEN}✅ Changes committed and pushed${NC}"
    else
        echo -e "${YELLOW}⚠️  Proceeding with uncommitted changes${NC}"
    fi
fi

# Step 3: Clean and build
echo ""
echo -e "${YELLOW}Step 2: Building application...${NC}"
echo "This will take a few minutes..."
echo ""

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf dist/

# Build for Mac
echo "📦 Building for macOS (ARM64 and x64)..."
npm run package:mac

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Build completed successfully!${NC}"
    echo ""
    echo "Build files created:"
    ls -lh dist/*.dmg dist/*.zip 2>/dev/null | awk '{print "  • " $NF " (" $5 ")"}'
    echo ""
    
    # Step 4: Offer to release
    echo -e "${YELLOW}Step 3: Ready to deploy${NC}"
    echo ""
    echo "Options:"
    echo "1) Create GitHub release (recommended)"
    echo "2) Just test locally"
    echo "3) Run full release script"
    echo ""
    read -p "Choose (1-3): " DEPLOY_CHOICE
    
    case $DEPLOY_CHOICE in
        1)
            echo ""
            echo "To create a GitHub release, run:"
            echo -e "${BLUE}./scripts/publish-to-public.sh${NC}"
            ;;
        2)
            echo ""
            echo "To test locally, install from:"
            echo -e "${BLUE}$(ls dist/*.dmg | head -1)${NC}"
            ;;
        3)
            echo ""
            echo "Running full release script..."
            ./scripts/release-master.sh
            ;;
    esac
else
    echo -e "${RED}❌ Build failed${NC}"
    echo "Check the error messages above"
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Done!${NC}"






