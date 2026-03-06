# Build Options for Onereach.ai

## Quick Start

### Build with Notarization (Recommended)
```bash
npm run build:signed
```
This creates a fully signed and notarized app that users can install without security warnings.

### Build without Notarization (When agreements pending)
```bash
npm run build:signed:skip-notarize
```
This creates a signed app that works but shows "unidentified developer" warning.

## Build Scripts

| Command | Description | Requirements |
|---------|-------------|--------------|
| `npm run package:mac` | Basic build (unsigned) | None |
| `npm run build:signed` | Signed + Notarized | Apple Developer account with active agreements |
| `npm run build:signed:skip-notarize` | Signed only | Code signing certificate |

## Using Command Line Options

### Skip notarization with flag:
```bash
./scripts/build-signed.sh --skip-notarize
```

### Skip notarization with environment variable:
```bash
export SKIP_NOTARIZE_ENV=true
./scripts/build-signed.sh
```

## Current Status

- ✅ **Code Signing**: Working (OneReach, Inc. certificate)
- ⏳ **Notarization**: Pending (waiting for Anton Peklo to accept Apple agreements)

## When Notarization is Fixed

Once the Apple Developer agreements are accepted, simply run:
```bash
npm run build:signed
```

The script will automatically detect that everything is configured and create a fully notarized build.

## Manual Notarization

If you have a signed build and want to notarize it later:
```bash
node scripts/notarize-manual.js
```

## Environment Setup

Required for notarization:
```bash
export APPLE_ID="robb@onereach.com"
export APPLE_APP_SPECIFIC_PASSWORD="tozd-zoeq-llgi-tste"
export APPLE_TEAM_ID="6KTEPA3LSD"
```

Or use the setup script:
```bash
source setup-notarization.sh 