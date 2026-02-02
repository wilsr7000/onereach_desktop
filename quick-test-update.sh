#!/bin/bash
# Quick script to build and setup local update testing

echo "🔨 Building version 1.0.12..."
echo ""

# Clean old dist
rm -rf dist/*

# Build the new version
npm run package:mac

echo ""
echo "📋 Copying files to test server..."

# Copy the actual build files (with correct checksums!)
cp dist/latest-mac.yml test-update-server/updates/
cp dist/Onereach.ai-1.0.12-arm64-mac.zip test-update-server/updates/
cp dist/Onereach.ai-1.0.12-arm64-mac.zip.blockmap test-update-server/updates/ 2>/dev/null || true

echo ""
echo "✅ Files ready!"
echo ""
echo "📁 Update server has:"
ls -lh test-update-server/updates/
echo ""
echo "🔍 Checksums in latest-mac.yml:"
cat test-update-server/updates/latest-mac.yml
echo ""
echo "🚀 Now run in another terminal:"
echo "   node test-update-server/server.js"
echo ""
echo "Then run your app:"
echo "   npm run dev"




