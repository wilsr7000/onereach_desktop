# Apple Notarization Setup Guide

## Prerequisites

1. **Apple Developer Account** (paid - $99/year)
   - Sign up at: https://developer.apple.com/

2. **App-specific password**
   - Go to: https://appleid.apple.com/account/manage
   - Sign in and navigate to "Security"
   - Under "App-Specific Passwords", click "Generate Password"
   - Name it "Onereach Notarization" and save the password

## Setup Steps

### 1. Create a .env file for local builds:

```bash
# .env (add to .gitignore!)
APPLE_ID=your-apple-id@example.com
APPLE_ID_PASSWORD=xxxx-xxxx-xxxx-xxxx  # App-specific password
APPLE_TEAM_ID=XXXXXXXXXX  # Your 10-character Team ID
```

### 2. Find your Team ID:

1. Go to https://developer.apple.com/account
2. Look for your Team ID in the membership section
3. Or run: `xcrun altool --list-providers -u "your-apple-id@example.com" -p "app-specific-password"`

### 3. Build with notarization:

```bash
# Load environment variables
source .env

# Build and notarize
npm run package:mac
```

### 4. For CI/CD (GitHub Actions example):

Add these secrets to your repository:
- `APPLE_ID`
- `APPLE_ID_PASSWORD`
- `APPLE_TEAM_ID`

## Testing Notarization

After building, check if notarization succeeded:

```bash
# Check notarization status
spctl -a -vvv -t install "dist/Onereach.ai-1.0.3-arm64.dmg"

# Should output:
# dist/Onereach.ai-1.0.3-arm64.dmg: accepted
# source=Notarized Developer ID
```

## Troubleshooting

1. **"Unable to find a valid identity"**
   - Make sure you have a valid Developer ID certificate
   - Run: `security find-identity -v -p codesigning`

2. **"The username or password was incorrect"**
   - Ensure you're using an app-specific password, not your Apple ID password
   - Check that APPLE_TEAM_ID is correct

3. **Notarization takes too long**
   - Normal process takes 5-30 minutes
   - Check status: `xcrun altool --notarization-history 0 -u "apple-id" -p "password"`

## Alternative: Without Paid Developer Account

If you don't have a paid Apple Developer account, users can still install the app by:

1. Right-clicking and selecting "Open"
2. Going to System Preferences → Security & Privacy → "Open Anyway"
3. Running: `xattr -cr /Applications/Onereach.ai.app` in Terminal

However, this creates friction for users and is not recommended for production distribution. 