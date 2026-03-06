#!/bin/bash
# Notarization Setup Script
# Configures environment variables for Apple notarization.
# Run: source setup-notarization.sh

echo "Setting up notarization environment variables..."
echo ""
echo "Add these to your ~/.zshrc (replace with your actual values):"
echo ""
echo '  export APPLE_ID="your-apple-id@email.com"'
echo '  export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"'
echo '  export APPLE_TEAM_ID="YOUR_TEAM_ID"'
echo ""
echo "Then run: source ~/.zshrc"
echo ""

if [ -z "$APPLE_ID" ]; then
  echo "WARNING: APPLE_ID is not set. Notarization will not work."
else
  echo "APPLE_ID: $APPLE_ID"
  echo "APPLE_TEAM_ID: ${APPLE_TEAM_ID:-NOT SET}"
  echo "APPLE_APP_SPECIFIC_PASSWORD: ${APPLE_APP_SPECIFIC_PASSWORD:+[set]}"
fi
