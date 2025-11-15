#!/bin/bash

# ================================================
# Onereach.ai App Certification Script
# ================================================
# This script handles the complete certification 
# process for macOS including code signing and 
# notarization.
# ================================================

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Current version
VERSION=$(node -p "require('./package.json').version")

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}   Onereach.ai Certification Script v${VERSION}   ${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Function to check prerequisites
check_prerequisites() {
    echo -e "${YELLOW}📋 Checking prerequisites...${NC}"
    
    # Check if running on macOS
    if [[ "$OSTYPE" != "darwin"* ]]; then
        echo -e "${RED}❌ This script must be run on macOS${NC}"
        exit 1
    fi
    
    # Check for Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js is not installed${NC}"
        exit 1
    fi
    
    # Check for npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}❌ npm is not installed${NC}"
        exit 1
    fi
    
    # Check if package.json exists
    if [ ! -f "package.json" ]; then
        echo -e "${RED}❌ package.json not found. Run this script from the project root.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Prerequisites check passed${NC}"
}

# Function to setup environment
setup_environment() {
    echo ""
    echo -e "${YELLOW}🔧 Setting up environment...${NC}"
    
    # Check for environment file
    if [ -f ".env.notarization" ]; then
        echo "   Loading environment from .env.notarization"
        source .env.notarization
    fi
    
    # Check for required environment variables
    MISSING_VARS=()
    
    if [ -z "$APPLE_ID" ]; then
        MISSING_VARS+=("APPLE_ID")
    fi
    
    if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
        MISSING_VARS+=("APPLE_APP_SPECIFIC_PASSWORD")
    fi
    
    if [ -z "$APPLE_TEAM_ID" ]; then
        MISSING_VARS+=("APPLE_TEAM_ID")
    fi
    
    # If variables are missing, prompt for them
    if [ ${#MISSING_VARS[@]} -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}⚠️  Missing environment variables. Let's set them up:${NC}"
        echo ""
        
        if [ -z "$APPLE_ID" ]; then
            read -p "Enter your Apple ID (e.g., developer@company.com): " APPLE_ID
            export APPLE_ID
        fi
        
        if [ -z "$APPLE_TEAM_ID" ]; then
            read -p "Enter your Apple Team ID (e.g., 6KTEPA3LSD): " APPLE_TEAM_ID
            export APPLE_TEAM_ID
        fi
        
        if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
            echo "Enter your App-Specific Password (will be hidden):"
            read -s APPLE_APP_SPECIFIC_PASSWORD
            export APPLE_APP_SPECIFIC_PASSWORD
        fi
        
        # Offer to save credentials
        echo ""
        read -p "Save these credentials to .env.notarization for future use? (y/n): " SAVE_CREDS
        if [[ "$SAVE_CREDS" == "y" ]] || [[ "$SAVE_CREDS" == "Y" ]]; then
            cat > .env.notarization << EOF
# Apple Developer Credentials for Notarization
export APPLE_ID="$APPLE_ID"
export APPLE_TEAM_ID="$APPLE_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
EOF
            chmod 600 .env.notarization
            echo -e "${GREEN}✅ Credentials saved to .env.notarization${NC}"
            
            # Add to .gitignore if not already there
            if ! grep -q ".env.notarization" .gitignore 2>/dev/null; then
                echo ".env.notarization" >> .gitignore
                echo "   Added .env.notarization to .gitignore"
            fi
        fi
    else
        echo -e "${GREEN}✅ Environment variables configured${NC}"
    fi
    
    echo "   Apple ID: $APPLE_ID"
    echo "   Team ID: $APPLE_TEAM_ID"
}

# Function to build the app
build_app() {
    echo ""
    echo -e "${YELLOW}📦 Building the application...${NC}"
    
    # Clean previous builds
    echo "   Cleaning previous builds..."
    rm -rf dist/
    
    # Install dependencies
    echo "   Installing dependencies..."
    npm install
    
    # Build the app
    echo "   Running electron-builder..."
    npm run package:mac
    
    echo -e "${GREEN}✅ Build complete${NC}"
}

# Function to sign the app
sign_app() {
    echo ""
    echo -e "${YELLOW}🔏 Code signing...${NC}"
    
    # Check if app was built
    if [ ! -d "dist/mac-arm64/Onereach.ai.app" ]; then
        echo -e "${RED}❌ App not found. Build failed or was not run.${NC}"
        exit 1
    fi
    
    # electron-builder should have already signed the app
    # Verify signing
    echo "   Verifying code signature..."
    if codesign -v -v "dist/mac-arm64/Onereach.ai.app" &>/dev/null; then
        echo -e "${GREEN}✅ App is properly signed${NC}"
    else
        echo -e "${RED}❌ Code signing verification failed${NC}"
        exit 1
    fi
}

# Function to notarize the app
notarize_app() {
    echo ""
    echo -e "${YELLOW}🔐 Notarizing the application...${NC}"
    echo "   This may take 5-15 minutes..."
    
    # Run notarization
    if node scripts/notarize-manual.js; then
        echo -e "${GREEN}✅ Notarization successful${NC}"
    else
        echo -e "${RED}❌ Notarization failed${NC}"
        exit 1
    fi
}

# Function to verify notarization
verify_notarization() {
    echo ""
    echo -e "${YELLOW}🔍 Verifying notarization...${NC}"
    
    # Check with spctl
    if spctl -a -vvv -t install "dist/mac-arm64/Onereach.ai.app" 2>&1 | grep -q "accepted"; then
        echo -e "${GREEN}✅ App is properly notarized and will run without Gatekeeper warnings${NC}"
    else
        echo -e "${YELLOW}⚠️  Notarization verification inconclusive${NC}"
    fi
}

# Function to create release
create_release() {
    echo ""
    echo -e "${YELLOW}📦 Creating release package...${NC}"
    
    # Get file sizes
    DMG_SIZE=$(ls -lh "dist/Onereach.ai-${VERSION}-arm64.dmg" 2>/dev/null | awk '{print $5}')
    ZIP_SIZE=$(ls -lh "dist/Onereach.ai-${VERSION}-arm64-mac.zip" 2>/dev/null | awk '{print $5}')
    
    echo ""
    echo -e "${GREEN}🎉 Certification Complete!${NC}"
    echo ""
    echo "Release artifacts:"
    echo "  📦 DMG: dist/Onereach.ai-${VERSION}-arm64.dmg (${DMG_SIZE:-N/A})"
    echo "  📦 ZIP: dist/Onereach.ai-${VERSION}-arm64-mac.zip (${ZIP_SIZE:-N/A})"
    echo ""
    echo "Next steps:"
    echo "  1. Test the DMG on a different Mac to verify no Gatekeeper warnings"
    echo "  2. Upload to GitHub Releases"
    echo "  3. Update auto-updater if needed"
}

# Main execution
main() {
    # Parse command line arguments
    SKIP_NOTARIZE=false
    QUICK_MODE=false
    
    for arg in "$@"; do
        case $arg in
            --skip-notarize)
                SKIP_NOTARIZE=true
                echo -e "${YELLOW}⚠️  Notarization will be skipped${NC}"
                ;;
            --quick)
                QUICK_MODE=true
                echo -e "${YELLOW}⚡ Quick mode - skipping notarization${NC}"
                SKIP_NOTARIZE=true
                ;;
            --help)
                echo "Usage: ./certify-app.sh [options]"
                echo ""
                echo "Options:"
                echo "  --skip-notarize  Build and sign but skip notarization"
                echo "  --quick         Quick build without notarization"
                echo "  --help          Show this help message"
                echo ""
                echo "Environment variables:"
                echo "  APPLE_ID                    Your Apple Developer ID"
                echo "  APPLE_TEAM_ID               Your Apple Team ID"
                echo "  APPLE_APP_SPECIFIC_PASSWORD App-specific password"
                echo ""
                echo "You can save these in .env.notarization file"
                exit 0
                ;;
        esac
    done
    
    # Run certification steps
    check_prerequisites
    
    if [ "$SKIP_NOTARIZE" = false ]; then
        setup_environment
    fi
    
    build_app
    sign_app
    
    if [ "$SKIP_NOTARIZE" = false ]; then
        notarize_app
        verify_notarization
    else
        echo ""
        echo -e "${YELLOW}⚠️  Skipped notarization - users will see 'unidentified developer' warning${NC}"
    fi
    
    create_release
}

# Run main function
main "$@"
