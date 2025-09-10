#!/bin/bash
echo "Setting up notarization credentials in Keychain..."
echo "You'll be prompted for your app-specific password"
echo ""
xcrun notarytool store-credentials "onereach-notarize" \
  --apple-id "robb@onereach.com" \
  --team-id "6KTEPA3LSD"
