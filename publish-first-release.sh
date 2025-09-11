#!/bin/bash

# Simple script to publish the first release to Onereach_Desktop_App

echo "🚀 Publishing v1.0.4 to Onereach_Desktop_App..."

# Check if authenticated
if ! gh auth status &>/dev/null; then
    echo "❌ Please authenticate first with: gh auth login"
    exit 1
fi

# Create release on public repository
gh release create "v1.0.4" \
    ./dist/Onereach.ai-1.0.4-arm64.dmg \
    ./dist/Onereach.ai-1.0.4-arm64-mac.zip \
    ./dist/Onereach.ai-1.0.4.dmg \
    ./dist/Onereach.ai-1.0.4-mac.zip \
    ./dist/latest-mac.yml \
    --repo "wilsr7000/Onereach_Desktop_App" \
    --title "Onereach.ai Desktop v1.0.4" \
    --notes "## 🎉 First Public Release!

### ✨ What's New in v1.0.4

**New Features:**
- 📤 **Share Menu** - Easy app sharing from the menu bar
- 🔄 **Auto-Update System** - Get updates automatically from GitHub
- 🐛 **Bug Reporting** - Report issues directly to GitHub with system info
- 🎯 **Better Black Hole Widget** - Fixed lingering UI issues

### 📥 Download Instructions

**For Apple Silicon Macs (M1/M2/M3):**
- Download: \`Onereach.ai-1.0.4-arm64.dmg\`

**For Intel Macs:**
- Download: \`Onereach.ai-1.0.4.dmg\`

### 🚀 Features
- Multiple AI assistants in tabs
- Smart clipboard management with Spaces
- Image and video creation tools
- Audio generation capabilities
- Automatic updates

### 📋 System Requirements
- macOS 10.12 or later
- Apple Silicon (M1/M2/M3) or Intel processor

### 🔄 Auto-Updates
The app will automatically check for updates and notify you when new versions are available.

---
*Onereach.ai - Your AI productivity desktop companion*"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Success! Your first release is published!"
    echo "🔗 View it at: https://github.com/wilsr7000/Onereach_Desktop_App/releases/tag/v1.0.4"
    echo ""
    echo "🎯 What happens now:"
    echo "• Anyone can download your app from the public releases page"
    echo "• All users with the app installed will get update notifications"
    echo "• Future updates: just run 'npm run release'"
else
    echo "❌ Failed to create release"
fi
