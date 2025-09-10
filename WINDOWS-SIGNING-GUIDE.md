# Windows Code Signing Guide for Onereach.ai

## Overview

Windows has different signing requirements than macOS. While not strictly required, code signing is **highly recommended** to avoid security warnings.

## Windows vs macOS Signing Comparison

| Aspect | Windows | macOS |
|--------|---------|-------|
| **Required to Run** | ❌ No | ✅ Yes (Gatekeeper) |
| **Certificate Cost** | $200-700/year | $99/year |
| **Process Complexity** | Simple | Complex (sign + notarize) |
| **Time to Implement** | 1 hour | 1-2 days |
| **Unsigned App Behavior** | Runs with warnings | Won't run at all |
| **User Workaround** | Click "Run anyway" | Terminal command required |

## The Problem: Windows SmartScreen

Without code signing, users will see:

1. **Download Warning**: "Onereach.ai Setup.exe is not commonly downloaded and may be dangerous"
2. **SmartScreen Filter**: "Windows protected your PC - Windows Defender SmartScreen prevented an unrecognized app from starting"
3. **User Actions Required**:
   - Click "More info"
   - Click "Run anyway"
   - May need administrator approval

## Code Signing Benefits

✅ No SmartScreen warnings  
✅ Shows publisher name instead of "Unknown Publisher"  
✅ Builds trust with users  
✅ Required for enterprise deployments  
✅ Enables silent installations  

## Getting a Code Signing Certificate

### Option 1: Standard Code Signing Certificate ($200-500/year)
- **Providers**: DigiCert, Sectigo, GlobalSign
- **Validation**: Basic business verification
- **Time**: 1-3 business days

### Option 2: EV Code Signing Certificate ($300-700/year)
- **Benefits**: Immediate SmartScreen reputation
- **Hardware**: USB token or HSM required
- **Validation**: Extended verification
- **Time**: 1-2 weeks

### Recommended Provider
**Sectigo (formerly Comodo)**
- Good pricing
- Works well with electron-builder
- Good support

## Implementation

### 1. Update package.json

```json
{
  "build": {
    "win": {
      "icon": "assets/tray-icon.png",
      "target": [
        "nsis"
      ],
      "certificateFile": "./certs/windows-certificate.pfx",
      "certificatePassword": "${env.WIN_CERT_PASSWORD}",
      "signingHashAlgorithms": ["sha256"],
      "signDlls": true,
      "rfc3161TimeStampServer": "http://timestamp.sectigo.com"
    }
  }
}
```

### 2. Environment Setup

```bash
# Windows (Command Prompt)
set WIN_CERT_PASSWORD=your-certificate-password

# Windows (PowerShell)
$env:WIN_CERT_PASSWORD="your-certificate-password"

# Or use .env file (recommended)
WIN_CERT_PASSWORD=your-certificate-password
```

### 3. Build with Signing

```bash
npm run package:win
```

## Alternative: Self-Signed Certificate (Development Only)

For testing signing workflow:

```powershell
# Create self-signed certificate
New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Onereach AI Dev" -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My

# Export to PFX
$cert = Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert
Export-PfxCertificate -Cert $cert -FilePath ".\dev-cert.pfx" -Password (ConvertTo-SecureString -String "password" -AsPlainText -Force)
```

⚠️ **Note**: Self-signed certificates still trigger SmartScreen

## Unsigned App Workarounds

If you must distribute unsigned:

### 1. Installation Instructions
Include clear instructions:
```
Installation Steps:
1. Download Onereach.ai-Setup.exe
2. When you see "Windows protected your PC":
   - Click "More info"
   - Click "Run anyway"
3. If prompted for administrator permission, click "Yes"
```

### 2. Use ZIP Distribution
```json
{
  "build": {
    "win": {
      "target": [
        "nsis",
        "zip"  // Portable version
      ]
    }
  }
}
```

ZIP files are less likely to trigger warnings.

### 3. Corporate Deployment
For enterprise users:
- Provide MSI installer
- Use Group Policy to whitelist
- Distribute via internal servers

## Current Status

Currently, the Windows build is **NOT SIGNED**, which means:

1. ✅ App will run normally after installation
2. ⚠️ Users will see SmartScreen warnings
3. ⚠️ Some corporate environments may block it
4. ✅ No technical functionality issues

## Testing Signed Builds

1. **Verify Signature**:
   - Right-click .exe file
   - Properties → Digital Signatures tab
   - Should show your certificate

2. **Test SmartScreen**:
   - Download from web server (not local)
   - Run on clean Windows machine
   - Should install without warnings

## Cost-Benefit Analysis

### Do You Need Signing?

**YES if:**
- Distributing to general public
- Enterprise customers
- Building commercial product
- Want professional appearance

**MAYBE NOT if:**
- Internal company tool
- Technical users only
- Open source project
- Budget constraints

## Quick Start (No Signing)

For now, you can build and distribute unsigned:

```bash
# Build unsigned
npm run package:win

# Output
dist/Onereach.ai Setup 1.0.3.exe  # NSIS installer (will show warnings)
dist/Onereach.ai-1.0.3-win.zip   # Portable version (fewer warnings)
```

## Future Implementation

When ready to sign:

1. Purchase certificate (Sectigo recommended)
2. Add to package.json as shown above
3. Set environment variable
4. Build normally - electron-builder handles signing automatically

## Additional Resources

- [Electron Builder - Code Signing](https://www.electron.build/code-signing)
- [Microsoft - Authenticode](https://docs.microsoft.com/en-us/windows-hardware/drivers/install/authenticode)
- [Sectigo Code Signing](https://sectigo.com/ssl-certificates-tls/code-signing) 