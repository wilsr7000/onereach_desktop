# Notarization Environment Setup Guide

## Overview
This guide will help you set up your environment for code signing and notarization of the Onereach.ai app.

## Required Environment Variables

You need to set three environment variables:
- `APPLE_ID`: Your Apple Developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: The app-specific password you generated
- `APPLE_TEAM_ID`: Your Apple Developer Team ID

## Setting Up Environment Variables Securely

### Option 1: Using .env file (Recommended for Development)

1. Create a `.env.local` file in your project root:
```bash
touch .env.local
```

2. Add your credentials:
```
APPLE_ID="your-apple-id@example.com"
APPLE_APP_SPECIFIC_PASSWORD="4szR-ut.U-X3vs-aos9-DWXZ-ocNE-R7f7-Z_a2"
APPLE_TEAM_ID="your-team-id"
```

3. Add `.env.local` to `.gitignore` to prevent accidental commits:
```bash
echo ".env.local" >> .gitignore
```

4. Load the variables before building:
```bash
source .env.local
./scripts/build-signed.sh
```

### Option 2: Using Shell Profile (Permanent Setup)

1. Add to your `~/.zshrc` (or `~/.bash_profile`):
```bash
# Notarization credentials
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="4szR-ut.U-X3vs-aos9-DWXZ-ocNE-R7f7-Z_a2"
export APPLE_TEAM_ID="your-team-id"
```

2. Reload your shell:
```bash
source ~/.zshrc
```

### Option 3: One-time Session Variables

Set them temporarily for the current session:
```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="4szR-ut.U-X3vs-aos9-DWXZ-ocNE-R7f7-Z_a2"
export APPLE_TEAM_ID="your-team-id"
./scripts/build-signed.sh
```

## Finding Your Team ID

1. Sign in to [Apple Developer](https://developer.apple.com/account)
2. Click on "Membership" in the sidebar
3. Your Team ID is listed under "Team ID"

OR

If you have Xcode installed:
```bash
xcrun security find-identity -v -p codesigning | grep "Developer ID"
```
The Team ID is the 10-character string in parentheses.

## Security Best Practices

1. **Never commit credentials** to version control
2. **Use app-specific passwords** instead of your main Apple ID password
3. **Rotate passwords periodically**
4. **Use environment variables** or secure credential storage
5. **Add `.env*` to `.gitignore** if using .env files

## Building and Notarizing

Once your environment is set up:
```bash
./scripts/build-signed.sh
```

This will:
1. Clean previous builds
2. Build the app with code signing
3. Notarize the app with Apple
4. Create the final DMG and ZIP files

## Troubleshooting

### "APPLE_ID environment variable not set"
Make sure you've exported the variables or sourced your .env file.

### "Unable to find identity"
Ensure your Developer ID certificates are installed in Keychain Access.

### "Failed to notarize"
- Check your app-specific password is correct
- Ensure you have an active Apple Developer membership
- Verify your Team ID is correct

## Important Notes

- The app-specific password format should be: `xxxx-xxxx-xxxx-xxxx`
- This is NOT your Apple ID password
- Generate app-specific passwords at: https://appleid.apple.com/account/manage
- Notarization requires an active Apple Developer Program membership ($99/year) 