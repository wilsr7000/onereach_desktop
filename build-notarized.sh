#!/bin/bash
# Build with notarization
# Requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID in environment.
# See NOTARIZATION-SETUP.md for configuration instructions.

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] || [ -z "$APPLE_TEAM_ID" ]; then
  echo "ERROR: Missing notarization credentials."
  echo "Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID in your environment."
  echo "See NOTARIZATION-SETUP.md for details."
  exit 1
fi

echo "Building with notarization..."
echo "Apple ID: $APPLE_ID"
echo "Team ID: $APPLE_TEAM_ID"
./scripts/build-signed.sh
