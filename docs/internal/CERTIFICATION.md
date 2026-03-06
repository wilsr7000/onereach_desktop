# Onereach.ai App Certification Guide

## Overview

This guide explains how to certify (code sign and notarize) the Onereach.ai macOS application to ensure users don't see Gatekeeper warnings when installing.

## Quick Start

```bash
# Full certification (signing + notarization)
./certify-app.sh

# Quick build (signing only, skip notarization)
./certify-app.sh --quick
```

## Prerequisites

### 1. Apple Developer Account
- Active Apple Developer Program membership ($99/year)
- Access to App Store Connect

### 2. Certificates
- Valid Developer ID Application certificate
- Valid Developer ID Installer certificate (optional, for pkg)

### 3. App-Specific Password
1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in and go to "Sign-In and Security"
3. Click "App-Specific Passwords"
4. Generate a new password for "Onereach Notarization"
5. Save this password securely

### 4. Team ID
Find your Team ID in Apple Developer portal:
1. Go to [developer.apple.com](https://developer.apple.com)
2. Click Account
3. Look for Team ID in Membership details

## Setup

### Method 1: Interactive Setup
Run the certification script and it will prompt for credentials:
```bash
./certify-app.sh
```

### Method 2: Environment File
Create `.env.notarization` file:
```bash
# Apple Developer Credentials
export APPLE_ID="your-email@company.com"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

### Method 3: Environment Variables
```bash
export APPLE_ID="your-email@company.com"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
./certify-app.sh
```

## Certification Process

### 1. **Code Signing** ✍️
- Automatically handled by electron-builder
- Uses Developer ID Application certificate
- Signs all binaries and frameworks
- Adds secure timestamp

### 2. **Notarization** 🔐
- Uploads app to Apple for verification
- Apple checks for malware and code issues
- Takes 5-15 minutes typically
- Returns ticket that's stapled to app

### 3. **Stapling** 📌
- Attaches notarization ticket to app
- Allows offline Gatekeeper verification
- Ensures smooth installation experience

## Scripts Available

### Main Certification Script
```bash
./certify-app.sh [options]

Options:
  --skip-notarize  # Build and sign but skip notarization
  --quick         # Quick build without notarization
  --help          # Show help message
```

### Individual Scripts
```bash
# Build only
npm run package:mac

# Build with signing
npm run build:signed

# Build signed, skip notarization  
npm run build:signed:skip-notarize

# Manual notarization (after build)
node scripts/notarize-manual.js

# Full release
npm run release
```

## Troubleshooting

### Common Issues

#### 1. "Unable to notarize - invalid credentials"
- Verify Apple ID is correct
- Check app-specific password (not your Apple ID password!)
- Ensure Team ID matches your developer account

#### 2. "The signature of the binary is invalid"
- Certificate may be expired or revoked
- Check Keychain Access for valid Developer ID certificate
- May need to re-download from Apple Developer portal

#### 3. "Notarization in progress" hangs
- Apple's service might be slow (can take up to 1 hour)
- Check Apple System Status: https://developer.apple.com/system-status/
- Can check status manually:
```bash
xcrun notarytool history --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID
```

#### 4. "This app is damaged and can't be opened"
- Notarization failed or wasn't completed
- Download may be corrupted
- Try re-notarizing with latest Xcode tools

### Verify Certification

#### Check Code Signing:
```bash
codesign -dv --verbose=4 "dist/mac-arm64/Onereach.ai.app"
```

#### Check Notarization:
```bash
spctl -a -vvv -t install "dist/mac-arm64/Onereach.ai.app"
```

Should show: `accepted source=Notarized Developer ID`

#### Check Gatekeeper:
```bash
# Reset Gatekeeper assessment
sudo xattr -r -d com.apple.quarantine "dist/mac-arm64/Onereach.ai.app"
# Test as if downloaded
sudo xattr -r -c "dist/mac-arm64/Onereach.ai.app"
sudo xattr -r -w com.apple.quarantine "dist/mac-arm64/Onereach.ai.app"
# Try to open
open "dist/mac-arm64/Onereach.ai.app"
```

## Release Process

### 1. Increment Version
```bash
# Edit package.json version
npm version patch  # or minor/major
```

### 2. Build and Certify
```bash
./certify-app.sh
```

### 3. Test Installation
1. Copy DMG to another Mac
2. Open DMG and drag to Applications
3. Verify no Gatekeeper warnings
4. Test app functionality

### 4. Create GitHub Release
```bash
# Manually upload via GitHub UI
# Or use GitHub CLI:
gh release create v1.6.6 \
  --title "Version 1.6.6" \
  --notes "Release notes here" \
  dist/Onereach.ai-1.6.6-arm64.dmg \
  dist/Onereach.ai-1.6.6-arm64-mac.zip
```

### 5. Update Auto-Updater
- Upload `latest-mac.yml` to release
- Update release notes
- Test auto-update from previous version

## Security Best Practices

### DO:
- ✅ Keep credentials in `.env.notarization` (gitignored)
- ✅ Use app-specific passwords, never main Apple ID password
- ✅ Rotate app-specific passwords periodically
- ✅ Test on clean Mac before releasing
- ✅ Keep Developer certificates up to date

### DON'T:
- ❌ Commit credentials to Git
- ❌ Share app-specific passwords
- ❌ Skip notarization for production releases
- ❌ Ignore certificate expiration warnings
- ❌ Distribute unsigned builds to users

## Additional Resources

- [Apple Notarization Docs](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder Code Signing](https://www.electron.build/code-signing)
- [electron-notarize](https://github.com/electron/notarize)
- [Apple Developer Forums](https://developer.apple.com/forums/tags/notarization)

## Support

For issues with certification:
1. Check this guide's troubleshooting section
2. Review Apple's system status
3. Check electron-builder GitHub issues
4. Contact Apple Developer Support if needed

---

Last updated: November 2024
Version: 1.6.6
