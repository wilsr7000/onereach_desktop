#!/bin/bash
source .env.notarization
echo "🔄 Testing notarization status..."
echo "   Time: $(date)"
echo "   Account: $APPLE_ID"
echo "   Team: $APPLE_TEAM_ID"
echo ""
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" 2>&1 | head -5
result=$?
if [ $result -eq 0 ]; then
    echo "✅ Account is ready for notarization!"
else
    echo "❌ Still waiting for agreements to propagate..."
    echo "   Try again in 15 minutes"
fi
