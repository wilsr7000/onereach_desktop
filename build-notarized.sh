#!/bin/bash
# Set up Apple notarization credentials
export APPLE_ID="robb@onereach.com"
export APPLE_APP_SPECIFIC_PASSWORD="envn-wtyq-qqbp-kiat"  
export APPLE_TEAM_ID="6KTEPA3LSD"

echo "Building with notarization..."
echo "Apple ID: $APPLE_ID"
echo "Team ID: $APPLE_TEAM_ID"
./scripts/build-signed.sh
