#!/bin/bash
# Local Auto-Update Testing Script
# This script helps you test auto-update functionality locally

set -e  # Exit on error

echo "=================================="
echo "🧪 Local Auto-Update Testing"
echo "=================================="
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${BLUE}📦 Current Version:${NC} $CURRENT_VERSION"
echo ""

# Step 1: Configure dev-app-update.yml for local testing
echo -e "${YELLOW}Step 1:${NC} Configuring dev-app-update.yml for local testing..."
cat > dev-app-update.yml << 'EOF'
# owner: OneReachAI
# repo: desktop-app
# provider: github
# For local testing:
provider: generic
url: http://localhost:8080/
EOF
echo -e "${GREEN}✓${NC} Configured for local server"
echo ""

# Step 2: Build the app
echo -e "${YELLOW}Step 2:${NC} Building the app (this may take a few minutes)..."
npm run package:mac
echo -e "${GREEN}✓${NC} Build complete"
echo ""

# Step 3: Copy files to test server
echo -e "${YELLOW}Step 3:${NC} Copying update files to test server..."
mkdir -p test-update-server/updates

if [ -f "dist/latest-mac.yml" ]; then
  cp dist/latest-mac.yml test-update-server/updates/
  echo -e "${GREEN}✓${NC} Copied latest-mac.yml"
else
  echo -e "${YELLOW}⚠${NC} Warning: latest-mac.yml not found"
fi

# Find the .zip file (could be arm64 or x64)
ZIP_FILE=$(find dist -name "*.zip" -type f | head -n 1)
if [ -n "$ZIP_FILE" ]; then
  cp "$ZIP_FILE" test-update-server/updates/
  echo -e "${GREEN}✓${NC} Copied $(basename "$ZIP_FILE")"
  
  # Copy blockmap if exists
  if [ -f "${ZIP_FILE}.blockmap" ]; then
    cp "${ZIP_FILE}.blockmap" test-update-server/updates/
    echo -e "${GREEN}✓${NC} Copied $(basename "${ZIP_FILE}.blockmap")"
  fi
else
  echo -e "${YELLOW}⚠${NC} Warning: No .zip file found in dist/"
fi

echo ""

# Step 4: Show what's ready
echo "=================================="
echo -e "${GREEN}✓ Ready for Testing!${NC}"
echo "=================================="
echo ""
echo "📁 Update files prepared:"
ls -lh test-update-server/updates/ | tail -n +2 | awk '{printf "  - %s (%s)\n", $9, $5}'
echo ""

echo "🚀 Next steps:"
echo ""
echo "1️⃣  Start the update server (in a new terminal):"
echo -e "   ${BLUE}node test-update-server/server.js${NC}"
echo ""
echo "2️⃣  Run your app in dev mode (in another terminal):"
echo -e "   ${BLUE}npm run dev${NC}"
echo ""
echo "3️⃣  Your app should detect the update and show a notification!"
echo ""
echo "💡 Tips:"
echo "   - The app will show 'Update Available' if it detects v${CURRENT_VERSION}"
echo "   - Click 'Download' to test the download process"
echo "   - The update will install when you restart the app"
echo ""
echo "🔄 To restore GitHub updates:"
echo -e "   ${BLUE}git checkout dev-app-update.yml${NC}"
echo ""

# Ask if user wants to start the server now
read -p "Start the update server now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo "Starting update server..."
  echo "Press Ctrl+C to stop the server when done testing"
  echo ""
  node test-update-server/server.js
fi




