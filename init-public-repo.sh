#!/bin/bash

echo "📝 Initializing public repository with README..."

# Create a temporary directory for the public repo
TEMP_DIR="/tmp/onereach_public_init"
rm -rf $TEMP_DIR
mkdir -p $TEMP_DIR
cd $TEMP_DIR

# Clone the empty public repository
git clone https://github.com/wilsr7000/Onereach_Desktop_App.git
cd Onereach_Desktop_App

# Create README
cat > README.md << 'EOF'
# Onereach.ai Desktop

A powerful desktop app for AI productivity, featuring multiple AI assistants, smart clipboard management, and creative tools.

## 📥 Download

Download the latest version from the [Releases](https://github.com/wilsr7000/Onereach_Desktop_App/releases) page.

### For Apple Silicon Macs (M1/M2/M3)
Download the `-arm64.dmg` file

### For Intel Macs
Download the standard `.dmg` file

## ✨ Features

- 🤖 **Multiple AI Assistants** - Access ChatGPT, Claude, Gemini, and more in tabs
- 📋 **Smart Clipboard** - Organize content with Spaces
- 🎨 **Creative Tools** - Image and video generation
- 🔄 **Auto-Updates** - Stay current automatically
- 🚀 **Fast & Native** - Built with Electron for macOS

## 📋 System Requirements

- macOS 10.12 or later
- Apple Silicon or Intel processor

## 🔄 Auto-Updates

The app automatically checks for updates and notifies you when new versions are available.

## 🐛 Support

Found an issue? Use **Help → Report a Bug** in the app menu.

---

© 2024 Onereach.ai - All rights reserved
EOF

# Commit and push
git add README.md
git commit -m "Initial commit - Add README"
git push origin main

echo "✅ Repository initialized!"
cd /Users/richardwilson/Onereach_app
