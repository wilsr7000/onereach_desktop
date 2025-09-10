#!/bin/bash

# Notarization Setup Script
# Replace YOUR_APPLE_ID with your actual Apple Developer email

echo "Setting up notarization environment variables..."

# Set environment variables
export APPLE_ID="robb@onereach.com"
export APPLE_APP_SPECIFIC_PASSWORD="tozd-zoeq-llgi-tste"
export APPLE_TEAM_ID="6KTEPA3LSD"

echo "✅ Environment variables set:"
echo "   APPLE_ID: $APPLE_ID"
echo "   APPLE_TEAM_ID: $APPLE_TEAM_ID"
echo "   APPLE_APP_SPECIFIC_PASSWORD: [hidden]"

echo ""
echo "To make these permanent, add them to your ~/.zshrc file:"
echo "  echo 'export APPLE_ID=\"$APPLE_ID\"' >> ~/.zshrc"
echo "  echo 'export APPLE_APP_SPECIFIC_PASSWORD=\"$APPLE_APP_SPECIFIC_PASSWORD\"' >> ~/.zshrc"
echo "  echo 'export APPLE_TEAM_ID=\"$APPLE_TEAM_ID\"' >> ~/.zshrc"
echo ""
echo "Then reload your shell: source ~/.zshrc"
echo ""
echo "Ready to build? Run: ./scripts/build-signed.sh" 